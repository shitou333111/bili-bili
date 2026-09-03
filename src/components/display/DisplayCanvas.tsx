"use client";

/**
 * 展示画布（横屏 960x540 / 竖屏 540x960）—— 主窗口事件监听 + 三个信息模块渲染。
 *
 * 监听主窗口 emitTo 过来的 "display-event"：
 *  - entry   → 入场提示（粒子聚合 pill）
 *  - anime   → 高级用户自定义入场动画（本地视频）
 *  - gift    → 今日礼物清单（左上角逐个轮换）
 *  - test    → 测试模式开关：三个元素常驻并循环播放（供布局调整）
 *
 * 横竖屏切换：主窗口调用 set_display_orientation 调整窗口尺寸并 emit "display-orientation"，
 * 画布监听后切换容器尺寸；各元素位置横竖屏各存一套 localStorage（MovableBox 实现）。
 *
 * 层级：进场动画（anime）在最底层，礼物展示与进场提示在同一层（在其上）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DisplayEvent,
  type DisplayGiftItem,
  type DisplayEntryPayload,
  type ScreenOrientation,
} from "@/lib/display/types";
import EntryBadge, { ENTRY_TOTAL_MS } from "./EntryBadge";
import GiftFlower from "./GiftFlower";
import VideoOverlay from "./VideoOverlay";
import MovableBox, { type MovableRect } from "./MovableBox";

type AnimeEvent = Extract<DisplayEvent, { type: "anime" }>;

/** 测试模式的入场用户（循环播放） */
const TEST_ENTRY_USER: DisplayEntryPayload = {
  uid: 1,
  uname: "测试用户",
  face: "",
  guardType: 3,
  medalLevel: 22,
};
/** 测试循环：一轮完整生命周期（聚合→停留→消散）结束后的间隔（重新挂载前） */
const LOOP_GAP_MS = 1500;

/** 画布尺寸：横屏 960x540 / 竖屏 540x960（与 Rust 端窗口内尺寸一致） */
const CANVAS_SIZE: Record<ScreenOrientation, { w: number; h: number }> = {
  landscape: { w: 960, h: 540 },
  portrait: { w: 540, h: 960 },
};

/** 入场提示胶囊 badge 的估计宽度（px）：用于水平居中计算。badge 为自适应宽度（随昵称长度变化），
 *  默认位置按其典型宽度居中摆放，拖动调整结果会覆盖为精确位置。 */
const ENTRY_BADGE_WIDTH_EST = 160;

/** 各元素默认位置：横屏 / 竖屏各一套。首次切入某朝向且尚未保存过布局时使用（保持相对位置） */
const DEFAULT_RECT: Record<"gift" | "entry", Record<ScreenOrientation, MovableRect>> = {
  // 礼物展示：距离画布上/左边界均为 40px（横竖屏一致）
  gift: { landscape: { x: 40, y: 40, scale: 1 }, portrait: { x: 40, y: 40, scale: 1 } },
  // 入场提示：水平居中，距离上边界 60px（横竖屏一致）
  entry: {
    landscape: { x: (CANVAS_SIZE.landscape.w - ENTRY_BADGE_WIDTH_EST) / 2, y: 60, scale: 1 },
    portrait: { x: (CANVAS_SIZE.portrait.w - ENTRY_BADGE_WIDTH_EST) / 2, y: 60, scale: 1 },
  },
};

/**
 * 测试模式的循环入场提示：每轮用递增的 key 重新挂载 EntryBadge。
 *
 * 循环不依赖 react-particle-effect-button 的 onComplete 来续接下一轮——该库在 onComplete
 * 后通过对 hidden 再翻转触发"消散"，第二次及以后的状态翻转不稳定（聚合有时不再重放，导致
 * badge 卡在已显示状态、无粒子也不循环）。这里改为按固定周期（一轮全周期 + 间隙）重挂载：
 * 每轮 EntryBadge 从隐藏→聚合开始，粒子动画必然重新出现；badge 在下一轮重挂载时消失重来。
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
  const [entryQueue, setEntryQueue] = useState<DisplayEntryPayload[]>([]);
  const [gifts, setGifts] = useState<DisplayGiftItem[]>([]);
  const [anime, setAnime] = useState<AnimeEvent | null>(null);
  // 测试模式：三个元素常驻并循环播放
  const [testMode, setTestMode] = useState(false);
  // 画布朝向：横屏 / 竖屏（默认横屏，监听 "display-orientation" 事件切换）
  const [orientation, setOrientation] = useState<ScreenOrientation>("landscape");

  // 用 ref 保存队列，避免闭包过期导致的并发丢失
  const queueRef = useRef<DisplayEntryPayload[]>([]);
  const showingRef = useRef(false);

  // —— 入场动画（视频）排队 ——
  // 连续入场会连续触发 anime 事件，单一 anime state 相互覆盖会导致视频被强行打断。
  // 这里维护一个队列：当前视频播放期间新来的动画先进队，当前视频播完（onAnimeEnd）再顺次出队播放。
  const animeRef = useRef<AnimeEvent | null>(null);
  const animeQueueRef = useRef<AnimeEvent[]>([]);
  useEffect(() => {
    animeRef.current = anime;
  }, [anime]);
  // 当前动画播完：出队下一条，队空则释放画布
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

  // 展示完当前入场，出队下一条
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

  const applyEvent = useCallback((p: DisplayEvent) => {
    if (p.type === "entry") {
      if (!showingRef.current && !currentEntryRef.current && queueRef.current.length === 0) {
        queueRef.current = [];
        showingRef.current = true;
        setCurrentEntry(p.user);
      } else {
        queueRef.current.push(p.user);
        setEntryQueue([...queueRef.current]);
      }
    } else if (p.type === "anime") {
      const ev = p as AnimeEvent;
      // 无正在播放的动画 → 立即播放；否则进队，等当前播完再顺次播放
      if (!animeRef.current) {
        setAnime(ev);
      } else {
        animeQueueRef.current = [...animeQueueRef.current, ev];
      }
    } else if (p.type === "gift") {
      setGifts(p.gifts);
    } else if (p.type === "test") {
      setTestMode(p.active);
      // 进入测试模式：清空动画队列（测试动画是单条循环播放，队列无意义）
      animeQueueRef.current = [];
      // 退出测试模式：清除测试触发的元素，避免残留常驻（礼物/入场/动画一并消失）
      if (!p.active) {
        setAnime(null);
        setGifts([]);
        setCurrentEntry(null);
        setEntryQueue([]);
        queueRef.current = [];
        showingRef.current = false;
      }
    }
  }, []);

  // 订阅主窗口经 Tauri emitTo("display",...) 发来的展示事件（展示画布与主窗口同进程，
  // 走同一事件总线，无需跨进程 WS 通道）。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let unOrient: (() => void) | null = null;
    (async () => {
      try {
        const { listen, emitTo } = await import("@tauri-apps/api/event");
        unlisten = await listen("display-event", (event) => {
          if (cancelled) return;
          applyEvent(event.payload as DisplayEvent);
        });
        // 横竖屏切换：Rust 端调整窗口尺寸后 emit，这里切换画布容器尺寸（各元素
        // 位置由 MovableBox 按朝向读取各自已保存的 localStorage 布局）
        unOrient = await listen<string>("display-orientation", (e) => {
          if (cancelled) return;
          setOrientation(e.payload === "portrait" ? "portrait" : "landscape");
        });
        // 监听已就绪：通知主面板可安全推送初始礼物清单（避免窗口刚创建、页面尚未
        // 加载完时 emit 被丢弃，导致"已有礼物记录却一直不显示"）
        await emitTo("main", "display-ready");
      } catch {
        /* 非 Tauri（如浏览器预览）下 Tauri 事件 API 不可用，静默跳过：展示画布仅用于 Windows 客户端 */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      unOrient?.();
    };
  }, [applyEvent]);

  // 入场：超过最长停留仍未完成时兜底清空（防卡死）
  useEffect(() => {
    if (!currentEntry) return;
    const t = setTimeout(() => onEntryDone(), ENTRY_TOTAL_MS + 400);
    return () => clearTimeout(t);
  }, [currentEntry, onEntryDone]);

  const canvas = CANVAS_SIZE[orientation];
  const giftDefault = DEFAULT_RECT.gift[orientation];
  const entryDefault = DEFAULT_RECT.entry[orientation];

  return (
    <div
      className="relative overflow-hidden bg-[#B7EBA4] select-none"
      style={{ width: canvas.w, height: canvas.h }}
    >
      {/* 测试模式提示文字（居中，仅测试时显示）：说明可拖动/缩放及各元素用途 */}
      {testMode && (
        <div className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
          <div className="max-w-[70%] text-center text-black/70 text-lg font-semibold leading-relaxed bg-white/50 px-6 py-4 rounded-lg">
            直播间投屏面板包括三部分：礼物展示、入场提示、入场动画。
            <br />
            礼物展示和入场提示，点击可以缩放和移动。入场动画全屏播放，无法调整。
            <br />
            注意，是在投屏面板窗口操作，不是对直播姬里的画面操作，那只是投屏。
            <br />
            其他相关的参数需要在APP页面内设置。
            <br />
            <br />
            在直播姬中添加本窗口：
            <br />
            “素材”➡️“窗口捕捉”➡️“选择窗口”➡️“高级设置”➡️“背景扣除”➡️“确定”
            <br />
            以上是一次性设置，只在第一次使用时需要。

          </div>
        </div>
      )}

      {/* 高级用户自定义入场动画：最底层。onEnd 触发出队 → 连续入场视频顺次播放 */}
      {anime && (
        <VideoOverlay anime={anime} onEnd={onAnimeEnd} loop={testMode} />
      )}

      {/* 礼物展示：可拖动/等比缩放（仅测试模式显示虚线边框并可编辑；正常模式无边框展示） */}
      {(testMode || gifts.length > 0) && (
        <MovableBox
          id="gift"
          orientation={orientation}
          defaultRect={giftDefault}
          editable={testMode}
        >
          <GiftFlower gifts={gifts} />
        </MovableBox>
      )}

      {/* 入场提示：可拖动/等比缩放（仅测试模式可编辑）。
          测试模式：常驻 + 循环播放，边框始终可见以便选中拖动/缩放；
          正常模式：元素播放完移除时一并消失，无边框。 */}
      {(testMode || currentEntry) && (
        <MovableBox
          id="entry"
          orientation={orientation}
          defaultRect={entryDefault}
          editable={testMode}
        >
          {testMode ? (
            <TestEntryLoop />
          ) : currentEntry ? (
            <EntryBadge key={currentEntry.uid} user={currentEntry} onDone={onEntryDone} />
          ) : null}
        </MovableBox>
      )}
    </div>
  );
}
