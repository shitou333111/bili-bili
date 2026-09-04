"use client";

/**
 * 展示画布（横屏 960x540 / 竖屏 540x960）—— 浏览器源客户端 + 三个信息模块渲染。
 *
 * 由直播姬「浏览器源」或 APP 内「编辑」模态框 iframe 加载（同源 http://127.0.0.1:<port>/display）。
 * 所有数据走 WebSocket：onopen 发 {type:"ready",mode}，onmessage 分发：
 *  - init(orientation/layouts/gifts/animeSample) → 常驻数据
 *  - event(payload) → entry / anime / gift 投放事件
 *  - layout / orientation → 布局与朝向的受控同步
 *
 * 编辑模式（?mode=edit / 模态框外层包了一层）：
 *  - 三个元素常驻并循环播放（礼物空则占位、入场提示 TestEntryLoop、入场动画 animeSample 或占位）
 *  - MovableBox 受控可拖动/缩放，onCommit → WS {type:"saveLayout"} → 主进程持久化 + 广播
 *
 * 层级：进场动画（anime）在最底层，礼物展示与进场提示在同一层（在其上）。
 *
 * 背景完全透明：直播姬「浏览器源」可一键抠背景叠加到直播画面（本容器无任何背景色）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DisplayEvent,
  type DisplayFlags,
  type DisplayGiftItem,
  type DisplayEntryPayload,
  type DisplayLayout,
  type LayoutElementId,
  type MovableRect,
  type ScreenOrientation,
  DEFAULT_DISPLAY_LAYOUT,
} from "@/lib/display/types";
import EntryBadge, { ENTRY_TOTAL_MS } from "./EntryBadge";
import GiftFlower from "./GiftFlower";
import VideoOverlay from "./VideoOverlay";
import MovableBox from "./MovableBox";

type AnimeEvent = Extract<DisplayEvent, { type: "anime" }>;

/** 编辑模式的入场用户（循环播放示例） */
const TEST_ENTRY_USER: DisplayEntryPayload = {
  uid: 1,
  uname: "测试用户",
  face: "",
  guardType: 3,
  medalLevel: 22,
};
/** 测试循环：一轮完整生命周期（聚合→停留→消散）结束后的间隔（重新挂载前） */
const LOOP_GAP_MS = 1500;

/** 画布设计坐标：横屏 960x540 / 竖屏 540x960（16:9 / 9:16）。
 *  渲染时按视口等比缩放填满：直播姬浏览器源设为 1920x1080 / 1080x1920 即全分辨率铺满，
 *  编辑 iframe 内视口=画布尺寸故 fit=1 不缩放。 */
export const CANVAS_SIZE: Record<ScreenOrientation, { w: number; h: number }> = {
  landscape: { w: 960, h: 540 },
  portrait: { w: 540, h: 960 },
};

/** 入场动画样本（编辑模式常驻预览用） */
interface AnimeSample {
  user: { uid: number; uname: string; face: string };
  videoSrc: string;
  startSec: number;
  endSec: number;
}

/** 服务端 → 客户端（画布）消息 */
type ServerMsg =
  | {
      type: "init";
      orientation: ScreenOrientation;
      layouts: DisplayLayout;
      gifts: DisplayGiftItem[];
      animeSample: AnimeSample | null;
      flags: DisplayFlags;
    }
  | { type: "event"; payload: DisplayEvent }
  | { type: "layout"; id: LayoutElementId; orientation: ScreenOrientation; rect: MovableRect }
  | { type: "orientation"; v: ScreenOrientation }
  | { type: "flags"; flags: DisplayFlags };

/**
 * 测试模式的常驻入场提示：每轮用递增的 key 重新挂载 EntryBadge。
 *
 * 循环不依赖 react-particle-effect-button 的 onComplete 来续接下一轮——该库在 onComplete
 * 后通过对 hidden 再翻转触发"消散"，后续状态翻转不稳定。改为按固定周期（一轮全周期 + 间隙）重挂载。
 * 组件常驻不卸载（粒子隐藏间隙内容仍占位，外层虚线框仍可拖动/缩放）。
 */
function TestEntryLoop() {
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setCycle((c) => c + 1), ENTRY_TOTAL_MS + LOOP_GAP_MS);
    return () => clearTimeout(t);
  }, [cycle]);
  return <EntryBadge key={cycle} user={TEST_ENTRY_USER} onDone={() => {}} />;
}

export default function DisplayCanvas() {
  const [currentEntry, setCurrentEntry] = useState<DisplayEntryPayload | null>(null);
  const [, setEntryQueue] = useState<DisplayEntryPayload[]>([]);
  const [gifts, setGifts] = useState<DisplayGiftItem[]>([]);
  const [anime, setAnime] = useState<AnimeEvent | null>(null);
  // 布局（受控：经主进程持久化 + WS 下发；gift/entry 各按朝向一套）
  const [layouts, setLayouts] = useState<DisplayLayout>(DEFAULT_DISPLAY_LAYOUT);
  // 进门动画样本（编辑模式常驻预览；未封装进 init 时为 null）
  const [animeSample, setAnimeSample] = useState<AnimeSample | null>(null);
  // 朝向：由 init/orientation 消息驱动
  const [orientation, setOrientation] = useState<ScreenOrientation>("landscape");
  // 编辑模式（?mode=edit）：三个元素常驻，可拖/可缩放
  const [isEdit, setIsEdit] = useState(false);
  // 各模块显示开关（主进程广播）：总开关关闭 → 浏览器源整体不渲染；各模块开关关闭 → 隐藏对应元素
  const [flags, setFlags] = useState<DisplayFlags>({
    master: true,
    entry: true,
    gift: true,
    anime: true,
  });
  // flags 的最新 ref（供 applyEvent 读取，避免闭包过期）
  const flagsRef = useRef(flags);
  useEffect(() => {
    flagsRef.current = flags;
  }, [flags]);

  // —— WS 客户端 ——
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // 用最新 ref 保存事件处理函数（applyEvent 在下方声明），避免 connect 依赖它导致 TDZ / 反复重建连接
  const applyEventRef = useRef<(p: DisplayEvent) => void>(() => {});

  // 服务端不可达判定：断线超过宽限仍连不上 → 判定本地服务/应用已关闭，浏览器源清空不再显示
  const [serverDown, setServerDown] = useState(false);
  const serverDownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载：检测编辑模式（?mode=edit）、记录卸载标记；卸载时关闭 WS 并清理重连定时器
  useEffect(() => {
    mountedRef.current = true;
    setIsEdit(/[?&]mode=edit/.test(window.location.search));
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (serverDownTimerRef.current) clearTimeout(serverDownTimerRef.current);
    };
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen = () => {
      // 重连成功：取消宽限定时器、恢复正常显示
      if (serverDownTimerRef.current) {
        clearTimeout(serverDownTimerRef.current);
        serverDownTimerRef.current = null;
      }
      setServerDown(false);
      ws.send(
        JSON.stringify({
          type: "ready",
          mode: isEdit ? "edit" : "source",
        }),
      );
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "init") {
        setOrientation(msg.orientation);
        setLayouts(msg.layouts);
        setGifts(msg.gifts);
        setAnimeSample(msg.animeSample);
        if (msg.flags) setFlags(msg.flags);
      } else if (msg.type === "event") {
        applyEventRef.current(msg.payload);
      } else if (msg.type === "layout") {
        setLayouts((l) => ({
          ...l,
          [msg.id]: { ...l[msg.id], [msg.orientation]: msg.rect },
        }));
      } else if (msg.type === "orientation") {
        setOrientation(msg.v);
      } else if (msg.type === "flags") {
        setFlags(msg.flags);
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
      // 断线退避重连：首次立即，之后 3s 起步指数退避
      const delay = reconnectRef.current ? 3000 : 0;
      reconnectRef.current = setTimeout(() => connect(), delay);

      // 服务端不可达判定：断线后宽限 5s，若仍连不上（本地服务/APP 已退出、浏览器源残留），
      // 判定服务端已不可达 → 清空画布。重连成功时（onopen）会取消该定时器并恢复显示。
      if (!serverDownTimerRef.current) {
        serverDownTimerRef.current = setTimeout(() => {
          serverDownTimerRef.current = null;
          setServerDown(true);
        }, 5000);
      }
    };
  }, [isEdit]);

  // 编辑判断在 DB state 外部驱动 connect：监听 isEdit 变更重建连接
  useEffect(() => {
    wsRef.current?.close();
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit]);

  const send = useCallback((json: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(json));
    }
  }, []);

  // 拖动完成：保存布局 → WS 发送 saveLayout，主进程持久化并广播回放
  const commitLayout = useCallback(
    (id: LayoutElementId) => (rect: MovableRect) => {
      send({ type: "saveLayout", id, orientation, rect });
    },
    [send, orientation],
  );

  // 动画队列
  const animeRef = useRef<AnimeEvent | null>(null);
  const animeQueueRef = useRef<AnimeEvent[]>([]);
  useEffect(() => {
    animeRef.current = anime;
  }, [anime]);
  const onAnimeEnd = useCallback(() => {
    const q = animeQueueRef.current;
    if (q.length) {
      const [next, ...rest] = q;
      animeQueueRef.current = rest;
      setAnime(next);
    } else {
      setAnime(null);
    }
  }, []);

  const onEntryDone = useCallback(() => {
    showingRef.current = false;
    setCurrentEntry(null);
    if (queueRef.current.length) {
      const next = queueRef.current.shift()!;
      queueRef.current = [...queueRef.current];
      setCurrentEntry(next);
      showingRef.current = true;
    }
  }, []);

  const currentEntryRef = useRef<DisplayEntryPayload | null>(null);
  useEffect(() => {
    currentEntryRef.current = currentEntry;
  }, [currentEntry]);

  // 队列 & 当前显示 ref（供 applyEvent 读避免闭包过期）
  const queueRef = useRef<DisplayEntryPayload[]>([]);
  const showingRef = useRef(false);

  const applyEvent = useCallback((p: DisplayEvent) => {
    if (p.type === "entry") {
      // 入场提示模块关闭：忽略事件（不排队）
      if (!flagsRef.current.entry) return;
      if (!showingRef.current && !currentEntryRef.current && queueRef.current.length === 0) {
        queueRef.current = [];
        showingRef.current = true;
        setCurrentEntry(p.user);
      } else {
        queueRef.current.push(p.user);
        setEntryQueue([...queueRef.current]);
      }
    } else if (p.type === "anime") {
      // 入场动画模块关闭：忽略事件
      if (!flagsRef.current.anime) return;
      const ev = p as AnimeEvent;
      if (!animeRef.current) {
        setAnime(ev);
      } else {
        animeQueueRef.current = [...animeQueueRef.current, ev];
      }
    } else if (p.type === "gift") {
      // 礼物展示模块关闭：忽略事件
      if (!flagsRef.current.gift) return;
      setGifts(p.gifts);
    }
  }, []);

  // 将最新事件处理器写入 ref（connect 通过 ref 调用，保证闭包不过期）
  useEffect(() => {
    applyEventRef.current = applyEvent;
  }, [applyEvent]);

  // 模块开关关闭 → 立即清空对应元素（含正在显示/排队中的），使浏览器源立刻隐藏；
  // 重新开启后由主进程重推（礼物 pushGiftUpdate / 事件驱动）恢复。
  useEffect(() => {
    if (!flags.entry) {
      showingRef.current = false;
      queueRef.current = [];
      setEntryQueue([]);
      setCurrentEntry(null);
    }
    if (!flags.anime) {
      animeQueueRef.current = [];
      setAnime(null);
    }
    if (!flags.gift) {
      setGifts([]);
    }
  }, [flags]);

  // 入场：超过最长停留仍未完成时兜底清空（防卡死）
  useEffect(() => {
    if (!currentEntry) return;
    const t = setTimeout(() => onEntryDone(), ENTRY_TOTAL_MS + 400);
    return () => clearTimeout(t);
  }, [currentEntry, onEntryDone]);

  const canvas = CANVAS_SIZE[orientation];
  // 视口自适应缩放：画布固定 960x540 / 540x960 设计坐标，按浏览器源/iframe 视口等比放大填满，
  // 使直播姬浏览器源设为 1920x1080（横屏）或 1080x1920（竖屏）时画布正好铺满全分辨率。
  // 编辑 iframe 内视口恰为画布尺寸 → fit=1 不缩放；仅浏览器源（非编辑）才 fit>1。
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const update = () => {
      const c = CANVAS_SIZE[orientation];
      setFit(Math.min(window.innerWidth / c.w, window.innerHeight / c.h));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [orientation]);

  // 入场动画视频画面实际尺寸（natural 像素，VideoOverlay loadedmetadata 后上报）；
  // 未加载完成/无视频时为 null → 元素退回画布尺寸（占位提示铺满画布）。
  const [animeVideoSize, setAnimeVideoSize] = useState<{ w: number; h: number } | null>(null);
  // VideoOverlay 上报视频画面尺寸 → 更新元素尺寸（包装成稳定回调，直接传 setState 类型不匹配）
  const onAnimeVideoSize = useCallback((w: number, h: number) => {
    setAnimeVideoSize({ w, h });
  }, []);

  // 编辑模式的常驻动画：优先 animeSample，否则占位（VideoOverlay 空 src 显示提示）
  const editAnime: AnimeEvent | null = animeSample
    ? {
        type: "anime",
        user: animeSample.user,
        videoSrc: animeSample.videoSrc,
        startSec: animeSample.startSec,
        endSec: animeSample.endSec,
      }
    : null;

  // 当前是否有真实视频内容（非编辑看事件、编辑看样本；无内容 → 占位/无 → 元素铺满画布）
  const hasAnimeContent = isEdit ? Boolean(editAnime) : Boolean(anime);

  // 入场动画元素尺寸：按视频宽高比在画布内等比缩放（object-contain 等效），使虚线边框 /
  // 拖拽缩放区域贴合视频画面而非整个画布；无视频/未加载完成时取画布尺寸（占位提示铺满）。
  const animeDisp = (() => {
    if (!hasAnimeContent || !animeVideoSize) return { w: canvas.w, h: canvas.h };
    const s = Math.min(canvas.w / animeVideoSize.w, canvas.h / animeVideoSize.h);
    return {
      w: Math.max(1, Math.round(animeVideoSize.w * s)),
      h: Math.max(1, Math.round(animeVideoSize.h * s)),
    };
  })();

  // 布局 rect 为默认 {0,0,1}（尚未自定义）时，将画面居中于画布（与视频 letterbox 视觉一致）；
  // 用户拖动/缩放后保存的是绝对坐标，走自定义位置。
  const animeRect: MovableRect = (() => {
    const base = layouts.anime[orientation];
    if (base.x === 0 && base.y === 0 && base.scale === 1) {
      return {
        x: Math.round((canvas.w - animeDisp.w) / 2),
        y: Math.round((canvas.h - animeDisp.h) / 2),
        scale: 1,
      };
    }
    return base;
  })();

  // 服务端不可达（APP/本地服务已退出）：浏览器源清空不渲染任何内容，
  // 避免关闭 APP 后直播姬仍残留上一帧画面；服务恢复重连成功后自动恢复显示。
  if (serverDown) {
    return null;
  }

  // 总开关关闭 → 浏览器源整体不渲染任何内容（保持 WS 连接，重新开启后立即恢复）
  if (!flags.master) {
    return null;
  }

  return (
    <div
      className="relative overflow-hidden bg-transparent select-none"
      style={{
        width: canvas.w,
        height: canvas.h,
        transform: `scale(${fit})`,
      }}
    >
      {/* 动画：正常模式播事件；编辑模式常驻播放样本；未配置视频时显示占位提示。
          与礼物/入场提示一样可拖动/缩放（仅编辑模式）；层级最底（zIndex=1），
          礼物(3)与入场提示(3)在其上，重叠时点击优先选中上层元素。
          元素尺寸贴合视频画面（按宽高比在画布内等比缩放），虚线边框只包视频画面。 */}
      {flags.anime && (isEdit || anime) && (
        <MovableBox
          id="anime"
          rect={animeRect}
          onCommit={commitLayout("anime")}
          editable={isEdit}
          zIndex={1}
        >
          <div className="relative" style={{ width: animeDisp.w, height: animeDisp.h }}>
            {!isEdit && anime && (
              <VideoOverlay anime={anime} onEnd={onAnimeEnd} onVideoSize={onAnimeVideoSize} />
            )}
            {isEdit && (
              <div className="absolute inset-0">
                {editAnime ? (
                  <VideoOverlay anime={editAnime} onEnd={() => {}} loop onVideoSize={onAnimeVideoSize} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center px-6 text-center">
                    <span className="rounded-xl bg-white/70 px-4 py-2 text-black/55 text-base font-semibold leading-relaxed shadow-sm">
                      入场动画（视频）将覆盖整个画布
                      <br />
                      尚未配置入场动画，前往「入场动画」卡片添加后可预览
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </MovableBox>
      )}

      {/* 礼物展示：编辑模式常驻显示（无礼物时也显示控件便于摆放）；否则有礼品才显示 */}
      {flags.gift && (isEdit || gifts.length > 0) && (
        <MovableBox
          id="gift"
          rect={layouts.gift[orientation]}
          onCommit={commitLayout("gift")}
          editable={isEdit}
        >
          <GiftFlower gifts={gifts} emptyPlaceholder={isEdit} />
        </MovableBox>
      )}

      {/* 入场提示：编辑模式常驻循环；否则当前有入场才显示 */}
      {flags.entry && (isEdit || currentEntry) && (
        <MovableBox
          id="entry"
          rect={layouts.entry[orientation]}
          onCommit={commitLayout("entry")}
          editable={isEdit}
        >
          {isEdit ? (
            <TestEntryLoop />
          ) : currentEntry ? (
            <EntryBadge key={currentEntry.uid} user={currentEntry} onDone={onEntryDone} />
          ) : null}
        </MovableBox>
      )}
    </div>
  );
}