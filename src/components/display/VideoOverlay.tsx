"use client";

/**
 * 高级用户自定义入场动画：全画布播放该用户配置的本地视频（Tauri asset 协议
 * http://asset.localhost/...，由 convertFileSrc 生成）。
 *
 * 播放分三个阶段（移植自测试页 ghost 变体；loop 编辑预览模式同样完整播放）：
 *  1. 开场：视频由中心一个实心大椭圆向外扩散渐显（CSS @property --anime-ripple，
 *     椭圆两轴均用盒百分比，与任意宽高比的视频同形，71% 半径盖住四角）。
 *  2. 结尾闭合：视频从自身上下边缘向中间被擦除成透明（--anime-curtain 0%→50%），
 *     **完全闭合的瞬间视频正好播放完毕**；黑幕只出现在中间固定区域（头像顶再上 20u ～
 *     昵称底再下 20u，u = 视频显示宽/328），前沿未进入区域时只是透明擦除、不露黑；
 *     头像+昵称只在被擦除的区域内随前沿显现（透明画布拿不到直播像素，昵称用黑底白字
 *     而非测试页的视频镂空）。
 *  3. 收尾：黑幕+头像+昵称保持 1s，再整体淡出 1s，随后释放画布；loop 预览模式则在
 *     淡出后复位并整段重播（编辑布局页可反复观察完整开合效果）。
 *
 * 整体透明度（取代旧的「视频边缘羽化」）：视频套一层按椭圆区域径向分布的 alpha 遮罩——
 * 圆心最实、越往周边 alpha 越小（越透明），下层直播画面可从四周透出；闭幕黑幕形状不变，
 * 整体均匀套用该档位的中心不透明度。档位由面板下发的 opacity prop（轻/中/重）决定，
 * 画布与布局编辑页共用同一份配置。
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
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ANIME_OPACITY_ALPHA, type AnimeOpacity, type DisplayEvent } from "@/lib/display/types";
import { srcWithFragment } from "@/lib/display/video";
import VolumeIcon from "@/components/VolumeIcon";

/** 播放片段结束检测容差（秒）：timeupdate 约 4Hz，留出一次触发间隔的余量 */
const END_EPSILON = 0.12;
/** 闭合起点提前量（秒）：抵消 timeupdate 采样间隔，保证闭合动画尽早启动 */
const CLOSE_LEAD = 0.05;
/** 闭合完成后黑幕+头像昵称保持时长（ms），随后整体淡出 */
const HOLD_MS = 1000;
/** 收尾整体淡出时长（ms） */
const FADE_MS = 1000;
/** 开场椭圆扩散时长上限/比例（测试页基准：5.602s 视频开场 2.602s ≈ 46.4%） */
const OPEN_MAX_SEC = 2.602;
const OPEN_RATIO = 0.464;
/** 闭合擦除时长上限（秒），短视频时取 D−E 以保证闭合完成=视频播完 */
const CLOSE_MAX_SEC = 3;
/** 测试页几何基准宽度（px）：该宽度下 1u = 1px */
const U_BASE_W = 328;

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆（与 EntryBadge 的 Avatar 同视觉） */
function AnimeAvatar({ face, uname }: { face: string; uname: string }) {
  const [failed, setFailed] = useState(!face);
  return (
    <div className="anime-avatar">
      {!failed && face ? (
        <img src={face} alt="" onError={() => setFailed(true)} />
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
}: {
  anime: Extract<DisplayEvent, { type: "anime" }>;
  onEnd: () => void;
  /** 预览循环模式：完整播放一遍开场/闭合/头像昵称/淡出后自动重播，不释放画布（编辑布局页常驻预览） */
  loop?: boolean;
  /** 视频画面实际尺寸（natural 像素，loadedmetadata 后回调）——父级据此让元素贴合视频画面 */
  onVideoSize?: (w: number, h: number) => void;
  /** 整体透明度档位：按椭圆区域径向分布（圆心最实、越往周边越透明），可透出下层直播画面 */
  opacity?: AnimeOpacity;
}) {
  const [fadeOut, setFadeOut] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 静音状态：默认 muted 以兼容浏览器/CEEF 的无声自动播放限制（autoplay 默认被静音或被拒绝）。
  // 用户可点右下角声音按钮解除静音——声音在 Live 直播姬 CEF 中自动播放常无声音，需交互兜底。
  const [muted, setMuted] = useState(true);
  // 结尾闭合是否已启动（驱动 --anime-curtain 的 close 动画一次性开始）
  const [closing, setClosing] = useState(false);
  // 舞台实际盒宽（px）：用于把测试页的 px 几何换算成与视频显示宽成比例的 --u
  const [boxW, setBoxW] = useState(0);
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

  // 新的 anime 事件 → 递增代际（初始挂载也触发一次，无副作用）
  useEffect(() => {
    setGen((g) => g + 1);
  }, [anime]);

  // 预览重播：同步复位收尾态（与 replaySeq 同批渲染，重挂载的新节点直接以
  // opacity-100/闭合动画未启动的状态出现，避免上一轮淡出/闭合状态残留）
  const restart = useCallback(() => {
    endTimersRef.current = [];
    setFadeOut(false);
    setClosing(false);
    endingRef.current = false;
    closingRef.current = false;
    setReplaySeq((s) => s + 1);
  }, []);

  const handleEnd = useCallback(() => {
    if (endingRef.current) return;
    endingRef.current = true;
    // 闭合完成（≈视频播完）→ 黑幕+头像昵称保持 1s → 整体淡出 1s
    // 预览模式：淡出后复位整段重播；正常播放：释放画布
    endTimersRef.current.push(
      setTimeout(() => {
        setFadeOut(true);
        endTimersRef.current.push(
          setTimeout(() => {
            if (loopRef.current) restart();
            else onEndRef.current();
          }, FADE_MS),
        );
      }, HOLD_MS),
    );
  }, [restart]);

  useEffect(() => {
    setFadeOut(false);
    setLoadError(false);
    setClosing(false);
    endingRef.current = false;
    closingRef.current = false;
    endSecRef.current = 0;
    endTimersRef.current.forEach(clearTimeout);
    endTimersRef.current = [];
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
  }, [anime.videoSrc, userSegmented, anime.startSec, anime.endSec, loop, handleEnd, gen]);

  // 测量舞台实际盒宽 → --u（几何缩放单位），ResizeObserver 应对布局拖动/缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setBoxW((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
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
  const videoMaskStyle: CSSProperties = { maskImage: wipeMask, WebkitMaskImage: wipeMask };

  // 整体透明度（取代旧的「视频边缘羽化」featherH/featherV）：一条按椭圆区域径向分布的 alpha
  // 遮罩——圆心最实、越往周边 alpha 越小 = 越透明，下层直播画面从视频四周透出。纯静态 CSS，
  // 由 GPU 合成器光栅化时做 alpha 混合，无逐帧计算；mask 只作用于 alpha，透明背景不会被染灰。
  // 渐变椭圆取 71%（≈ √2/2）：mask 渐变 stop 的百分比相对「该方向上椭圆边界到圆心的射线长度」
  // （不是相对盒子尺寸），因此 71% 时盒内四角恰落在 100% 处 → 四角 = edge alpha、圆心 = center
  // alpha；且椭圆两轴各按盒宽/盒高解析，该结论与画幅宽高比无关（横竖屏都是四角最透）。
  const oa = ANIME_OPACITY_ALPHA[opacity] ?? ANIME_OPACITY_ALPHA.medium;
  const alphaMask = `radial-gradient(ellipse 71% 71% at 50% 50%, rgba(0,0,0,${oa.center}) 0%, rgba(0,0,0,${oa.edge}) 100%)`;
  // 黑幕形状与之前完全一致（上下两条实心黑带铺满整宽），只是整体套当前档位的中心不透明度
  // → 黑幕按选中档位均匀半透明、透出下层画面；不挂径向渐变（否则两端被淡掉，看起来像“黑幕没了”）。
  const curtainStyle: CSSProperties = { opacity: oa.center };

  // 开场椭圆扩散 mask：中心实心大椭圆，横/纵半径都用 --anime-ripple（百分比分别按盒宽/盒高
  // 解析，故与视频同形）；内边缘收 6u 做轻微羽化。注意：渐变 stop 的百分比是相对「渐变射线」
  // 长度（= 椭圆边界在该方向的半径），不是相对盒子尺寸——所以边界处的 stop 必须写 100%（写
  // --anime-ripple 会把实心区缩到 ripple²，椭圆偏小、四角被遮）。椭圆外透明 → 开场渐显。
  const rippleMask =
    "radial-gradient(ellipse var(--anime-ripple) var(--anime-ripple) at 50% 50%, #000 0, #000 max(0%, calc(100% - 6 * var(--u))), transparent 100%)";
  // 开场扩散 ∩ 整体透明度：两层 mask 显式取交集（alpha 乘性叠加）。遮罩只挂在包视频的
  // 包裹层上，不加在 MovableBox/wrapper 上，否则编辑虚线框、缩放把手、声音按钮
  // 也会跟着透明（黑幕容器单独用 opacity 挂同一档位）。
  const rippleLayers = [rippleMask, alphaMask].join(", ");
  const wrapStyle: CSSProperties | undefined = fx
    ? {
        animation: `anime-ripple-open ${timing.eMs}ms cubic-bezier(.4,0,.2,1) both`,
        maskImage: rippleLayers,
        WebkitMaskImage: rippleLayers,
        maskComposite: "intersect",
        WebkitMaskComposite: "source-in",
      }
    : undefined;

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
              style={videoMaskStyle}
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
                  // 按有效时长动态计算开场/闭合时长：E = min(2.602, 46.4%D)，
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
                videoRef.current?.play?.().catch(() => {});
              }}
              onTimeUpdate={() => {
                const el = videoRef.current;
                if (!el) return;
                const end = endSecRef.current;
                if (end <= 0) return;
                // 到达闭合起点（视频结束前 C 秒）：一次性启动闭合擦除动画
                if (!closingRef.current && el.currentTime >= end - timing.cMs / 1000 - CLOSE_LEAD) {
                  closingRef.current = true;
                  setClosing(true);
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
          {fx && (
            <>
              {/* 黑幕：上下各一条，只在中间固定区域内随擦除前沿长起（形状与之前一致）。
                  整体套当前档位的中心不透明度 → 黑幕均匀半透明、透出下层画面。 */}
              <div className="anime-curtain-group" style={curtainStyle}>
                <div className="anime-curtain anime-curtain-top" aria-hidden="true" />
                <div className="anime-curtain anime-curtain-bottom" aria-hidden="true" />
              </div>
              {/* 头像+昵称：前沿扫过黑幕区域后才显示，收尾随根容器一起淡出 */}
              <div
                className="anime-content"
                style={{ maskImage: contentMask, WebkitMaskImage: contentMask }}
              >
                <AnimeAvatar face={anime.user.face} uname={anime.user.uname} />
                <div className="anime-name">
                  <span>{anime.user.uname}</span>
                </div>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center px-12 text-center text-black/60 text-[40px] font-bold leading-relaxed">
          {loadError
            ? "视频加载失败"
            : "你还没有配置任何入场动画，先在“入场动画”卡片中添加，才能看到动画播放效果"}
        </div>
      )}
      {/* 声音开关：autoplay 默认静音以兼容无声自动播放；点此可开启/关闭视频声音 */}
      {anime.videoSrc && !loadError && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()} // 编辑模式下不触发外层拖动，仅切换声音
          onClick={() =>
            setMuted((m) => {
              const next = !m;
              if (!next) videoRef.current?.play?.().catch(() => {});
              return next;
            })
          }
          title={muted ? "开启声音" : "关闭声音"}
          className="absolute right-4 bottom-4 z-[2] w-16 h-16 rounded-full bg-black/40 text-white text-[28px]
            flex items-center justify-center pointer-events-auto opacity-40 hover:opacity-90 transition-opacity"
        >
          <VolumeIcon muted={muted} className="w-8 h-8" />
        </button>
      )}
    </div>
  );
}
