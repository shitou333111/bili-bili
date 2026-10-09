"use client";

/**
 * 展示模块 —— 主播页"展示"tab 配置面板。
 *
 * 无独立总开关：是否运行（本地浏览器源服务 + 弹幕监听）由子模块派生——任一画布显示模块
 * （收到的礼物展示 / 礼物特效 / 入场提示 / 入场动画）或盲盒盈亏·弹幕查询开启即运行；
 * 全部关闭即停止监听。画布是否渲染内容（派生 master）只看 4 个画布显示模块。
 * 各信息模块各有开关：①入场提示（粒子 pill）②收到的礼物展示（今日礼物轮换）③入场动画（高级用户自定义动画）。
 * 附加"弹幕互动"模块：向直播间按间隔循环发送自定义弹幕（不参与派生，自己独立工作）。
 * 所有配置持久化到 <dataDir>/uid_<mid>/display-config.json（按账号分开）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getPlatform, isWindowsDisplaySupported } from "@/lib/platform";
import {
  DEFAULT_DISPLAY_CONFIG,
  type AnimeOpacity,
  type DisplayConfig,
  type EntryAnimeConfig,
  type EntryCooldownOption,
  type EntryParticleMode,
  type ScreenOrientation,
} from "@/lib/display/types";
import {
  displayMaster,
  displayNeedsService,
  loadDisplayConfig,
  saveDisplayConfig,
  resolveAnimeVideo,
} from "@/lib/display/config";
import {
  addBililiveSource,
  detectBililiveSource,
  ensureBililiveSourceFps,
} from "@/lib/display/bililive-source";
import {
  probeVideoDuration,
  secToTime,
  timeToSec,
} from "@/lib/display/video";
import {
  displayDanmaku,
  getTodayQualifyingGifts,
  type DanmuDebugEvent,
  type DisplayServiceStatus,
} from "@/lib/display/danmaku";
import { sendDanmakuWithRetry } from "@/lib/barrage";
import { dataFetch } from "@/lib/client-fetch";
import { getEffectiveBlindBoxConfig, getAllBlindBoxInfo } from "@/lib/stats-client";
import { type ToastKind } from "@/lib/toast";
import DisplayEditModal from "./DisplayEditModal";

interface GuardItem {
  mid: number;
  uname: string;
  face: string;
  /** 大航海等级：1=总督 2=提督 3=舰长 */
  guardLevel: number;
}

interface Props {
  mid: number;
  /** 本机是否持有该账号的 B站 登录凭证（服务器账号无凭证，无法监听自家直播间） */
  isLocalAccount?: boolean;
  showToast?: (msg: string, kind?: ToastKind) => void;
}

// 统一的开关行组件
// 让 async 操作带上超时，避免 Tauri IPC / HTTP 在极端情况下永不返回导致按钮永久卡在
// "禁用/加载中"（enabling/fansLoading 卡 true）。
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时(>${Math.round(ms / 1000)}s)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface RoomInfo {
  roomId: number;
  uname: string;
  /** 开播状态：0=未开播 1=直播中 2=轮播中 */
  liveStatus: number;
}

/**
 * 解析主播 UID → 直播间信息（房间号 + 主播昵称 + 开播状态）。
 * 走 platform.fetchBilibiliJson（@tauri-apps/plugin-http，跟随系统代理）；
 * 不用 liveStream.getStreamerInfoByUid（其走 Rust fetch_json，系统代理下常报
 * "error sending request"）。解析失败直接抛错，绝不回退用 uid 当房间号。
 */
export async function resolveRoomInfo(mid: number): Promise<RoomInfo> {
  const platform = await getPlatform();
  const data = await platform.fetchBilibiliJson<any>({
    url: `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${mid}`,
    live: true,
  });
  if (data?.code !== 0) {
    throw new Error(data?.message || data?.msg || "解析直播间失败");
  }
  const info = data?.data?.[String(mid)];
  const roomId = Number(info?.room_id);
  if (!roomId) throw new Error("未找到该账号对应的直播间（该账号不是开播主播或 UID 无效）");
  return {
    roomId,
    uname: info?.uname || "",
    // 开播状态必须用 live_status（1=直播中）；room_status 仅表示直播间是否存在，恒为 1
    liveStatus: Number(info?.live_status) || 0,
  };
}

/** 把多行弹幕文本按换行拆成弹幕列表：一个或连续多个换行 = 一条弹幕，去空行。 */
function buildDanmakuList(text: string): string[] {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ==================== 统一样式基元 ====================

/** 主按钮（深色） */
const btnPrimary =
  "inline-flex items-center justify-center rounded-lg bg-[#1f1c17] px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-[#2c2822] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";
/** 次按钮（白色磨砂底，适配各色卡片背景，无边框） */
const btnGhost =
  "inline-flex items-center justify-center rounded-lg bg-white/80 px-3 py-1.5 text-xs font-medium text-black/70 shadow-sm transition hover:bg-white active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";
/** 输入/下拉基础样式（填充底色、无边框） */
const inputBase =
  "rounded-lg bg-white/70 px-2.5 py-1.5 text-sm text-black/80 outline-none transition focus:bg-white focus:ring-2 focus:ring-[#1f1c17]/15";
/** 扁平输入框（纵向更矮，用于与其他控件同行的数值输入） */
const inputFlat =
  "rounded-lg bg-white/70 px-2.5 py-0.5 text-sm text-black/80 outline-none transition focus:bg-white focus:ring-2 focus:ring-[#1f1c17]/15";

/** 隐藏 number 输入框的上下箭头（WebKit/Blink 的 spin button） */
const noSpin =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none";

/** iOS 风格开关（on 状态颜色可随卡片背景适配） */
function Switch({
  checked,
  disabled,
  onToggle,
  size = "md",
  onColor = "bg-[#34c759]",
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  size?: "sm" | "md";
  onColor?: string;
}) {
  const w = size === "sm" ? "w-[40px] h-[22px]" : "w-[46px] h-[26px]";
  const thumb = size === "sm" ? "w-[18px] h-[18px] top-[2px]" : "w-[22px] h-[22px] top-[2px]";
  const on = size === "sm" ? "left-[20px]" : "left-[22px]";
  const off = "left-[2px]";
  return (
    <button
      onClick={() => onToggle(!checked)}
      disabled={disabled}
      className={`relative shrink-0 ${w} rounded-full transition-colors duration-300 ${
        checked ? onColor : "bg-black/15"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute ${thumb} rounded-full bg-white shadow transition-all duration-300 ${
          checked ? on : off
        }`}
      />
    </button>
  );
}

/** 横屏 / 竖屏 分段选择（主流 segmented 样式）：选中项深底高亮，附朝向图标与尺寸标注，一目了然 */
function OrientationSegmented({
  value,
  onChange,
  disabled,
}: {
  value: ScreenOrientation;
  onChange: (v: ScreenOrientation) => void;
  disabled?: boolean;
}) {
  const opts: Array<{ key: ScreenOrientation; label: string; sub: string }> = [
    { key: "landscape", label: "横屏", sub: "16:9" },
    { key: "portrait", label: "竖屏", sub: "9:16" },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-white/60 p-1 shadow-sm">
      {opts.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.key)}
            className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-1.5 transition ${
              active
                ? "bg-[#1f1c17] text-white shadow"
                : "text-black/55 hover:bg-white/80"
            } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            {/* 朝向图标：表示画面是横的还是竖的 */}
            <span
              className="inline-block shrink-0"
              style={{
                width: o.key === "landscape" ? 14 : 9,
                height: o.key === "landscape" ? 9 : 14,
                borderRadius: 2,
                border: `1.5px solid ${active ? "#fff" : "currentColor"}`,
                opacity: 0.9,
              }}
            />
            <span className="text-xs font-medium leading-none">{o.label}</span>
            <span
              className={`text-[10px] leading-none ${active ? "text-white/60" : "text-black/35"}`}
            >
              {o.sub}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 自定义复选框 */
function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label
      onClick={(e) => {
        e.preventDefault();
        onChange(!checked);
      }}
      className="flex items-center gap-1.5 cursor-pointer select-none group"
    >
      <span
        className={`relative flex items-center justify-center w-4 h-4 rounded-[5px] border transition ${
          checked
            ? "bg-[#1f1c17] border-[#1f1c17]"
            : "bg-white border-black/25 group-hover:border-black/45"
        }`}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.5l2.5 2.5 4.5-5" />
          </svg>
        )}
      </span>
      <span className="text-xs text-black/70">{label}</span>
    </label>
  );
}

/** 模块卡片（靠背景色区分；边框颜色适配背景、比背景更深一档） */
function Card({
  children,
  bg = "bg-white",
  border = "border-black/10",
  className = "",
}: {
  children: ReactNode;
  bg?: string;
  border?: string;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl ${bg} ${border} border p-4 shadow-[0_1px_2px_rgba(31,28,23,0.04)] ${className}`}
    >
      {children}
    </section>
  );
}

/** 卡片标题栏：位于卡片上方、居中，标题 + 功能开关（开关颜色随卡片背景适配） */
function ModuleTitle({
  title,
  onColor = "bg-[#34c759]",
  checked,
  disabled,
  onToggle,
}: {
  title: string;
  onColor?: string;
  checked?: boolean;
  disabled?: boolean;
  onToggle?: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2.5 mb-2.5 select-none">
      <h3 className="text-sm font-bold text-black/75">{title}</h3>
      {onToggle && (
        <Switch checked={!!checked} disabled={disabled} onToggle={onToggle} onColor={onColor} />
      )}
    </div>
  );
}

// ==================== 页面 ====================

export default function DisplayPanel({ mid, isLocalAccount = true, showToast }: Props) {
  const [config, setConfig] = useState<DisplayConfig>(DEFAULT_DISPLAY_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<DisplayServiceStatus>({ state: "idle" });
  const [enabling, setEnabling] = useState(false);
  const [isNative, setIsNative] = useState(false);
  // 高级用户名单：大航海舰长列表（主播的舰长，供挑选）
  const [guards, setGuards] = useState<GuardItem[]>([]);
  const [guardsLoading, setGuardsLoading] = useState(false);
  const [selectedGuardMid, setSelectedGuardMid] = useState<string>("");
  const [qualityGifts, setQualityGifts] = useState<{ icon: string; name: string; count: number }[]>([]);
  const [showAllQualityGifts, setShowAllQualityGifts] = useState(false);
  // 弹幕调试事件（页面实时展示）
  const [debugEvents, setDebugEvents] = useState<DanmuDebugEvent[]>(() =>
    displayDanmaku.getDebugEvents(),
  );
  // 主播昵称 + 开播状态（用于状态提示：已连接 <昵称>的直播间 · 绿/黄/红 状态点）
  const [anchorName, setAnchorName] = useState("");
  const [liveStatus, setLiveStatus] = useState(0);
  // 弹幕调试日志卡片默认折叠
  const [debugOpen, setDebugOpen] = useState(false);
  // 盲盒盈亏 · 弹幕查询：可查询盲盒名称列表（admin"盲盒盈亏配置"指定，供使用说明展示）
  const [profitBoxNames, setProfitBoxNames] = useState<string[]>([]);

  // 加载可查询盲盒名称列表：admin 配置的盲盒盈亏查询范围（profitIds）
  useEffect(() => {
    (async () => {
      try {
        const platform = await getPlatform();
        const cfg = await getEffectiveBlindBoxConfig(platform);
        const info = await getAllBlindBoxInfo(platform);
        const ids = cfg.profitIds ?? [];
        setProfitBoxNames(ids.map((id) => info[id]?.blind_box_name || `盲盒_${id}`));
      } catch {
        setProfitBoxNames([]);
      }
    })();
  }, []);

  // 入场动画 · 按 UID 添加
  const [uidInput, setUidInput] = useState("");
  const [uidQuerying, setUidQuerying] = useState(false);
  const [uidQueryError, setUidQueryError] = useState<string | null>(null);

  // 弹幕互动 · 发送状态与定时器
  const [danmakuStatus, setDanmakuStatus] = useState("");
  // 弹幕发送间隔输入框的"编辑态"文本：输入时自由编辑，失焦时钳制到 >=60 再保存
  const [intervalText, setIntervalText] = useState(String(DEFAULT_DISPLAY_CONFIG.danmaku.intervalSec));
  useEffect(() => {
    setIntervalText(String(config.danmaku.intervalSec));
  }, [config.danmaku.intervalSec]);
  const danmakuTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const danmakuIdxRef = useRef(0);
  const danmakuRoomRef = useRef<number | null>(null);
  const danmakuBusyRef = useRef(false);
  const prevDanmakuEnabled = useRef(false);
  // 运行中的定时器直接读取该 ref，编辑弹幕文本时不打断已运行的定时器
  const danmakuTextRef = useRef(config.danmaku.text);
  useEffect(() => {
    danmakuTextRef.current = config.danmaku.text;
  }, [config.danmaku.text]);

  const toast = useCallback(
    (msg: string, kind?: ToastKind) => {
      showToast?.(msg, kind);
    },
    [showToast],
  );

  // 初始化：读配置 + 判平台 + 订阅监听状态
  useEffect(() => {
    let alive = true;
    (async () => {
      const platform = await getPlatform();
      if (!alive) return;
      // 展示投屏仅 Windows 桌面 Tauri 可用（Web/Android/iOS 等一律禁用）
      setIsNative(isWindowsDisplaySupported(platform));
      const cfg = await loadDisplayConfig(mid);
      if (alive) {
        setConfig(cfg);
        setLoaded(true);
      }
    })();
    const unsub = displayDanmaku.subscribe((s) => setStatus(s));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // 打开软件时自动检测并显示连接状态：若打开软件时已有模块需要弹幕监听（auto-start 已在启动时
  // 自动启动浏览器源服务并恢复弹幕监听），就解析直播间信息（主播昵称 + 开播状态）展示到状态提示中，
  // 无需再次手动开启；顺带兜底恢复监听与推送礼物（start 对同一房间幂等，不会重复连接）。
  // 仅记录首次加载时的派生状态：之后手动开关由 toggleModule / toggleBlindBoxQuery 处理，不会重复自动检测。
  const initialNeedRef = useRef<boolean | null>(null);
  const autoDetectedRef = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (initialNeedRef.current === null) {
      initialNeedRef.current = displayNeedsService(config);
    }
    if (!initialNeedRef.current) return; // 打开软件时监听未运行，无需自动检测
    if (!isLocalAccount || !isNative || !mid) return;
    if (autoDetectedRef.current) return;
    autoDetectedRef.current = true;
    (async () => {
      try {
        const info = await withTimeout(resolveRoomInfo(mid), 6000, "解析直播间");
        setAnchorName(info.uname);
        setLiveStatus(info.liveStatus);
        displayDanmaku.start(info.roomId, mid);
        void displayDanmaku.pushGiftUpdate(mid);
      } catch (e: any) {
        console.warn("[展示]启动自动检测直播间失败", e?.message || e);
      }
    })();
  }, [loaded, config, isLocalAccount, isNative, mid]);

  // 浏览器源架构下不存在"画布窗口"：画布/编辑 iframe 的朝向、布局、调试日志都经本地
  // HTTP 服务器的 WS 处理（danmaku.ts 内 handleServerMessage / setOrientation），
  // 不再需要 display-window-closed / display-ready / display-console 这类 Tauri 事件监听。

  // 订阅弹幕调试事件，页面实时展示（仅保留最近 20 条）
  useEffect(() => {
    const unsub = displayDanmaku.subscribeDebug((e) =>
      setDebugEvents((prev) => [...prev.slice(-19), e]),
    );
    return unsub;
  }, []);

  const update = useCallback(
    async (patch: Partial<DisplayConfig>): Promise<DisplayConfig> => {
      // 以主进程侧最新配置（含浏览器源/编辑 iframe 经 saveLayout 刚保存的布局）为基准合并，
      // 否则用本页缓存的旧 config 整体覆盖磁盘会把 iframe 里刚拖动的元素位置一并冲掉
      // （表现为切换横/竖屏后布局恢复默认值）。
      const latest = await loadDisplayConfig(mid);
      const next = { ...latest, ...patch };
      setConfig(next);
      await saveDisplayConfig(mid, next);
      return next;
    },
    [mid],
  );

  // 横幅 · 输入框"编辑态"文本：输入过程中不实时同步到画布，光标脱离输入框（失焦）才保存并广播，限 30 字
  const [bannerEditText, setBannerEditText] = useState(DEFAULT_DISPLAY_CONFIG.banner.text);
  // 中文输入法（IME）合成态：以输入法 composition 事件为准（主流做法，不按按键猜测）。
  // 合成中的拼音只是临时文本——不截断、不计入字数；确认（空格/Enter 上屏）后才计数并限长。
  const imeComposingRef = useRef(false);
  const imeConfirmedLenRef = useRef(0); // 合成开始瞬间"已确认文本"的长度
  useEffect(() => {
    setBannerEditText(config.banner.text);
  }, [config.banner.text]);
  const commitBannerText = useCallback(() => {
    const text = bannerEditText.slice(0, 30);
    setBannerEditText(text);
    if (text === config.banner.text) return;
    void update({ banner: { ...config.banner, text } }).then(() =>
      displayDanmaku.broadcastBannerText(text),
    );
  }, [bannerEditText, config.banner, update]);

  // 布局编辑模态框开关（声明在监听服务同步之前：停止监听时需一并关闭）
  const [editOpen, setEditOpen] = useState(false);

  /**
   * 按派生状态启动/停止弹幕监听服务：只要还有子模块需要监听（4 个画布显示模块任一开启，
   * 或盲盒盈亏·弹幕查询开启）就确保"本地浏览器源服务 + 直播间弹幕监听"在运行；全部关闭则停止。
   * 幂等：已在运行时不重复解析房间号 / 启服务。停止时不断开浏览器源服务本身——直播姬里已添加
   * 的源保持加载，仅画布空白，重新开启立即恢复，无需重新添加源。
   */
  const syncService = useCallback(
    async (next: DisplayConfig) => {
      if (!displayNeedsService(next)) {
        displayDanmaku.stop();
        setEditOpen(false);
        return;
      }
      if (enabling) return;
      if (displayDanmaku.getServerPort() && displayDanmaku.isActive()) return; // 已在运行
      if (!isLocalAccount) {
        toast("该功能需要登录凭证，服务器账号无法使用", "error");
        return;
      }
      if (!isNative || !mid) return;
      setEnabling(true);
      try {
        // 解析直播间信息：房间号 + 主播昵称 + 开播状态（失败直接报错，绝不回退用 uid 当房间号）
        const info = await withTimeout(resolveRoomInfo(mid), 6000, "解析房间号");
        setAnchorName(info.uname);
        setLiveStatus(info.liveStatus);
        // 启动本地浏览器源 HTTP+WS 服务（Rust 端绑定 127.0.0.1:25100 起端口）。
        // 直播软件（如直播姬）添加浏览器源 http://127.0.0.1:<port>/display 透明叠加。
        await withTimeout(displayDanmaku.startServer(), 10000, "启动浏览器源服务");
        await displayDanmaku.start(info.roomId, mid);
        // 立即推送一次今日礼物清单：已有礼物记录时无需等下一次送礼即可显示；
        // 浏览器源就绪后还会因 ready 消息再做一次 broadcastInit 兜底推送。
        void displayDanmaku.pushGiftUpdate(mid);
        // 启动期间用户可能已把所有开关关掉 → 补一次判定，避免监听"偷偷"继续运行
        if (!displayNeedsService(await loadDisplayConfig(mid))) displayDanmaku.stop();
      } catch (e: any) {
        console.error("[展示]启动弹幕监听失败", e);
        toast(`启动弹幕监听失败：${e?.message || e}`, "error");
      } finally {
        setEnabling(false);
      }
    },
    [enabling, isLocalAccount, isNative, mid, toast],
  );

  // 模块开关变化：先按派生状态同步监听服务（开启任一模块即自动启动监听），再持久化后广播 flags，
  // 让浏览器源即时显隐对应元素（无需重连）；重新开启礼物展示时主动重推今日礼物清单
  const toggleModule = useCallback(
    async (patch: Partial<DisplayConfig>) => {
      const next = await update(patch);
      await syncService(next);
      void displayDanmaku.broadcastFlags();
      if (patch.gift && mid) void displayDanmaku.pushGiftUpdate(mid);
    },
    [update, syncService, mid],
  );

  // 盲盒盈亏 · 弹幕查询开关：不显示在画布上、不参与派生 master，但它的查询依赖弹幕监听，
  // 因此单独触发监听服务的启停（打开它即可单独让监听跑起来，关闭它也不影响画布模块）
  const toggleBlindBoxQuery = useCallback(
    async (v: boolean) => {
      const next = await update({ blindBoxQuery: { ...config.blindBoxQuery, enabled: v } });
      await syncService(next);
    },
    [update, syncService, config.blindBoxQuery],
  );

  // 横屏 / 竖屏切换：持久化朝向并广播给已连接的浏览器源画布（canvas 收到 orientation
  // 消息后切换 1080x1920 / 1920x1080）。浏览器源随时可再加，无需先开监听服务。
  const serverPort = displayDanmaku.getServerPort();

  // 浏览器源地址：优先用实际端口；未启动时给默认 25100（Rust 端 25100 起端口）
  const browserSourceUrl = serverPort
    ? `http://127.0.0.1:${serverPort}/display`
    : "http://127.0.0.1:25100/display";

  // 一键复制浏览器源地址
  const copySourceUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(browserSourceUrl);
      toast("浏览器源地址已复制");
    } catch {
      toast("复制失败，请手动选择复制", "error");
    }
  }, [browserSourceUrl, toast]);

  // 一键添加直播姬浏览器源：按 URL 检测添加状态（红=未添加，绿=已添加），手动步骤默认折叠
  const [sourceAdded, setSourceAdded] = useState(false);
  const [sourceAdding, setSourceAdding] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  // 检测直播姬是否已添加本浏览器源（按 URL 判断，不看名称）；检测失败按未添加处理（红色按钮可点）
  useEffect(() => {
    if (!isNative) return;
    let alive = true;
    detectBililiveSource(mid)
      .then((added) => {
        if (alive) setSourceAdded(added);
        // 静默回填旧源缺失的帧率键（fps:60/fps_custom，缺键=直播姬默认 30fps 驱动
        // rAF → 粒子帧基动画变慢脱钩）：函数内部自查直播姬运行中/无需写入则跳过
        if (added) ensureBililiveSourceFps(mid).catch(() => {});
      })
      .catch(() => {
        if (alive) setSourceAdded(false);
      });
    return () => {
      alive = false;
    };
  }, [isNative, mid]);

  // 一键添加浏览器源：先检测直播姬是否在运行（运行中退出时会把内存配置写回、覆盖新写入的
  // 浏览器源，故必须先关闭直播姬再操作）；未运行则横屏、竖屏场景分别添加（都已有则跳过），
  // 写直播姬场景配置（置于目标场景所有元素最上层），下次启动直播姬生效
  const handleAddSource = useCallback(async () => {
    if (sourceAdding || sourceAdded) return;
    setSourceAdding(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (await invoke<boolean>("is_bililive_running")) {
        toast("直播姬软件正在运行，需要关闭直播姬再操作");
        return;
      }
      await addBililiveSource(mid, browserSourceUrl);
      setSourceAdded(true);
      toast("浏览器源已添加");
    } catch (e: any) {
      toast(`一键添加失败：${e?.message || e}，可展开下方手动步骤添加`, "error");
    } finally {
      setSourceAdding(false);
    }
  }, [sourceAdding, sourceAdded, browserSourceUrl, toast, mid]);

  const handleOrientation = useCallback(
    async (v: boolean) => {
      const orientation: ScreenOrientation = v ? "portrait" : "landscape";
      await update({ screenOrientation: orientation });
      try {
        await displayDanmaku.setOrientation(orientation, mid);
      } catch (e: any) {
        toast(`切换朝向失败：${e?.message || e}`, "error");
      }
    },
    [update, toast, mid],
  );

  // 加载大航海舰长列表（主播的舰长，官方 guardTab/topList 接口）
  const loadGuards = useCallback(async () => {
    if (guardsLoading) return;
    setGuardsLoading(true);
    try {
      await withTimeout(
        (async () => {
          const platform = await getPlatform();
          const state = await platform.getSessionState();
          const session = (state.sessions || []).find((s: any) => s.sid === state.currentSid);
          const cookie: string[] = [];
          if (session) {
            if (session.biliCookies?.length) cookie.push(...session.biliCookies);
            if (session.biliSessdata && !cookie.some((c) => c.startsWith("SESSDATA="))) {
              cookie.push(`SESSDATA=${session.biliSessdata}`);
            }
          }
          // 需要直播间 roomid（主播 UID → 房间号，失败直接报错）
          const roomId = (await resolveRoomInfo(mid)).roomId;
          const all: GuardItem[] = [];
          // 前三名舰长在接口的独立 top3 字段（list 里不含他们），需先并入，避免漏人
          const collect = (gs: any[]) => {
            for (const g of gs || []) {
              const gid = Number(g.uid);
              if (gid && !all.some((a) => a.mid === gid)) {
                all.push({
                  mid: gid,
                  uname: g.username || "",
                  face: g.face || "",
                  guardLevel: Number(g.guard_level) || 0,
                });
              }
            }
          };
          const PAGE_SIZE = 30; // 该接口单页最大 30
          for (let page = 1; page <= 30; page++) {
            const data = await platform.fetchBilibiliJson<any>({
              url: `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=${roomId}&ruid=${mid}&page=${page}&page_size=${PAGE_SIZE}`,
              cookie: cookie.join("; "),
              live: true,
            });
            if (data?.code !== 0) {
              throw new Error(data?.message || data?.msg || "获取舰长列表失败");
            }
            if (page === 1) collect(data?.data?.top3); // 前三名舰长单独字段
            const list = data?.data?.list || [];
            if (!list.length) break;
            collect(list);
          }
          setGuards(all);
          if (!all.length) toast("未获取到舰长列表，请确认直播间与登录状态", "error");
        })(),
        12000,
        "获取舰长列表",
      );
    } catch (e: any) {
      console.error("[展示]获取舰长列表失败", e);
      toast(`获取舰长列表失败：${e?.message || e}`, "error");
    } finally {
      setGuardsLoading(false);
    }
  }, [mid, toast, guardsLoading]);

  // 添加一名舰长到入场动画名单
  const addAnimeGuard = useCallback(() => {
    const g = guards.find((x) => String(x.mid) === selectedGuardMid);
    if (!g) {
      toast("请先选择一位舰长");
      return;
    }
    setConfig((c) => {
      if (c.animeList.some((a) => a.uid === g.mid)) {
        toast("该舰长已在名单中");
        return c;
      }
      const next = {
        ...c,
        animeList: [
          ...c.animeList,
          {
            uid: g.mid,
            uname: g.uname,
            face: g.face,
            videoLandscape: "",
            videoPortrait: "",
            enabled: true,
            landscapeStartSec: 0,
            landscapeEndSec: 0,
            portraitStartSec: 0,
            portraitEndSec: 0,
          },
        ],
      };
      saveDisplayConfig(mid, next);
      return next;
    });
  }, [guards, selectedGuardMid, toast, mid]);

  // 按 UID 添加：查询昵称与头像（走统一 dataFetch → /api/tools/user-info：Web 走服务器、Tauri 走本地直连），
  // 查询成功后自动加入入场动画名单
  const addUidByInput = useCallback(async () => {
    const uid = Number(uidInput.trim());
    if (!uid || uid <= 0) {
      setUidQueryError("请输入有效的 UID");
      return;
    }
    if (config.animeList.some((a) => a.uid === uid)) {
      setUidQueryError("该用户已在名单中");
      return;
    }
    setUidQuerying(true);
    setUidQueryError(null);
    try {
      const res = await withTimeout(dataFetch(`/api/tools/user-info?uids=${uid}`), 8000, "查询用户");
      const json = (await res.json()) as {
        code: number;
        message?: string;
        data?: Record<string, { name: string; face: string }>;
      };
      const info = json?.data?.[String(uid)];
      if (!info) {
        setUidQueryError(json?.message || "查询失败，请检查 UID 是否正确");
        return;
      }
      setConfig((c) => {
        const next = {
          ...c,
          animeList: [
            ...c.animeList,
            { uid, uname: info.name, face: info.face || "", videoLandscape: "", videoPortrait: "", enabled: true, landscapeStartSec: 0, landscapeEndSec: 0, portraitStartSec: 0, portraitEndSec: 0 },
          ],
        };
        saveDisplayConfig(mid, next);
        return next;
      });
      setUidInput("");
      toast(`已添加 ${info.name}`);
    } catch (e: any) {
      setUidQueryError(e?.message || "查询失败，请检查网络");
    } finally {
      setUidQuerying(false);
    }
  }, [uidInput, config.animeList, toast, mid]);

  const updateAnime = useCallback((idx: number, patch: Partial<EntryAnimeConfig>) => {
    setConfig((c) => {
      const list = c.animeList.map((a, i) => (i === idx ? { ...a, ...patch } : a));
      const next = { ...c, animeList: list };
      saveDisplayConfig(mid, next);
      return next;
    });
  }, [mid]);

  const removeAnime = useCallback((idx: number) => {
    setConfig((c) => {
      const list = c.animeList.filter((_, i) => i !== idx);
      const next = { ...c, animeList: list };
      saveDisplayConfig(mid, next);
      return next;
    });
  }, [mid]);

  const pickVideo = useCallback(
    async (idx: number, orient: "landscape" | "portrait") => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = (await invoke("pick_video_file")) as string | null;
        if (!path) return;
        // 重新选视频时清空之前设置的播放片段（恢复到整段）
        updateAnime(
          idx,
          orient === "portrait"
            ? { videoPortrait: path, portraitStartSec: 0, portraitEndSec: 0 }
            : { videoLandscape: path, landscapeStartSec: 0, landscapeEndSec: 0 },
        );
        // 仅提示、不在此处理选段：>30s 时轻提示，之后用户点击视频文件名自行设置播放时间段
        if (isNative) {
          probeVideoDuration(path, displayDanmaku.getDisplayBaseUrl())
            .then((d) => {
              if (d > 30) {
                toast("当前选择视频时长超过30秒，之后点击视频文件名，可以设置播放时间段");
              }
            })
            .catch(() => {});
        }
      } catch (e: any) {
        toast(`选择视频失败：${e?.message || e}`, "error");
      }
    },
    [updateAnime, toast, isNative],
  );

  // —— 播放片段设置模态框 ——
  // 点击"视频文件名"触发：短视频（<=30s）无反应；长视频（>30s）弹出模态框，可输入起止时间，
  // 或使用快捷选项（整段 / 前30秒 / 后30秒）。
  const [segmentModal, setSegmentModal] = useState<{
    idx: number;
    orient: "landscape" | "portrait";
    path: string;
    total: number;
    busy: boolean;
    startText: string;
    endText: string;
  } | null>(null);
  const [segmentErr, setSegmentErr] = useState("");

  // 点击视频文件名：解析当前朝向实际使用的视频路径，探测时长；>30s 才打开设置模态框
  const openSegmentModal = useCallback(
    async (idx: number, orient: "landscape" | "portrait", a: EntryAnimeConfig) => {
      if (!isNative) return;
      const path = resolveAnimeVideo(a, orient);
      if (!path) return; // 未配置视频：文件名为"未选择"，点击无反应
      try {
        const total = await probeVideoDuration(path, displayDanmaku.getDisplayBaseUrl());
        if (total <= 30) return; // 短视频：点击无反应
        const seg =
          orient === "portrait"
            ? { startSec: a.portraitStartSec, endSec: a.portraitEndSec }
            : { startSec: a.landscapeStartSec, endSec: a.landscapeEndSec };
        // 起止时间文本 = 实际将播放的片段（与 VideoOverlay 播放逻辑一致），避免打开时为空：
        //  - 已配置片段：开始为 0 显示 "00:00"（0 是明确时刻，不显示空）；结束为 0（播到末尾）显示总时长
        //  - 未配置片段（0,0）：>30s 默认播放最后30秒 → 预填该片段起止时刻；<=30s 为整段（此分支不会打开）
        const segUnset = seg.startSec === 0 && seg.endSec === 0;
        const effStart = segUnset ? (total > 30 ? total - 30 : 0) : seg.startSec;
        const effEnd = segUnset ? total : seg.endSec > 0 ? seg.endSec : total;
        setSegmentErr("");
        setSegmentModal({
          idx,
          orient,
          path,
          total,
          busy: false,
          startText: secToTime(effStart),
          endText: secToTime(effEnd),
        });
      } catch {
        /* 探测失败：无反应 */
      }
    },
    [isNative],
  );

  const applySegment = useCallback(
    (startSec: number, endSec: number) => {
      if (!segmentModal) return;
      const { idx, orient } = segmentModal;
      updateAnime(
        idx,
        orient === "portrait"
          ? { portraitStartSec: startSec, portraitEndSec: endSec }
          : { landscapeStartSec: startSec, landscapeEndSec: endSec },
      );
      setSegmentModal(null);
    },
    [segmentModal, updateAnime],
  );

  const handleSegmentSave = useCallback(() => {
    if (!segmentModal) return;
    const s = timeToSec(segmentModal.startText);
    let e = timeToSec(segmentModal.endText);
    if (e === null || e === 0) e = 0; // 结束未填或非法 → 整段处理在下方判定
    // 结束为空表示"播到末尾"；这种语义与整段区分不明显，统一要求填结束时间：
    // 若结束时间为空则视为不合法，提示填写
    if (s === null || e === 0) {
      setSegmentErr("请填写开始时间和结束时间（均需大于 0）");
      return;
    }
    if (s >= e) {
      setSegmentErr("开始时间必须早于结束时间");
      return;
    }
    if (e > segmentModal.total) {
      setSegmentErr(`结束时间不能超过总时长 ${secToTime(segmentModal.total)}`);
      return;
    }
    applySegment(s, e);
  }, [segmentModal, applySegment]);

  const refreshGifts = useCallback(async () => {
    if (!mid) return;
    const items = await getTodayQualifyingGifts(mid);
    setQualityGifts(items.map((g) => ({ icon: g.img, name: g.giftName, count: g.count })));
  }, [mid]);

  // 修改礼物阈值：保存配置 + 刷新达标礼物预览 + 即时重发到画布（让修改立刻生效）
  const updateThreshold = useCallback(
    async (v: number) => {
      await update({ giftPriceThreshold: v });
      if (mid) {
        refreshGifts();
        void displayDanmaku.pushGiftUpdate(mid);
      }
    },
    [update, mid, refreshGifts],
  );

  useEffect(() => {
    if (loaded && mid) refreshGifts();
  }, [loaded, mid, refreshGifts]);

  // 已连接时每 60s 刷新一次开播状态（未开播=黄点 / 直播中=绿点），断线重连也会重新刷新
  useEffect(() => {
    if (status.state !== "connected" || !mid) return;
    let alive = true;
    const refresh = async () => {
      try {
        const info = await withTimeout(resolveRoomInfo(mid), 6000, "刷新开播状态");
        if (alive) {
          setAnchorName(info.uname);
          setLiveStatus(info.liveStatus);
        }
      } catch {
        /* 刷新失败保留旧值 */
      }
    };
    refresh();
    const t = setInterval(refresh, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [status.state, mid]);

  // 弹幕互动：开启后按间隔循环发送自定义弹幕（文本存 ref，编辑不打断已运行的定时器；
  // 修改间隔会重建定时器；刚开启时立即发送第一条）
  useEffect(() => {
    if (danmakuTimerRef.current) {
      clearInterval(danmakuTimerRef.current);
      danmakuTimerRef.current = null;
    }
    const enabled = config.danmaku.enabled;
    const justEnabled = enabled && !prevDanmakuEnabled.current;
    prevDanmakuEnabled.current = enabled;
    danmakuIdxRef.current = 0;
    danmakuRoomRef.current = null;
    setDanmakuStatus("");
    if (!enabled) return;
    if (!isLocalAccount) {
      setDanmakuStatus("该功能需要登录凭证，服务器账号无法使用");
      return;
    }
    if (!mid) {
      setDanmakuStatus("缺少主播 UID，无法发送弹幕");
      return;
    }
    let alive = true;
    const send = async () => {
      if (!alive || danmakuBusyRef.current) return;
      danmakuBusyRef.current = true;
      try {
        const lines = buildDanmakuList(danmakuTextRef.current);
        if (!lines.length) {
          setDanmakuStatus("请先填写弹幕内容");
          return;
        }
        // 每次发送前先检查直播间是否开播，只有开播状态（直播中/轮播中）才发送弹幕
        try {
          const info = await withTimeout(resolveRoomInfo(mid), 6000, "解析直播间");
          danmakuRoomRef.current = info.roomId;
          if (info.liveStatus === 0) {
            if (alive) setDanmakuStatus("直播间未开播，等待开播后自动发送");
            return;
          }
        } catch (e: any) {
          if (alive) setDanmakuStatus(`解析直播间失败：${e?.message || e}`);
          return;
        }
        const line = lines[danmakuIdxRef.current % lines.length];
        danmakuIdxRef.current += 1;
        setDanmakuStatus(`正在发送：${line}`);
        const res = await sendDanmakuWithRetry(
          danmakuRoomRef.current,
          line,
          (_code, _msg, waitMs) => {
            // 首次发送失败（多为撞上 B站 频率冷却）时提示正在自动重试
            if (alive) setDanmakuStatus(`发送失败，${Math.round(waitMs / 1000)}秒后自动重试：${line}`);
          },
        );
        if (!alive) return;
        if (res.code === 0) {
          setDanmakuStatus(`已发送：${line}`);
        } else {
          setDanmakuStatus(`发送失败：${res.message || res.msg || "未知错误"}`);
        }
      } finally {
        danmakuBusyRef.current = false;
      }
    };
    const intervalMs = Math.max(1, Math.floor(config.danmaku.intervalSec)) * 1000;
    danmakuTimerRef.current = setInterval(() => void send(), intervalMs);
    // 刚开启时立即发送第一条，无需等待一个间隔
    if (justEnabled) void send();
    return () => {
      alive = false;
      if (danmakuTimerRef.current) {
        clearInterval(danmakuTimerRef.current);
        danmakuTimerRef.current = null;
      }
    };
  }, [config.danmaku.enabled, config.danmaku.intervalSec, isLocalAccount, mid]);

  // 状态提示 + 前置状态点：连接正常且直播中=绿，连接正常但未开播=黄，连接异常=红；
  // 连接成功时附带开播状态描述（直播中 / 轮播中 / 未开播）
  let dotClass = "bg-gray-400";
  let statusText = "";
  if (status.state === "connected") {
    const liveTxt = liveStatus === 1 ? "直播中" : liveStatus === 2 ? "轮播中" : "未开播";
    dotClass = liveStatus === 1 ? "bg-green-500" : "bg-yellow-400";
    statusText = `已连接 ${anchorName || `房间 ${status.roomId}`}的直播间 · ${liveTxt}`;
  } else if (status.state === "connecting") {
    statusText = "连接中…";
  } else if (status.state === "error") {
    dotClass = "bg-red-500";
    statusText = `连接异常：${status.message}（自动重连中）`;
  }

  if (!loaded) return null;

  return (
    <div className="space-y-8 w-full min-w-0">
      {/* 面板说明卡片（无独立总开关：由下方各子模块开关自动决定是否运行） */}
      <section>
        <div className="flex items-center justify-center mb-2.5 select-none">
          <div className="flex items-center gap-2.5">
            <h3 className="text-sm font-bold text-black/75">直播间投屏面板</h3>
          </div>
        </div>
        <Card bg="bg-slate-300" border="border-slate-400">
          {/* 状态行在卡片最上方：连接状态 → 安装浏览器源 → 朝向/布局，逻辑递进 */}
          {statusText && (
            <div className="flex items-center gap-2.5 rounded-xl bg-white/60 px-3 py-2 text-xs text-black/70">
              <span className={`inline-block w-3 h-3 rounded-full ${dotClass}`} />
              <span className="truncate">{statusText}</span>
            </div>
          )}
          {isNative ? (
            <div className="mt-2.5 rounded-xl bg-white/60 px-3 py-2.5">
              {/* 一键添加行与下方手动添加引导同属浏览器源添加功能，共用一张卡 */}
              <div className="flex items-center gap-3">
                <p className="min-w-0 flex-1 text-xs text-black/45 leading-relaxed">
                  使用前提是在直播姬中添加本浏览器源
                </p>
                <button
                  onClick={() => void handleAddSource()}
                  disabled={sourceAdding || sourceAdded}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium text-white shadow-sm transition active:scale-[0.97]"
                  style={{
                    background: sourceAdded ? "#22c55e" : "#ef4444",
                    cursor: sourceAdding || sourceAdded ? "default" : "pointer",
                  }}
                >
                  {sourceAdding ? "添加中…" : sourceAdded ? "浏览器源已经添加" : "一键添加浏览器源"}
                </button>
              </div>
              {/* 手动添加引导：默认折叠（含浏览器源地址与手动步骤） */}
              <button
                onClick={() => setManualOpen((v) => !v)}
                className="mt-2 flex w-full items-center gap-1.5 text-left text-[11px] font-medium text-black/60"
                style={{ cursor: "pointer" }}
              >
                <span>{manualOpen ? "▼" : "▶"}</span>
                <span>如果一键添加失败，请按照下方指示手动添加</span>
              </button>
              {manualOpen && (
                <>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="shrink-0 text-[11px] font-medium text-black/60">浏览器源地址</span>
                    <code className="min-w-0 flex-1 select-all truncate text-[11px] text-black/80">
                      {browserSourceUrl}
                    </code>
                    <button
                      onClick={() => void copySourceUrl()}
                      className="shrink-0 rounded-md bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition hover:bg-white/80 active:scale-[0.97]"
                    >
                      复制
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-black/45">
                    使用步骤（横屏）：直播姬➡️素材➡️浏览器➡️上面链接粘贴到URL输入框➡️高级设置➡️宽度1920 高度1080➡️确认
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-black/45">
                    竖屏：步骤一致，仅改变 宽度1080 高度1920。
                    <br />
                    想同时保留横竖屏，按两种尺寸各添加一次即可，之后可方便切换。
                  </p>
                </>
              )}
            </div>
          ) : (
            <p className="mt-2.5 text-xs text-black/45 leading-relaxed">仅 Windows 客户端支持</p>
          )}
          <div className="mt-2.5 flex items-center justify-center gap-10">
            {/* 左：画面朝向（横屏/竖屏）分段选择，位置固定 */}
            <OrientationSegmented
              value={config.screenOrientation}
              disabled={enabling || !isNative}
              onChange={(v) => void handleOrientation(v === "portrait")}
            />
            {/* 右：编辑布局。需有画布显示模块开启（派生 master）且服务已启动才能用模态框 iframe 加载编辑页 */}
            <button
              onClick={() => setEditOpen(true)}
              disabled={!displayMaster(config) || enabling || !serverPort}
              title="在 APP 内打开布局编辑框：可切换横/竖屏，分别调整各模块的位置和大小"
              className="inline-flex w-[170px] items-center justify-center whitespace-nowrap rounded-lg bg-white text-slate-700 shadow-sm px-4 py-1.5 text-xs font-medium transition active:scale-[0.98] hover:bg-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              编辑布局
            </button>
          </div>
        </Card>
      </section>

      {/* 布局编辑模态框：内嵌展示编辑页（?mode=edit，同源 iframe），可切换横/竖屏 */}
      {editOpen && serverPort && (
        <DisplayEditModal
          port={serverPort}
          orientation={config.screenOrientation}
          onOrientationChange={(v) => void handleOrientation(v === "portrait")}
          onClose={() => setEditOpen(false)}
        />
      )}

      {/* 模块1：收到的礼物展示 */}
      <section>
        <ModuleTitle
          title="收到的礼物展示"
          onColor="bg-amber-500"
          checked={config.gift}
          onToggle={(v) => void toggleModule({ gift: v })}
        />
        <Card bg="bg-amber-200" border="border-amber-400">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-black/45 leading-relaxed">今日收到的礼物，滚动显示，不区分谁送的</p>
            {/* 展示条方向：横条（礼物从右到左滚）/ 竖条（礼物从下到上滚） */}
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-full bg-white/50 p-0.5 shadow-sm"
              role="radiogroup"
              aria-label="礼物展示条方向"
            >
              {(
                [
                  ["horizontal", "横条"],
                  ["vertical", "竖条"],
                ] as Array<["horizontal" | "vertical", string]>
              ).map(([key, label]) => {
                const active = config.giftBarOrientation === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      void update({ giftBarOrientation: key }).then((next) =>
                        displayDanmaku.broadcastGiftBarOrientation(next.giftBarOrientation),
                      )
                    }
                    className={`rounded-full px-2.5 py-0.5 text-xs leading-none transition cursor-pointer ${
                      active
                        ? "bg-amber-600 text-white shadow"
                        : "text-black/55 hover:bg-white/80"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-black/60">
            <span className="shrink-0">礼物单价大于</span>
            <input
              type="number"
              min={0}
              value={config.giftPriceThreshold}
              onChange={(e) =>
                updateThreshold(Math.max(0, Number(e.target.value) || 0))
              }
              className={`${inputFlat} w-16`}
            />
            <span className="shrink-0 text-black/35">电池的礼物才显示（0=全部）</span>
          </div>
          {qualityGifts.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {(showAllQualityGifts ? qualityGifts : qualityGifts.slice(0, 10)).map((g) => (
                <div
                  key={g.name}
                  className="flex items-center gap-1 rounded-md bg-white/60 px-1.5 py-0.5 text-[11px] leading-none text-black/70"
                >
                  <img src={g.icon} alt="" className="h-4 w-4 rounded-sm object-cover" />
                  <span>{g.name}</span>
                  <span className="font-bold">×{g.count}</span>
                </div>
              ))}
              {qualityGifts.length > 10 && (
                <button
                  type="button"
                  onClick={() => setShowAllQualityGifts((v) => !v)}
                  aria-label={showAllQualityGifts ? "收起礼物列表" : "展开更多礼物"}
                  className="flex cursor-pointer items-center gap-0.5 rounded-md bg-white/60 px-1.5 py-0.5 text-[11px] leading-none text-black/50 hover:bg-white/90"
                >
                  {/* 折叠图标：默认朝下表示还有更多，展开后朝上表示可收起 */}
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ transform: showAllQualityGifts ? "rotate(180deg)" : undefined }}
                  >
                    <polyline points="3 6 8 11 13 6" />
                  </svg>
                  <span>{showAllQualityGifts ? "收起" : `+${qualityGifts.length - 10}`}</span>
                </button>
              )}
            </div>
          )}
        </Card>
      </section>

      {/* 模块：礼物特效（收到带专属动画的礼物时在画布播放） */}
      <section>
        <ModuleTitle
          title="礼物特效"
          onColor="bg-pink-500"
          checked={config.giftEffect.enabled}
          onToggle={(v) =>
            void toggleModule({ giftEffect: { ...config.giftEffect, enabled: v } })
          }
        />
        <Card bg="bg-pink-200" border="border-pink-400">
          <p className="text-xs text-black/45 leading-relaxed">
            收到带专属动画的礼物时，在画布上播放该礼物的特效动画
          </p>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-black/60">
            <span className="shrink-0">开启/关闭礼物关键字特效</span>
            <Switch
              size="sm"
              onColor="bg-pink-500"
              checked={config.giftEffect.keyword}
              onToggle={(v) => update({ giftEffect: { ...config.giftEffect, keyword: v } })}
            />
          </div>
          <p className="mt-2 text-xs text-black/35 leading-relaxed">
            开启后，弹幕内容如果是某个礼物名称，就会在播放该礼物特效
          </p>
        </Card>
      </section>

      {/* 模块2：入场提示 */}
      <section>
        <ModuleTitle
          title="入场提示"
          onColor="bg-blue-500"
          checked={config.entry}
          onToggle={(v) => void toggleModule({ entry: v })}
        />
        <Card bg="bg-blue-200" border="border-blue-400">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-black/45 leading-relaxed">用户进入直播间时，粒子聚合成头像+昵称提示</p>
            {/* 粒子聚散方式（样式对齐「收到的礼物展示」卡片的方向切换）：
                中心聚散 = 自研四面八方聚散；左右聚散 = 原有的库实现。默认中心聚散。 */}
            <div
              className="flex shrink-0 items-center gap-0.5 rounded-full bg-white/50 p-0.5 shadow-sm"
              role="radiogroup"
              aria-label="粒子聚散方式"
            >
              {(
                [
                  ["center", "中心聚散"],
                  ["lr", "左右聚散"],
                ] as Array<[EntryParticleMode, string]>
              ).map(([key, label]) => {
                const active = config.entryParticleMode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      void update({ entryParticleMode: key }).then((next) =>
                        displayDanmaku.broadcastEntryParticleMode(next.entryParticleMode),
                      )
                    }
                    className={`rounded-full px-2.5 py-0.5 text-xs leading-none transition cursor-pointer ${
                      active
                        ? "bg-blue-600 text-white shadow"
                        : "text-black/55 hover:bg-white/80"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-black/60">
            <Check
              label="舰长"
              checked={config.entryFilter.jianzhang}
              onChange={(v) =>
                update({ entryFilter: { ...config.entryFilter, jianzhang: v } })
              }
            />
            <Check
              label="提督"
              checked={config.entryFilter.tidu}
              onChange={(v) =>
                update({ entryFilter: { ...config.entryFilter, tidu: v } })
              }
            />
            <Check
              label="总督"
              checked={config.entryFilter.zongdu}
              onChange={(v) =>
                update({ entryFilter: { ...config.entryFilter, zongdu: v } })
              }
            />
            {/* 加号：居中于航海筛选与灯牌筛选两组之间，表示两者叠加（AND）关系 */}
            <span className="mx-auto shrink-0 text-black/40" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 12 12" fill="none">
                <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span className="shrink-0">粉丝灯牌等级 ≥</span>
            <input
              type="number"
              min={0}
              value={config.entryFilter.medalLevelThreshold}
              onChange={(e) =>
                update({
                  entryFilter: {
                    ...config.entryFilter,
                    medalLevelThreshold: Math.max(0, Number(e.target.value) || 0),
                  },
                })
              }
              className={`${inputFlat} noSpin w-16`}
            />
          </div>
          {/* 入场冷却：同一用户距上次触发不足间隔则不再触发（防止频繁进出反复播放） */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="text-xs text-black/45 shrink-0">触发间隔</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="入场冷却时长">
              {(
                [
                  ["bilibili", "B站默认"],
                  ["30min", "半小时"],
                  ["1h", "1小时"],
                  ["10h", "10小时"],
                ] as Array<[EntryCooldownOption, string]>
              ).map(([key, label]) => {
                const active = config.entryCooldown === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update({ entryCooldown: key })}
                    className={`rounded-full px-2.5 py-0.5 text-xs transition cursor-pointer ${
                      active
                        ? "bg-blue-600 text-white shadow"
                        : "bg-white/70 text-black/55 hover:bg-white"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
      </section>

      {/* 模块3：入场动画 */}
      <section>
        <ModuleTitle
          title="入场动画"
          onColor="bg-violet-500"
          checked={config.anime}
          onToggle={(v) => void toggleModule({ anime: v })}
        />
        <Card bg="bg-violet-200" border="border-violet-400">
          <p className="text-xs text-black/45 leading-relaxed">为用户配置本地视频作为入场动画（播放入场动画时没有入场提示）</p>
          {/* 从舰长列表选择 */}
          <div className="mt-3 flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <select
                value={selectedGuardMid}
                onChange={(e) => setSelectedGuardMid(e.target.value)}
                className={`${inputBase} display-select w-full pr-8`}
              >
                <option value="">选择一位舰长…</option>
                {guards.map((g) => (
                  <option key={g.mid} value={String(g.mid)}>
                    {g.uname}
                    {g.guardLevel === 1 ? "（总督）" : g.guardLevel === 2 ? "（提督）" : "（舰长）"}
                  </option>
                ))}
              </select>
              <svg
                viewBox="0 0 16 16"
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 6l4 4 4-4" />
              </svg>
            </div>
            <button className={btnGhost} onClick={loadGuards} disabled={guardsLoading}>
              {guardsLoading ? "加载中…" : guards.length ? "刷新名单" : "加载舰长名单"}
            </button>
            <button className={btnPrimary} onClick={addAnimeGuard} disabled={!selectedGuardMid}>
              加入名单
            </button>
          </div>

          {/* 按 UID 添加 */}
          <div className="mt-2 flex items-center gap-2">
            <span className="shrink-0 text-xs text-black/50">或按 UID 添加：</span>
            <input
              type="number"
              value={uidInput}
              onChange={(e) => {
                setUidInput(e.target.value);
                setUidQueryError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addUidByInput();
              }}
              placeholder="输入用户 UID"
              className={`${inputBase} ${noSpin} w-52`}
            />
            <button className={btnPrimary} onClick={() => void addUidByInput()} disabled={uidQuerying}>
              {uidQuerying ? "添加中…" : "添加"}
            </button>
          </div>
          {uidQueryError && (
            <div className="mt-2 text-xs text-red-500">{uidQueryError}</div>
          )}

          {/* 名单：固定高度，超出 5 条可滚动，避免卡片整体被撑得很高 */}
          {config.animeList.length > 0 && (
            <ul className="mt-2 space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
              {config.animeList.map((a, i) => {
                const hasVid = !!(a.videoLandscape || a.videoPortrait);
                const landName = a.videoLandscape
                  ? a.videoLandscape.split(/[/\\]/).pop()
                  : a.videoPortrait
                  ? "共用"
                  : "未选择";
                const portName = a.videoPortrait
                  ? a.videoPortrait.split(/[/\\]/).pop()
                  : a.videoLandscape
                  ? "共用"
                  : "未选择";
                return (
                  <li
                    key={a.uid}
                    className="flex items-center gap-1.5 p-1.5 rounded-lg bg-white/60"
                  >
                    {/* 头像 + 昵称（固定宽度保证跨用户纵向对齐，过长只显示前面） */}
                    <img
                      src={a.face || undefined}
                      alt=""
                      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                      className="w-8 h-8 rounded-full object-cover shrink-0 bg-black/5"
                    />
                    <span
                      className="w-[64px] shrink-0 truncate text-center text-xs font-medium text-black/80"
                      title={a.uname}
                    >
                      {a.uname}
                    </span>

                    {/* 横屏 / 竖屏 两个独立 badge（更分明，各自平稳对齐） */}
                    <div className="flex items-center gap-1 min-w-0 flex-1">
                      {/* 横屏 badge */}
                      <div className="flex items-center gap-0.5 rounded-md border border-violet-300 bg-white/80 px-1 py-0.5 min-w-0 flex-1">
                        <span className="shrink-0 flex h-3.5 w-3.5 items-center justify-center rounded bg-violet-200 text-[9px] font-bold text-violet-600">
                          横
                        </span>
                        <button
                          type="button"
                          disabled={!hasVid}
                          onClick={() => void openSegmentModal(i, "landscape", a)}
                          title={hasVid ? "点击设置播放时间段" : undefined}
                          className={`truncate min-w-0 flex-1 text-left text-[11px] leading-none transition ${
                            a.videoLandscape
                              ? "text-black/60 hover:text-violet-600 hover:underline underline-offset-2"
                              : "text-black/40 italic"
                          } ${hasVid ? "cursor-pointer" : "cursor-default"}`}
                        >
                          {landName}
                        </button>
                        <button
                          className="inline-flex shrink-0 items-center justify-center rounded-md bg-white/80 px-1 py-1.5 text-[10px] font-medium leading-none text-black/70 shadow-sm transition hover:bg-white active:scale-[0.98]"
                          onClick={() => pickVideo(i, "landscape")}
                        >
                          选视频
                        </button>
                      </div>
                      {/* 竖屏 badge */}
                      <div className="flex items-center gap-0.5 rounded-md border border-amber-300 bg-white/80 px-1 py-0.5 min-w-0 flex-1">
                        <span className="shrink-0 flex h-3.5 w-3.5 items-center justify-center rounded bg-amber-200 text-[9px] font-bold text-amber-700">
                          竖
                        </span>
                        <button
                          type="button"
                          disabled={!hasVid}
                          onClick={() => void openSegmentModal(i, "portrait", a)}
                          title={hasVid ? "点击设置播放时间段" : undefined}
                          className={`truncate min-w-0 flex-1 text-left text-[11px] leading-none transition ${
                            a.videoPortrait
                              ? "text-black/60 hover:text-amber-600 hover:underline underline-offset-2"
                              : "text-black/40 italic"
                          } ${hasVid ? "cursor-pointer" : "cursor-default"}`}
                        >
                          {portName}
                        </button>
                        <button
                          className="inline-flex shrink-0 items-center justify-center rounded-md bg-white/80 px-1 py-1.5 text-[10px] font-medium leading-none text-black/70 shadow-sm transition hover:bg-white active:scale-[0.98]"
                          onClick={() => pickVideo(i, "portrait")}
                        >
                          选视频
                        </button>
                      </div>
                    </div>

                    {/* 启用开关 + 删除 */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Switch
                        size="sm"
                        onColor="bg-violet-500"
                        checked={a.enabled}
                        onToggle={(v) => updateAnime(i, { enabled: v })}
                      />
                      <button
                        onClick={() => removeAnime(i)}
                        className="shrink-0 w-5 h-5 rounded-full bg-black/[0.06] text-black/50 transition hover:bg-red-500 hover:text-white text-base leading-none"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {config.animeList.length === 0 && (
            <div className="mt-2 text-xs text-black/40">
              暂无名单。可从上方舰长列表选择，或按 UID 添加用户，再为其选择视频动画。
            </div>
          )}
          {/* 动画冷却：与入场提示同款选项，但独立判定、独立记录（完全对照入场提示逻辑） */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="text-xs text-black/45 shrink-0">触发间隔</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="入场动画冷却时长">
              {(
                [
                  ["bilibili", "B站默认"],
                  ["30min", "半小时"],
                  ["1h", "1小时"],
                  ["10h", "10小时"],
                ] as Array<[EntryCooldownOption, string]>
              ).map(([key, label]) => {
                const active = config.animeCooldown === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => update({ animeCooldown: key })}
                    className={`rounded-full px-2.5 py-0.5 text-xs transition cursor-pointer ${
                      active
                        ? "bg-violet-600 text-white shadow"
                        : "bg-white/70 text-black/55 hover:bg-white"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* 视频整体透明度：按椭圆区域径向分布（中心最实、越往周边越透明），透出下层直播画面。
              同一档位同时作用于闭幕黑幕；画布与布局编辑页共用该配置。 */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p className="text-xs text-black/45 shrink-0">视频透明度</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="入场动画透明度">
              {(
                [
                  ["light", "轻"],
                  ["medium", "中"],
                  ["heavy", "重"],
                ] as Array<[AnimeOpacity, string]>
              ).map(([key, label]) => {
                const active = config.animeOpacity === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() =>
                      void update({ animeOpacity: key }).then((next) =>
                        displayDanmaku.broadcastAnimeOpacity(next.animeOpacity),
                      )
                    }
                    className={`rounded-full px-2.5 py-0.5 text-xs transition cursor-pointer ${
                      active
                        ? "bg-violet-600 text-white shadow"
                        : "bg-white/70 text-black/55 hover:bg-white"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </Card>
      </section>

      {/* 横幅：画布正上方的彩虹横幅（点右侧撒花触发庆祝），输入框失焦后同步文字到画布 */}
      <section className="mt-4">
        <ModuleTitle
          title="横幅"
          onColor="bg-fuchsia-500"
          checked={config.banner.enabled}
          onToggle={(v) => void toggleModule({ banner: { ...config.banner, enabled: v } })}
        />
        <Card bg="bg-fuchsia-200" border="border-fuchsia-400">
          <p className="text-xs text-black/50 leading-relaxed">
            显示一个彩虹横幅（可移动/缩放），横幅内容在下方输入，通常用于重要通知/庆祝粉丝升级、收到大礼物等。点击右侧
            <b className="text-black/70"> 撒花 </b>按钮，会释放纸屑与飘带庆祝特效。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={bannerEditText}
              placeholder="横幅文字，最多 30 字"
              onChange={(e) => {
                // 合成中（拼音未上屏）原样保留不截断；确认后的输入才限长 30
                //（React 声明 nativeEvent 为 Event，运行时实为 InputEvent，带 isComposing）
                const native = e.nativeEvent as Event & { isComposing?: boolean };
                const composing = !!native.isComposing || imeComposingRef.current;
                setBannerEditText(
                  composing ? e.target.value : e.target.value.slice(0, 30),
                );
              }}
              onCompositionStart={() => {
                imeComposingRef.current = true;
                imeConfirmedLenRef.current = bannerEditText.length;
              }}
              onCompositionEnd={(e) => {
                imeComposingRef.current = false;
                setBannerEditText(e.currentTarget.value.slice(0, 30));
              }}
              onBlur={commitBannerText}
              onKeyDown={(e) => {
                // 合成中的 Enter 是确认拼音，不提交失焦
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className={`${inputBase} flex-1`}
            />
            <span className="shrink-0 text-[11px] text-black/35">
              {imeComposingRef.current
                ? imeConfirmedLenRef.current
                : bannerEditText.length}
              /30
            </span>
            <button
              type="button"
              disabled={!config.banner.enabled}
              onClick={() => void displayDanmaku.celebrate()}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold text-white transition ${
                config.banner.enabled
                  ? "bg-gradient-to-r from-fuchsia-500 via-amber-400 to-teal-400 shadow-md hover:brightness-110 active:scale-95"
                  : "cursor-not-allowed bg-black/15"
              }`}
            >
              撒花
            </button>
          </div>
          {/* <p className="mt-1.5 text-[11px] text-black/40">
            输入完成后才会把文字更新到画布，输入过程中画布保持原内容。
          </p> */}
        </Card>
      </section>

      {/* 入场动画 与 弹幕互动 之间的分隔线 + 加大间距（横向贯穿整列，虚线、更深色） */}
      <div className="pt-4">
        <div className="w-full border-t-2 border-dashed border-black/40" />
      </div>

      {/* 盲盒盈亏 · 弹幕查询 */}
      <section className="mt-4">
        <ModuleTitle
          title="盲盒盈亏 · 弹幕查询"
          onColor="bg-rose-500"
          checked={config.blindBoxQuery.enabled}
          onToggle={(v) => void toggleBlindBoxQuery(v)}
        />
        <Card bg="bg-rose-200" border="border-rose-400">
          <p className="text-xs text-black/50 leading-relaxed">
            观众在直播间发送特定查询弹幕，即可按 <b className="text-black/70">时间段 + 盲盒名称</b>{" "}
            查询该用户的盲盒盈亏，由当前主播账号回复弹幕。适用盲盒：{" "}
            {profitBoxNames.length > 0 ? (
              <span className="text-black/70">{profitBoxNames.join("、")}</span>
            ) : (
              <span className="text-black/35">（暂无盲盒盈亏配置）</span>
            )}
          </p>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1 rounded-xl bg-white/50 p-3 text-[11px] leading-relaxed text-black/60">
            <div className="font-medium text-black/75">查询全部盲盒的盈亏（不加盲盒名称）</div>
            <div>
              <span className="font-mono text-black/70">盲盒/今日盲盒，昨日盲盒，本周盲盒，本月盲盒，历史盲盒</span>
            </div>
            <div className="font-medium text-black/75">指定盲盒按名称查询（以心动盲盒为例子）</div>
            <div>
              <span className="font-mono text-black/70">心动盲盒/今日心动盲盒，昨日心动盲盒，本周心动盲盒，本月心动盲盒，历史心动盲盒</span>
            </div>
            <div className="font-medium text-black/75">其他盲盒同理（按其真实名称）</div>
            <div className="font-mono text-black/70">
              {profitBoxNames.length > 0
                ? profitBoxNames.join("、")
                : "（暂无盲盒盈亏配置）"}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-black/40 leading-relaxed">
            今日盲盒使用监听弹幕实现，开播时需打开软件一直监听，否则数据不准。
          </p>
        </Card>
      </section>

      {/* 弹幕互动 */}
      <section className="mt-4">
        <ModuleTitle
          title="弹幕互动"
          onColor="bg-emerald-500"
          checked={config.danmaku.enabled}
          onToggle={(v) => update({ danmaku: { ...config.danmaku, enabled: v } })}
        />
        <Card bg="bg-emerald-200" border="border-emerald-400">
          <p className="text-xs text-black/45 leading-relaxed">向直播间循环发送自定义弹幕（直播间不只营业，还有你想表达的话）</p>
          <textarea
            value={config.danmaku.text}
            onChange={(e) => update({ danmaku: { ...config.danmaku, text: e.target.value } })}
            placeholder={`弹幕示例，每一行是一个弹幕

第一个弹幕

第二个弹幕

......`}
            rows={6}
            className={`${inputBase} mt-3 w-full resize-y leading-relaxed`}
          />
          <div className="mt-2 flex items-center gap-2 text-xs text-black/60">
            <span className="shrink-0">弹幕发送间隔</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={intervalText}
              onChange={(e) => setIntervalText(e.target.value.replace(/\D/g, ""))}
              onBlur={() => {
                // 失焦时统一处理：小于 60 自动改为 60（最小 60 秒），空值回退默认 300
                const sec = Math.max(60, Math.floor(Number(intervalText) || 300));
                setIntervalText(String(sec));
                update({
                  danmaku: {
                    ...config.danmaku,
                    intervalSec: sec,
                  },
                });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className={`${inputBase} w-16`}
            />
            <span className="shrink-0 text-black/35">秒（默认5分钟，最短60秒）</span>
          </div>
          {danmakuStatus && (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-white/60 px-3 py-2 text-xs text-black/60">
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  danmakuStatus.startsWith("已发送")
                    ? "bg-green-500"
                    : danmakuStatus.startsWith("正在发送")
                    ? "bg-blue-400"
                    : "bg-red-500"
                }`}
              />
              <span className="truncate">{danmakuStatus}</span>
            </div>
          )}
        </Card>
      </section>

      {/* 调试面板：实时弹幕事件（默认折叠，点击标题展开；仅展示最近 20 条） */}
      <section>
        <Card bg="bg-gray-300" border="border-gray-400">
          <div
            className="flex items-center gap-1.5 cursor-pointer select-none"
            onClick={() => setDebugOpen((v) => !v)}
          >
            <span
              className={`inline-block text-[10px] text-black/50 transition-transform duration-200 ${
                debugOpen ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
            <h3 className="text-sm font-bold text-black/75">弹幕调试日志（用户不必关心）</h3>
          </div>
          {debugOpen && (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-xl bg-white/60 p-2 text-[11px] font-mono space-y-1">
              {debugEvents.length === 0 && (
                <div className="text-black/40">暂无事件，开启展示并等待弹幕…</div>
              )}
              {debugEvents.map((e, i) => (
                <div key={i} className="rounded bg-white/80 px-1.5 py-1">
                  <div>
                    <span className="text-black/45">{e.time}</span>
                    <span className="font-bold text-black/85"> [{e.cmd}]</span>
                    <span
                      className={`ml-1 ${
                        e.action === "raw"
                          ? "text-blue-600"
                          : e.action === "emit" || e.action === "anime"
                          ? "text-green-600"
                          : e.action === "filtered"
                          ? "text-orange-500"
                          : "text-purple-600"
                      }`}
                    >
                      {e.action}
                    </span>
                  </div>
                  <div className="text-black/65 break-all">{JSON.stringify(e.data)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* 播放片段设置模态框：长视频（>30s）点击视频文件名弹出 */}
      {segmentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-bold text-black/85">设置入场视频播放时间段</h3>
            <p className="mt-1 text-xs text-black/45 truncate" title={segmentModal.path}>
              {segmentModal.path.split(/[/\\]/).pop()}
            </p>
            <div className="mt-2 flex items-center gap-2 text-xs text-black/55">
              <span className="shrink-0">总时长</span>
              <span className="font-mono font-semibold text-black/80">
                {secToTime(segmentModal.total)}
              </span>
              <span className="text-black/35">（默认播放最后30s）</span>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs text-black/60">
              <span className="shrink-0 w-8">开始</span>
              <input
                value={segmentModal.startText}
                onChange={(e) =>
                  setSegmentModal({ ...segmentModal, startText: e.target.value })
                }
                placeholder="mm:ss"
                inputMode="numeric"
                className="w-24 rounded-lg bg-black/5 px-2 py-1.5 font-mono text-sm text-black/85 outline-none"
              />
              <span className="text-black/35">结束</span>
              <input
                value={segmentModal.endText}
                onChange={(e) =>
                  setSegmentModal({ ...segmentModal, endText: e.target.value })
                }
                placeholder="mm:ss"
                inputMode="numeric"
                className="w-24 rounded-lg bg-black/5 px-2 py-1.5 font-mono text-sm text-black/85 outline-none"
              />
            </div>

            {/* 快捷选项 */}
            <div className="mt-2.5 flex items-center gap-1.5">
              <button
                className={`${btnGhost} flex-1 text-[11px]`}
                onClick={() => applySegment(0, Math.floor(segmentModal.total))}
              >
                播放整段
              </button>
              <button
                className={`${btnGhost} flex-1 text-[11px]`}
                onClick={() => applySegment(0, 30)}
              >
                播放前30秒
              </button>
              <button
                className={`${btnGhost} flex-1 text-[11px]`}
                onClick={() => {
                  const t = Math.floor(segmentModal.total);
                  applySegment(t <= 30 ? 0 : t - 30, t);
                }}
              >
                播放后30秒
              </button>
            </div>

            {segmentErr && <p className="mt-2 text-xs text-red-500">{segmentErr}</p>}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                className="rounded-lg bg-black/5 px-4 py-1.5 text-xs font-medium text-black/60 transition hover:bg-black/10"
                onClick={() => setSegmentModal(null)}
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#1f1c17] px-4 py-1.5 text-xs font-medium text-white shadow transition hover:opacity-90"
                onClick={handleSegmentSave}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
