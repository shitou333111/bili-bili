"use client";

/**
 * 高级用户自定义入场动画：全画布播放该用户配置的本地视频（Tauri asset 协议
 * http://asset.localhost/...，由 convertFileSrc 生成）。
 *
 * 播放分三个阶段（移植自测试页 ghost 变体；loop 编辑预览模式同样完整播放）：
 *  1. 开场（openingMode 可配置）：ellipse = 视频由中心一个实心大椭圆向外扩散渐显（CSS @property
 *     --anime-ripple，椭圆两轴均用盒百分比，与任意宽高比的视频同形，71% 半径盖住四角）；
 *     fade（默认）= 透明度从很低的中间值（0.12）渐入到 1（时长 = 开场时长×1.6，更缓和，
 *     终点遵循「整体透明」档位）；none = 视频直接显示。
 *  2. 结尾闭合：视频从自身上下边缘向中间被擦除成透明（--anime-curtain 0%→50%），
 *     **完全闭合的瞬间视频正好播放完毕**；黑幕只出现在中间固定区域（头像顶再上 20u ～
 *     昵称底再下 20u，u = 视频显示宽/328），前沿未进入区域时只是透明擦除、不露黑；
 *     头像只在被擦除的区域内随前沿显现；昵称做镂空——一张「白底挖出黑色昵称」的 SVG 作为
 *     黑幕容器的 mask-image，从黑幕上"抠"出文字形状（该处 alpha=0），画布本身透明，
 *     故文字形状处直接透出下层直播画面（并非在黑幕上画白字）。
 *  3. 收尾：黑幕+头像+昵称保持 1s，再整体淡出 1s，随后释放画布；loop 预览模式则在
 *     淡出后复位并整段重播（编辑布局页可反复观察完整开合效果）。
 *
 * 整体透明度：视频套一层按椭圆区域径向分布的 alpha 遮罩——
 * 圆心最实、越往周边 alpha 越小（越透明），下层直播画面可从四周透出；闭幕黑幕形状不变，
 * 整体均匀套用该档位的中心不透明度。档位由面板下发的 opacity prop（轻/中/重）决定，
 * 画布与布局编辑页共用同一份配置。
 *
 * 视频边缘羽化（与整体透明度并存）：左右/上下边缘各挂一条线性渐变 mask，与闭合擦除
 * mask 取交集——四边向内透明过渡，强度由 featherH/featherV 独立控制（0 = 关闭）。
 *
 * 时长按视频实际有效时长 D 动态计算：开场 E = min(2.602s, 0.464D)，
 * 闭合 C = min(3s, D−E)，故闭合完成时刻恒为视频结束时刻；开场/闭合动画时长通过
 * 内联 animation-duration 传给 globals.css 里固定的关键帧。闭合起点由 timeupdate
 * （currentTime ≥ end−C）驱动，只做一次性状态切换，插值全部在 CSS 合成线程完成。
 *
 * 加载方式：直接作为 <video> 的 src。不要用 fetch 拉取——asset 协议的响应不带
 * CORS 头，fetch 会报 "Failed to fetch"，而媒体栈播放 <video> 不需要 CORS，
 * 因此直接给 src 即可稳定播放。
 *
 * 结束判定：onEnded 是主信号，但媒体片段（#t=start,end）在部分内核（含 WebView2/
 * Chromium）下会在片段末尾"暂停"而不派发 ended，导致视频永久停在最后一帧。因此叠加
 * timeupdate 兜底：currentTime 接近结束点时同样进入收尾流程，保证画布必然释放。
 * handleEnd 幂等，重复触发只执行一次。
 *
 * 结尾的头像昵称（endingMode 可配置，面板「结尾的头像昵称」四选项）：
 *  - none（无）：动画结束不加额外头像和昵称，视频播完即释放；
 *  - fade（渐显渐隐）：头像（绿边圆框）与昵称（绿边胶囊）同时渐显、保持 1s、再渐隐；
 *  - portal（奇异博士传送门，默认）：视频结束后画一个 WebGL 火花圆环（src/lib/portal
 *    抽取自 SlingTab），头像在圈内随展开度 clip-path 圆形由小到大渐显，昵称胶囊同步
 *    渐显渐隐，火圈悬停后吹散、圈内内容同步渐隐；
 *  - curtain（黑幕闭合）：系统原结尾——视频从上下边缘向中间擦除，黑幕内头像随前沿显现，
 *    昵称做镂空透出直播画面，保持 1s 后整体淡出。
 * 所有结尾方式中，昵称最大宽度 ≤ 舞台宽 80%（超长时等比缩小字号保证全名完整显示；黑幕镂空
 * 同样按估算宽度缩字号）。视频本身结尾 1s 渐隐（所有方式生效）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ANIME_OPACITY_ALPHA,
  type AnimeEnding,
  type AnimeOpacity,
  type AnimeOpening,
  type DisplayEvent,
} from "@/lib/display/types";
import { srcWithFragment } from "@/lib/display/video";
import { PortalFX } from "@/lib/portal/portal";
import VolumeIcon from "@/components/VolumeIcon";

/** 播放片段结束检测容差（秒）：timeupdate 约 4Hz，留出一次触发间隔的余量 */
const END_EPSILON = 0.12;
/** 闭合起点提前量（秒）：抵消 timeupdate 采样间隔，保证闭合动画尽早启动 */
const CLOSE_LEAD = 0.05;
/** 闭合完成后黑幕+头像昵称保持时长（ms），随后整体淡出 */
const HOLD_MS = 1000;
/** 收尾整体淡出时长（ms） */
const FADE_MS = 1000;
/** 「渐显渐隐」结尾方式：头像+昵称胶囊渐显/渐隐各用时长（ms），中间保持 HOLD_MS */
const ENDING_FADE_MS = 800;
/** 开场椭圆扩散时长上限/比例（测试页基准：5.602s 视频开场 2.602s ≈ 46.4%，上限放宽到 3s） */
const OPEN_MAX_SEC = 3;
const OPEN_RATIO = 0.464;
/** 闭合擦除时长上限（秒），短视频时取 D−E 以保证闭合完成=视频播完 */
const CLOSE_MAX_SEC = 3;
/** 视频结尾渐隐时长（秒）：到达结束点前 1s 开始把 video 本身淡出到透明（所有结尾方式生效） */
const VIDEO_FADE_SEC = 1;
/** 测试页几何基准宽度（px）：该宽度下 1u = 1px */
const U_BASE_W = 328;
/** 昵称最大宽度占舞台宽的比例（所有结尾方式统一 80%，给两侧留边距） */
const NAME_MAX_W_RATIO = 0.8;

/**
 * 昵称胶囊字号缩放：估算渲染宽度（非 ASCII ≈1em、ASCII ≈0.62em，每字符 +1u 字距，
 * 加胶囊 padding 16u×2 + border 2u×2），超过舞台宽 80% 时等比缩小字号与字距，
 * 保证超长昵称完整显示（不截断省略号）。
 */
function namePillScale(uname: string, u: number, stageW: number): number {
  const fsFull = 33 * u;
  let est = 2 * 16 * u + 2 * 2 * u;
  for (const ch of uname) est += (ch.codePointAt(0)! > 0xff ? 1 : 0.62) * fsFull + u;
  const maxW = stageW * NAME_MAX_W_RATIO;
  return est > maxW ? maxW / est : 1;
}

/** XML 文本转义（昵称可能含 & < > "，直接拼进 SVG 会破坏结构） */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 昵称「镂空」遮罩：一张与舞台同尺寸的 SVG 图（白色底 + 黑色昵称），供 CSS `mask-image` 使用。
 * SVG 内部用 <mask>（默认亮度模式）把昵称从白底上挖掉 → 文字处 alpha=0；把它作为黑幕的
 * mask-image 后，黑幕在文字形状处被抠空 → 透明画布直接透出下层直播画面。
 * 尺寸/字号/位置都按舞台盒（w×h，px）与 --u 计算，随舞台尺寸变化重建。
 * 说明：不能用 `mix-blend-mode: destination-out`——该 Porter-Duff 运算符并非 mix-blend-mode 的
 * 合法取值（会被丢弃为 normal），只有 mask/filter 能真正扣 alpha。
 */
function knockMaskImage(w: number, h: number, u: number, uname: string): string {
  // 昵称宽度估算：非 ASCII ≈ 1em、ASCII ≈ 0.62em，加每字符 1u 字距；
  // 超过舞台宽 80% 时等比缩小字号（字距同步缩），保证全名可见且两侧留边距
  const fsFull = 33 * u; // 昵称字号（与旧 .anime-name span 一致）
  let est = 0;
  for (const ch of uname) est += (ch.codePointAt(0)! > 0xff ? 1 : 0.62) * fsFull + u;
  const maxW = w * NAME_MAX_W_RATIO;
  const scale = est > maxW ? maxW / est : 1;
  const fs = fsFull * scale;
  const ls = u * scale;
  const y = h / 2 + 21.5 * u; // 文字垂直中心 = 中线 + 5u(顶边) + 33u/2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><mask id="k" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse">` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff"/>` +
    `<text x="${w / 2}" y="${y}" text-anchor="middle" dominant-baseline="central"` +
    ` font-family="'PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"` +
    ` font-weight="900" font-size="${fs}" letter-spacing="${ls}" fill="#000">${xmlEscape(uname)}</text>` +
    `</mask></defs>` +
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#fff" mask="url(#k)"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** 头像地址规范化：B站接口/弹幕消息里的 face 可能是 //i0.hdslb.com/... 或 http://...，
 *  在 https 页面/Tauri WebView 下会被当成混合内容或无效地址拦截 → onError → 回退首字母头像。
 *  这里统一升级为 https；noface 占位图直接视为无头像。 */
function normalizeFaceUrl(url: string): string {
  const u = (url || "").trim();
  if (!u || /\/noface\.jpg$/.test(u)) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("http://")) return "https://" + u.slice(7);
  return u;
}

/** 头像加载失败的重试次数：结尾才挂载头像，首次请求偶发 CDN/网络抖动时重试，
 *  避免整段动画结尾都退化成首字母头像。 */
const AVATAR_RETRY = 2;

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆（与 EntryBadge 的 Avatar 同视觉）。
 *  className/style 可覆盖：传送门模式改尺寸/位置/clip-path，渐显渐隐模式加绿边圆框。 */
function AnimeAvatar({
  face,
  uname,
  className,
  style,
}: {
  face: string;
  uname: string;
  className?: string;
  style?: CSSProperties;
}) {
  const src = normalizeFaceUrl(face);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(!src);
  // 注：调用处用 key={face} 挂载，face 变化时整组件重挂载，状态自然复位
  return (
    <div className={className ? `anime-avatar ${className}` : "anime-avatar"} style={style}>
      {!failed && src ? (
        <img
          key={attempt}
          src={src}
          alt=""
          onError={() => {
            if (attempt < AVATAR_RETRY) {
              // 换 key 重新挂载 <img>，让浏览器重新发起一次请求
              setTimeout(() => setAttempt((n) => n + 1), 300);
            } else {
              setFailed(true);
            }
          }}
        />
      ) : (
        (uname || "?").slice(0, 1)
      )}
    </div>
  );
}

export default function VideoOverlay({
  anime,
  onEnd,
  loop = false,
  onVideoSize,
  opacity = "medium",
  featherH = 0,
  featherV = 0,
  muted = true,
  onMutedChange,
  endingMode = "portal",
  openingMode = "fade",
}: {
  anime: Extract<DisplayEvent, { type: "anime" }>;
  onEnd: () => void;
  /** 预览循环模式：完整播放一遍开场/闭合/头像昵称/淡出后自动重播，不释放画布（编辑布局页常驻预览） */
  loop?: boolean;
  /** 视频画面实际尺寸（natural 像素，loadedmetadata 后回调）——父级据此让元素贴合视频画面 */
  onVideoSize?: (w: number, h: number) => void;
  /** 整体透明度档位：按椭圆区域径向分布（圆心最实、越往周边越透明），可透出下层直播画面 */
  opacity?: AnimeOpacity;
  /** 视频左右边缘羽化强度：0=关闭，1-40 = 每侧透明渐变宽度百分比 */
  featherH?: number;
  /** 视频上下边缘羽化强度：0=关闭，1-40 = 每侧透明渐变宽度百分比 */
  featherV?: number;
  /** 静音状态（受控）：默认静音以兼容浏览器/CEF 无声自动播放限制；与面板「声音」开关共享同一状态 */
  muted?: boolean;
  /** 点击右下角声音按钮时回调：父级更新状态并同步各端（画布/面板/主进程） */
  onMutedChange?: (muted: boolean) => void;
  /** 结尾的头像昵称方式：none=无 / fade=渐显渐隐 / portal=奇异博士传送门 / curtain=黑幕闭合 */
  endingMode?: AnimeEnding;
  /** 开场方式：none=无（视频直接显示）/ fade=渐显（从中间透明度渐入，终点遵循整体透明档位）/ ellipse=椭圆拓展 */
  openingMode?: AnimeOpening;
}) {
  const [fadeOut, setFadeOut] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 结尾闭合是否已启动（驱动 --anime-curtain 的 close 动画一次性开始）
  const [closing, setClosing] = useState(false);
  // 舞台实际盒宽（px）：用于把测试页的 px 几何换算成与视频显示宽成比例的 --u
  const [boxW, setBoxW] = useState(0);
  // 舞台实际盒高（px）：昵称镂空遮罩的 SVG 需按盒高定位文字
  const [boxH, setBoxH] = useState(0);
  // 开场/闭合动画时长（ms）：loadedmetadata 拿到有效时长后按视频实际长度计算
  const [timing, setTiming] = useState({ eMs: 2602, cMs: 3000 });
  const onEndRef = useRef(onEnd);
  useEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);
  // loop 的最新值供 handleEnd 定时器读取（handleEnd 保持稳定，避免复位 effect 反复重跑）
  const loopRef = useRef(loop);
  useEffect(() => {
    loopRef.current = loop;
  }, [loop]);
  const onVideoSizeRef = useRef(onVideoSize);
  useEffect(() => {
    onVideoSizeRef.current = onVideoSize;
  }, [onVideoSize]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // 是否显式设置了播放片段：设置了则严格按 start/end 播；两者为 0（播整段）时，
  // 若视频实际时长 >30s，改为默认播放最后 30 秒。
  const userSegmented = anime.startSec > 0 || anime.endSec > 0;
  // 播放源：拼接媒体片段（#t=start,end）。初始按用户片段拼接；未设置片段时先整段加载
  // 探测时长，载入后在 loadedmetadata 里按"最后 30 秒"重新拼接并替换。
  const [displaySrc, setDisplaySrc] = useState(() =>
    userSegmented ? srcWithFragment(anime.videoSrc, anime.startSec, anime.endSec) : anime.videoSrc,
  );
  // 加载兜底计时器：视频成功加载（loadedmetadata）后清除，避免把正常的长视频截断
  const failTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 播放推进守护：canplay 后若视频一直处于 paused（自动播放被浏览器/CEF 策略拒绝），
  // 既不会 ended 也不会 timeupdate，6s 加载兜底又已在 loadedmetadata 清除 →
  // 画布永久不释放、后续入场动画全部排队（表现为"只播一次，之后再也触发不了"）。
  const playGuardRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 片段结束秒数（未设片段 = 视频时长），供 timeupdate 兜底检测结束
  const endSecRef = useRef(0);
  // 淡出幂等标记：ended 与 timeupdate 可能先后触发，只执行一次保持+淡出+释放
  const endingRef = useRef(false);
  // 闭合启动幂等标记
  const closingRef = useRef(false);
  // 收尾阶段的保持/淡出计时器（新事件/卸载时清理，避免迟到回调释放错误的画布）
  const endTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  // 播放代际：每个新的 anime 事件（即使 videoSrc 相同）都递增，强制复位状态并重挂载
  // 视频，避免同一视频连续触发时被上一次的 ended/淡出状态卡住、第二次不播也不消失
  const [gen, setGen] = useState(0);
  // 预览重播代际：loop 模式淡出后递增，整段重挂载（含外层，瞬时复位透明度）再播一遍
  const [replaySeq, setReplaySeq] = useState(0);
  // 结尾头像昵称方式（ref 供 handleEnd 读取，避免进依赖导致中途重跑复位 effect）
  const endingModeRef = useRef<AnimeEnding>(endingMode);
  useEffect(() => { endingModeRef.current = endingMode; }, [endingMode]);
  // 传送门结尾：激活态 + 火圈开合进度（PortalFX onOpen 回传 0..1）
  const [portalActive, setPortalActive] = useState(false);
  const [portalOpen, setPortalOpen] = useState(0);
  // 渐显渐隐结尾：show=渐显+保持 / hide=渐隐
  const [endingPhase, setEndingPhase] = useState<"show" | "hide" | null>(null);
  // 视频结尾渐隐（state 触发 CSS transition，ref 防 onTimeUpdate 每帧重复置位）
  const [videoFading, setVideoFading] = useState(false);
  const videoFadingRef = useRef(false);
  const portalCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // 新的 anime 事件 → 递增代际（初始挂载也触发一次，无副作用）
  useEffect(() => {
    setGen((g) => g + 1);
  }, [anime]);

  // 预加载结尾头像：结尾阶段才挂载 <img>，若届时才开始请求，弱网下会先闪出首字母头像；
  // 动画一开始就预热，结尾时通常已命中缓存。
  useEffect(() => {
    const src = normalizeFaceUrl(anime.user.face);
    if (!src) return;
    const img = new Image();
    img.src = src;
  }, [anime.user.face]);

  // 预览重播：同步复位收尾态（与 replaySeq 同批渲染，重挂载的新节点直接以
  // opacity-100/闭合动画未启动的状态出现，避免上一轮淡出/闭合状态残留）
  const restart = useCallback(() => {
    endTimersRef.current = [];
    setFadeOut(false);
    setClosing(false);
    endingRef.current = false;
    closingRef.current = false;
    // 结尾头像昵称/视频渐隐状态一并复位（预览重播整段干净重来）
    setPortalActive(false);
    setPortalOpen(0);
    setEndingPhase(null);
    setVideoFading(false);
    videoFadingRef.current = false;
    setReplaySeq((s) => s + 1);
  }, []);

  // 收尾统一出口：delayMs 后整体淡出→复位(预览)/释放画布(正式)
  const release = useCallback(
    (delayMs: number) => {
      endTimersRef.current.push(
        setTimeout(() => {
          setFadeOut(true);
          endTimersRef.current.push(
            setTimeout(() => {
              if (loopRef.current) restart();
              else onEndRef.current();
            }, FADE_MS),
          );
        }, delayMs),
      );
    },
    [restart],
  );

  const clearPlayGuard = useCallback(() => {
    if (playGuardRef.current) {
      clearInterval(playGuardRef.current);
      playGuardRef.current = null;
    }
  }, []);

  const handleEnd = useCallback(() => {
    if (endingRef.current) return;
    endingRef.current = true;
    // 收尾开始后停止播放守护（否则守护会在收尾过程中再次判定"没播放"）
    if (playGuardRef.current) {
      clearInterval(playGuardRef.current);
      playGuardRef.current = null;
    }
    switch (endingModeRef.current) {
      case "curtain":
        // 黑幕闭合：闭合完成（≈视频播完）→ 黑幕+头像昵称保持 1s → 整体淡出 1s
        release(HOLD_MS);
        break;
      case "portal": {
        // 奇异博士传送门：激活火圈序列，onDone（火花熄灭后）统一收口
        setPortalActive(true);
        break;
      }
      case "fade":
        // 渐显渐隐：头像+昵称渐显 → 保持 HOLD_MS → 渐隐 ENDING_FADE_MS 后收口
        setEndingPhase("show");
        endTimersRef.current.push(
          setTimeout(() => {
            setEndingPhase("hide");
            release(ENDING_FADE_MS);
          }, ENDING_FADE_MS + HOLD_MS),
        );
        break;
      case "none":
      default:
        release(0);
        break;
    }
  }, [release]);

  // 自动播放守护：canplay 时启动（此时已尝试 play()）。
  // 正常播放 → paused=false，直接停表；若一直 paused（策略拒绝自动播放、CEF 静音策略等），
  // 每秒重试一次 play()，累计 ~2.5s 仍未播放则直接收尾，保证画布必然释放、队列不会堵死。
  const startPlayGuard = useCallback(() => {
    if (loop || playGuardRef.current) return;
    let retried = false;
    let stalled = 0;
    playGuardRef.current = setInterval(() => {
      const el = videoRef.current;
      if (!el) {
        clearPlayGuard();
        return;
      }
      // 已在播放（或已播完进入收尾）：守护使命结束
      if (!el.paused || endingRef.current) {
        clearPlayGuard();
        return;
      }
      // 仍在加载/缓冲（readyState < HAVE_FUTURE_DATA）：不判定，等下一拍
      if (el.readyState < 3) return;
      stalled += 1;
      if (!retried && stalled >= 2) {
        retried = true;
        console.warn("[展示] 入场视频未能自动播放，重试 play()");
        el.play?.().catch(() => {});
        return;
      }
      if (retried && stalled >= 5) {
        console.warn("[展示] 入场视频自动播放被拒绝，直接进入收尾释放画布");
        clearPlayGuard();
        handleEnd();
      }
    }, 500);
  }, [loop, clearPlayGuard, handleEnd]);

  useEffect(() => {
    setFadeOut(false);
    setLoadError(false);
    setClosing(false);
    clearPlayGuard();
    endingRef.current = false;
    closingRef.current = false;
    endSecRef.current = 0;
    endTimersRef.current.forEach(clearTimeout);
    endTimersRef.current = [];
    // 结尾头像昵称/视频渐隐状态复位（新一轮播放/视频变更）
    setPortalActive(false);
    setPortalOpen(0);
    setEndingPhase(null);
    setVideoFading(false);
    videoFadingRef.current = false;
    // 视频变更/新一轮播放时复位播放源（回到用户片段或整段初始，等待 loadedmetadata 再决定是否截尾 30s）
    setDisplaySrc(
      userSegmented ? srcWithFragment(anime.videoSrc, anime.startSec, anime.endSec) : anime.videoSrc,
    );
    if (!anime.videoSrc) {
      console.log("[展示] 未配置视频，videoSrc 为空");
      return;
    }
    // 循环模式常驻画布；否则视频无法加载/播放时约 6s 兜底进入收尾（视频成功加载后清除），避免永久遮挡
    if (loop) return;
    failTimerRef.current = setTimeout(() => {
      failTimerRef.current = null;
      handleEnd();
    }, 6000);
    return () => {
      if (failTimerRef.current) {
        clearTimeout(failTimerRef.current);
        failTimerRef.current = null;
      }
    };
  }, [anime.videoSrc, userSegmented, anime.startSec, anime.endSec, loop, handleEnd, gen, clearPlayGuard]);

  // 传送门结尾：激活时创建 PortalFX 跑完整序列（点燃→开圈→保持→消散）。
  // onDone 时火花已自然衰减完毕（portal.ts 会继续渲染至火花数为 0 才停帧），
  // 此刻统一走整体淡出收口。effect 卸载（重播/换事件/组件销毁）时直接 dispose。
  useEffect(() => {
    if (!portalActive) return;
    const cv = portalCanvasRef.current;
    // 画布未挂载（视频加载失败等 fx=false 场景）或盒尺寸未测得：直接收口，避免画布永久滞留
    if (!cv || boxW <= 0 || boxH <= 0) {
      release(0);
      return;
    }
    const u = boxW / U_BASE_W;
    let fx: PortalFX | null = null;
    try {
      fx = new PortalFX(
        cv,
        { cx: boxW / 2, cy: boxH / 2 - 16 * u, radius: 38 * u },
        {
          onOpen: (o) => setPortalOpen(o),
          onDone: () => release(0),
        },
      );
      fx.resize(boxW, boxH, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
      fx.start();
    } catch (e) {
      // WebGL2 不可用（虚拟机/远程桌面/GPU 黑名单/CEF 关闭硬件加速）或着色器编译失败：
      // 绝不能让异常冒泡——effect 抛错会让 React 卸载整棵画布组件树，页面从此不再响应
      // 任何弹幕事件（刷新浏览器源才恢复一次）。降级为直接收尾即可。
      console.warn("[展示] 传送门结尾初始化失败，降级为直接收尾", (e as Error)?.message || e);
      try {
        fx?.dispose();
      } catch {
        /* 已创建的部分资源释放失败忽略 */
      }
      release(0);
      return;
    }
    return () => {
      fx?.dispose();
    };
  }, [portalActive, boxW, boxH, gen, replaySeq, release]);

  // 测量舞台实际盒宽 → --u（几何缩放单位），ResizeObserver 应对布局拖动/缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      const h = entries[0]?.contentRect.height ?? 0;
      if (w > 0) setBoxW((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
      if (h > 0) setBoxH((prev) => (Math.abs(prev - h) < 0.5 ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [gen, replaySeq, anime.videoSrc, loadError]);

  const logVideoEvent = (ev: string) => {
    const el = videoRef.current;
    console.log("[展示] 视频事件", ev, {
      src: displaySrc.slice(0, 80),
      readyState: el?.readyState,
      networkState: el?.networkState,
      currentTime: el?.currentTime,
    });
  };

  const handleVideoError = () => {
    const el = videoRef.current;
    console.error("[展示] 视频加载失败", {
      src: displaySrc,
      code: el?.error?.code,
      message: el?.error?.message,
      networkState: el?.networkState,
      readyState: el?.readyState,
    });
    // 非循环模式：释放画布；循环模式：显示占位便于测试
    if (loop) setLoadError(true);
    else handleEnd();
  };

  // 是否启用入场开合效果（有视频且未加载失败；编辑预览同样启用，完整展示开合过程）
  const fx = Boolean(anime.videoSrc) && !loadError;

  // 结尾闭合擦除 mask：上下各一条随 --anime-curtain 增长的透明带（50% 时在中线相接、全擦净）
  const wipeMask =
    "linear-gradient(to bottom, transparent 0 var(--anime-curtain), #000 var(--anime-curtain) calc(100% - var(--anime-curtain)), transparent calc(100% - var(--anime-curtain)) 100%)";
  // 边缘羽化：两层线性渐变 mask 取交集 = 四边透明过渡（左右/上下独立强度，0=关闭）。
  // 纯静态 CSS，由 GPU 合成器光栅化时做 alpha 混合，无逐帧计算；mask 作用于 alpha，
  // 透明背景不会被染灰。注意不能加在 MovableBox/wrapper 上，否则编辑虚线框、缩放把手、
  // 声音按钮也会跟着透明——只加在 video 元素上。与包裹层的整体透明度（径向 alphaMask）
  // 分处两层、各自取交集，两者并存互不干扰。
  const fh = Math.min(40, Math.max(0, Math.round(featherH)));
  const fv = Math.min(40, Math.max(0, Math.round(featherV)));
  const maskLayers = [
    ...(fx && endingMode === "curtain" ? [wipeMask] : []),
    fh > 0
      ? `linear-gradient(to right, transparent 0%, #000 ${fh}%, #000 ${100 - fh}%, transparent 100%)`
      : null,
    fv > 0
      ? `linear-gradient(to bottom, transparent 0%, #000 ${fv}%, #000 ${100 - fv}%, transparent 100%)`
      : null,
  ].filter((s): s is string => Boolean(s));
  const videoMaskStyle: CSSProperties | undefined =
    maskLayers.length > 0
      ? {
          maskImage: maskLayers.join(", "),
          WebkitMaskImage: maskLayers.join(", "),
          // 多层 mask 默认取并集，必须显式取交集才能擦除/羽化同时生效（WebKit 旧前缀值为 source-in）
          ...(maskLayers.length > 1
            ? { maskComposite: "intersect", WebkitMaskComposite: "source-in" }
            : {}),
        }
      : undefined;

  // 整体透明度：一条按椭圆区域径向分布的 alpha
  // 遮罩——圆心最实、越往周边 alpha 越小 = 越透明，下层直播画面从视频四周透出。纯静态 CSS，
  // 由 GPU 合成器光栅化时做 alpha 混合，无逐帧计算；mask 只作用于 alpha，透明背景不会被染灰。
  // 渐变椭圆取 71%（≈ √2/2）：mask 渐变 stop 的百分比相对「该方向上椭圆边界到圆心的射线长度」
  // （不是相对盒子尺寸），因此 71% 时盒内四角恰落在 100% 处 → 四角 = edge alpha、圆心 = center
  // alpha；且椭圆两轴各按盒宽/盒高解析，该结论与画幅宽高比无关（横竖屏都是四角最透）。
  const oa = ANIME_OPACITY_ALPHA[opacity] ?? ANIME_OPACITY_ALPHA.light;
  const alphaMask = `radial-gradient(ellipse 71% 71% at 50% 50%, rgba(0,0,0,${oa.center}) 0%, rgba(0,0,0,${oa.edge}) 100%)`;
  // 黑幕形状与之前完全一致（上下两条实心黑带铺满整宽），只是整体套当前档位的中心不透明度
  // → 黑幕按选中档位均匀半透明、透出下层画面；不挂径向渐变（否则两端被淡掉，看起来像“黑幕没了”）。
  // 另挂「昵称镂空」mask-image：在昵称文字形状处把黑幕整块抠空 → 该处 alpha=0，透明画布
  // 直接透出下层直播画面（替代原先的白字盖黑幕）。盒尺寸未测得前不挂，避免遮罩错位。
  const knockMask =
    boxW > 0 && boxH > 0 ? knockMaskImage(boxW, boxH, boxW / U_BASE_W, anime.user.uname) : undefined;
  const curtainStyle: CSSProperties = {
    opacity: oa.center,
    ...(knockMask
      ? {
          maskImage: knockMask,
          WebkitMaskImage: knockMask,
          maskSize: "100% 100%",
          WebkitMaskSize: "100% 100%",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
        }
      : {}),
  };

  // 昵称胶囊字号缩放（portal/fade 两种模式共用）：超舞台宽 80% 时等比缩小字号与字距，
  // 保证超长昵称完整显示（不再省略号截断）。盒宽未测得前不挂内联字号，沿用 CSS 默认。
  const pillU = boxW > 0 ? boxW / U_BASE_W : 0;
  const namePillScaleV = namePillScale(anime.user.uname, pillU, boxW);
  const namePillStyle: CSSProperties | undefined =
    boxW > 0
      ? { fontSize: `${33 * pillU * namePillScaleV}px`, letterSpacing: `${pillU * namePillScaleV}px` }
      : undefined;

  // 开场椭圆扩散 mask：中心实心大椭圆，横/纵半径都用 --anime-ripple（百分比分别按盒宽/盒高
  // 解析，故与视频同形）；内边缘收 6u 做轻微羽化。注意：渐变 stop 的百分比是相对「渐变射线」
  // 长度（= 椭圆边界在该方向的半径），不是相对盒子尺寸——所以边界处的 stop 必须写 100%（写
  // --anime-ripple 会把实心区缩到 ripple²，椭圆偏小、四角被遮）。椭圆外透明 → 开场渐显。
  const rippleMask =
    "radial-gradient(ellipse var(--anime-ripple) var(--anime-ripple) at 50% 50%, #000 0, #000 max(0%, calc(100% - 6 * var(--u))), transparent 100%)";
  // 开场方式（openingMode）三态：
  //  - ellipse（椭圆拓展）：中心大椭圆向外扩散（--anime-ripple 动画）∩ 整体透明度（两层 mask 交集）；
  //  - fade（渐显，默认）：无形状遮罩，透明度从很低的 0.12 渐入到 1（不从 0 起），时长 = 开场时长×1.6；
  //    mask 的整体透明档位始终生效 → 最终观感遵循「整体透明」设置；
  //  - none（无）：视频直接显示，只挂整体透明度 mask，无开场动画。
  const wrapStyle: CSSProperties | undefined = !fx
    ? undefined
    : openingMode === "ellipse"
      ? {
          animation: `anime-ripple-open ${timing.eMs}ms cubic-bezier(.4,0,.2,1) both`,
          maskImage: [rippleMask, alphaMask].join(", "),
          WebkitMaskImage: [rippleMask, alphaMask].join(", "),
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
        }
      : openingMode === "fade"
        ? {
            animation: `anime-open-fade ${Math.round(timing.eMs * 1.6)}ms ease both`,
            maskImage: alphaMask,
            WebkitMaskImage: alphaMask,
          }
        : {
            maskImage: alphaMask,
            WebkitMaskImage: alphaMask,
          };

  // 头像+昵称的 reveal mask：仅「黑幕区域内、已被上下擦除前沿扫过的部分」可见。
  // 黑幕区域：中线−85u（头像顶再上 20u）～ 中线+58u（昵称底再下 20u）。
  const contentMask =
    "linear-gradient(to bottom, transparent 0 calc(50% - 85 * var(--u)), #000 calc(50% - 85 * var(--u)) var(--anime-curtain), transparent var(--anime-curtain) calc(100% - var(--anime-curtain)), #000 calc(100% - var(--anime-curtain)) calc(50% + 58 * var(--u)), transparent calc(50% + 58 * var(--u)) 100%)";

  // 舞台样式：--u 几何单位；闭合动画在 closing 后一次性启动（时长 = 闭合时长 C）
  const stageStyle: CSSProperties = {
    "--u": `${(boxW / U_BASE_W).toFixed(4)}px`,
    animation: fx && closing ? `anime-curtain-close ${timing.cMs}ms cubic-bezier(.4,0,.2,1) forwards` : "none",
  } as CSSProperties;

  return (
    // 画布本身透明（叠在真实直播画面上），不叠加黑底遮罩；等比缩放后视频四周留出的
    // 空白直接透出画布。收尾阶段整体 1s 淡出。
    <div
      key={`${gen}|${replaySeq}`}
      className={`absolute inset-0 z-[1] transition-opacity duration-1000 ${
        fadeOut ? "opacity-0" : "opacity-100"
      } pointer-events-none`}
    >
      {anime.videoSrc && !loadError ? (
        // key=gen：新事件整体重挂载，开场椭圆动画从头播放、闭合状态复位
        <div className="anime-stage" key={gen} ref={stageRef} style={stageStyle}>
          {/* 椭圆扩散包裹层：只包视频；闭合用 --anime-curtain 挂在舞台上，本层只管开场 */}
          <div className="anime-ripple-wrap" style={wrapStyle}>
            <video
              ref={videoRef}
              key={`${displaySrc}|${gen}|${replaySeq}`}
              src={displaySrc}
              autoPlay
              muted={muted}
              playsInline
              className="w-full h-full object-contain"
              style={{
                ...videoMaskStyle,
                // 视频结尾渐隐：进入结束前 1s 由 onTimeUpdate 触发，线性淡出到 0
                transition: `opacity ${VIDEO_FADE_SEC}s linear`,
                opacity: videoFading ? 0 : 1,
              }}
              onLoadStart={() => logVideoEvent("loadstart")}
              onLoadedMetadata={() => {
                // 视频已成功加载：取消 6s 兜底释放，避免截断正常的长视频
                if (failTimerRef.current) {
                  clearTimeout(failTimerRef.current);
                  failTimerRef.current = null;
                }
                const el = videoRef.current;
                if (el && Number.isFinite(el.duration)) {
                  // 结束点：显式片段取 endSec；未设片段（含只设开始）取视频时长
                  const end = userSegmented && anime.endSec > 0 ? anime.endSec : el.duration;
                  endSecRef.current = end > 0 ? end : 0;
                  // 有效播放区间起点：显式片段取 startSec；未设片段且 >30s 时为最后 30s 的起点
                  const start = userSegmented
                    ? anime.startSec
                    : el.duration > 30
                      ? Math.max(0, el.duration - 30)
                      : 0;
                  // 按有效时长动态计算开场/闭合时长：E = min(3, 46.4%D)，
                  // C = min(3, D−E)，保证闭合完成时刻 = 视频结束时刻
                  const d = Math.max(0.1, end - start);
                  const eSec = Math.min(OPEN_MAX_SEC, OPEN_RATIO * d);
                  const cSec = Math.min(CLOSE_MAX_SEC, d - eSec);
                  setTiming({
                    eMs: Math.round(eSec * 1000),
                    cMs: Math.round(Math.max(0.2, cSec) * 1000),
                  });
                }
                // 上报视频画面实际尺寸（natural 像素）：父级据此让元素容器贴合视频画面
                if (el && el.videoWidth > 0 && el.videoHeight > 0) {
                  onVideoSizeRef.current?.(el.videoWidth, el.videoHeight);
                }
                // 未显式设置片段且视频时长 >30s：默认播放最后 30 秒
                if (!userSegmented && el && Number.isFinite(el.duration) && el.duration > 30) {
                  const last = Math.max(0, el.duration - 30);
                  if (srcWithFragment(anime.videoSrc, last, el.duration) !== displaySrc) {
                    setDisplaySrc(srcWithFragment(anime.videoSrc, last, el.duration));
                  }
                }
                logVideoEvent("loadedmetadata");
              }}
              onCanPlay={() => {
                logVideoEvent("canplay");
                videoRef.current?.play?.().catch((e) => {
                  console.warn("[展示] 入场视频 play() 被拒绝", (e as Error)?.message || e);
                });
                // 自动播放可能被静音策略以外的情况拒绝：启动守护，避免停在首帧永久占画布
                startPlayGuard();
              }}
              onTimeUpdate={() => {
                const el = videoRef.current;
                if (!el) return;
                const end = endSecRef.current;
                if (end <= 0) return;
                // 到达闭合起点（视频结束前 C 秒）：一次性启动闭合擦除动画（仅黑幕闭合模式）
                if (
                  endingMode === "curtain" &&
                  !closingRef.current &&
                  el.currentTime >= end - timing.cMs / 1000 - CLOSE_LEAD
                ) {
                  closingRef.current = true;
                  setClosing(true);
                }
                // 视频结尾渐隐：进入结束前 1s 一次性触发（CSS transition 线性淡出到 0）
                if (!videoFadingRef.current && end > VIDEO_FADE_SEC && el.currentTime >= end - VIDEO_FADE_SEC) {
                  videoFadingRef.current = true;
                  setVideoFading(true);
                }
                // 兜底结束检测：媒体片段在部分内核下暂停而不派发 ended，
                // currentTime 到达结束点附近时同样进入收尾（保持1s/淡出1s/释放）
                if (el.currentTime >= end - END_EPSILON) {
                  handleEnd();
                }
              }}
              onWaiting={() => logVideoEvent("waiting")}
              onStalled={() => logVideoEvent("stalled")}
              onProgress={() => logVideoEvent("progress")}
              onEnded={handleEnd}
              onError={handleVideoError}
            />
          </div>
          {fx && endingMode === "curtain" && (
            <>
              {/* 黑幕：上下各一条，只在中间固定区域内随擦除前沿长起（形状与之前一致）。
                  整体套当前档位的中心不透明度 → 黑幕均匀半透明、透出下层画面。 */}
              <div className="anime-curtain-group" style={curtainStyle}>
                <div className="anime-curtain anime-curtain-top" aria-hidden="true" />
                <div className="anime-curtain anime-curtain-bottom" aria-hidden="true" />
              </div>
              {/* 头像：前沿扫过黑幕区域后才显示，收尾随根容器一起淡出。
                  昵称不在此处——它由黑幕自身的「镂空 mask」抠出（见 curtainStyle），
                  形成真实的透明文字形状，直接透出下层直播画面。 */}
              <div
                className="anime-content"
                style={{ maskImage: contentMask, WebkitMaskImage: contentMask }}
              >
                <AnimeAvatar key={anime.user.face} face={anime.user.face} uname={anime.user.uname} />
              </div>
            </>
          )}
          {fx && endingMode === "portal" && portalActive && (
            <>
              {/* 传送门火圈画布：PortalFX 按舞台盒尺寸绘制完整序列 */}
              <canvas ref={portalCanvasRef} className="anime-portal-canvas" />
              {/* 头像：随火圈开合进度 circle 裁剪放大 + 渐显（圆心与火圈一致） */}
              <AnimeAvatar
                key={anime.user.face}
                face={anime.user.face}
                uname={anime.user.uname}
                style={{
                  width: `calc(76 * var(--u))`,
                  height: `calc(76 * var(--u))`,
                  top: `calc(50% - 16 * var(--u))`,
                  clipPath: `circle(${(portalOpen * 50).toFixed(2)}% at 50% 50%)`,
                  opacity: portalOpen,
                }}
              />
              {/* 昵称胶囊：与头像同步渐显（portalOpen 驱动） */}
              <div
                className="anime-name-pill"
                style={{
                  top: `min(calc(50% + 46 * var(--u)), calc(100% - 56 * var(--u)))`,
                  opacity: portalOpen,
                  ...namePillStyle,
                }}
              >
                {anime.user.uname}
              </div>
            </>
          )}
          {fx && endingMode === "fade" && endingPhase && (
            // 渐显渐隐：整组挂载即播 show 动画（both 从 0 起），hide 换动画名端点衔接
            <div
              className="anime-end-fade"
              style={{
                animation:
                  endingPhase === "show"
                    ? `anime-end-show ${ENDING_FADE_MS}ms ease both`
                    : `anime-end-hide ${ENDING_FADE_MS}ms ease both`,
              }}
            >
              <AnimeAvatar key={anime.user.face} face={anime.user.face} uname={anime.user.uname} className="anime-avatar-bordered" />
              <div className="anime-name-pill" style={{ top: `calc(50% + 10 * var(--u))`, ...namePillStyle }}>
                {anime.user.uname}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center px-12 text-center text-black/60 text-[40px] font-bold leading-relaxed">
          {loadError
            ? "视频加载失败"
            : "你还没有配置任何入场动画，先在“入场动画”卡片中添加，才能看到动画播放效果"}
        </div>
      )}
      {/* 声音开关：autoplay 默认静音以兼容无声自动播放；点此可开启/关闭视频声音。
          仅编辑布局页（loop 预览模式）渲染——浏览器源里出现会被录进直播画面，禁止显示。 */}
      {loop && anime.videoSrc && !loadError && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()} // 编辑模式下不触发外层拖动，仅切换声音
          onClick={() => {
            const next = !muted;
            // 解除静音瞬间触发 play()：浏览器自动播放策略要求用户交互后才能带声播放
            if (!next) videoRef.current?.play?.().catch(() => {});
            onMutedChange?.(next);
          }}
          title={muted ? "开启声音" : "关闭声音"}
          className="absolute right-4 bottom-4 z-[2] w-32 h-32 rounded-full bg-black/40 text-white
            flex items-center justify-center pointer-events-auto opacity-40 hover:opacity-90 transition-opacity"
        >
          <VolumeIcon muted={muted} className="w-16 h-16" />
        </button>
      )}
    </div>
  );
}
