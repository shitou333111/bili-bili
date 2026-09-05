"use client";

/**
 * 高级用户自定义入场动画：全画布播放该用户配置的本地视频（Tauri asset 协议
 * http://asset.localhost/...，由 convertFileSrc 生成）。播放结束后淡出释放画布；
 * 测试循环模式（loop）视频循环播放。
 *
 * 加载方式：直接作为 <video> 的 src。不要用 fetch 拉取——asset 协议的响应不带
 * CORS 头，fetch 会报 "Failed to fetch"，而媒体栈播放 <video> 不需要 CORS，
 * 因此直接给 src 即可稳定播放。
 *
 * 结束判定：onEnded 是主信号，但媒体片段（#t=start,end）在部分内核（含 WebView2/
 * Chromium）下会在片段末尾"暂停"而不派发 ended，导致视频永久停在最后一帧不消失。
 * 因此叠加 timeupdate 兜底：currentTime 接近片段结束点（显式结束秒 / 未设片段时为
 * 视频时长）时同样触发淡出，保证画布必然释放。handleEnd 幂等，重复触发只执行一次。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DisplayEvent } from "@/lib/display/types";
import { srcWithFragment } from "@/lib/display/video";

/** 播放片段结束检测容差（秒）：timeupdate 约 4Hz，留出一次触发间隔的余量 */
const END_EPSILON = 0.3;

export default function VideoOverlay({
  anime,
  onEnd,
  loop = false,
  onVideoSize,
}: {
  anime: Extract<DisplayEvent, { type: "anime" }>;
  onEnd: () => void;
  /** 测试循环模式：视频循环播放，不自动释放（供"测试中"布局调整） */
  loop?: boolean;
  /** 视频画面实际尺寸（natural 像素，loadedmetadata 后回调）——父级据此让元素贴合视频画面 */
  onVideoSize?: (w: number, h: number) => void;
}) {
  const [fadeOut, setFadeOut] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 静音状态：默认 muted 以兼容浏览器/CEEF 的无声自动播放限制（autoplay 默认被静音或被拒绝）。
  // 用户可点右下角声音按钮解除静音——声音在 Live 直播姬 CEF 中自动播放常无声音，需交互兜底。
  const [muted, setMuted] = useState(true);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onVideoSizeRef = useRef(onVideoSize);
  onVideoSizeRef.current = onVideoSize;
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  // 淡出幂等标记：ended 与 timeupdate 可能先后触发，只执行一次淡出+释放
  const endingRef = useRef(false);
  // 播放代际：每个新的 anime 事件（即使 videoSrc 相同）都递增，强制复位状态并重挂载
  // 视频，避免同一视频连续触发时被上一次的 ended/淡出状态卡住、第二次不播也不消失
  const [gen, setGen] = useState(0);

  // 新的 anime 事件 → 递增代际（初始挂载也触发一次，无副作用）
  useEffect(() => {
    setGen((g) => g + 1);
  }, [anime]);

  const handleEnd = useCallback(() => {
    if (loop) {
      setFadeOut(false);
      return;
    }
    if (endingRef.current) return;
    endingRef.current = true;
    setFadeOut(true);
    setTimeout(() => onEndRef.current(), 600);
  }, [loop]);

  useEffect(() => {
    setFadeOut(false);
    setLoadError(false);
    endingRef.current = false;
    endSecRef.current = 0;
    // 视频变更/新一轮播放时复位播放源（回到用户片段或整段初始，等待 loadedmetadata 再决定是否截尾 30s）
    setDisplaySrc(
      userSegmented ? srcWithFragment(anime.videoSrc, anime.startSec, anime.endSec) : anime.videoSrc,
    );
    if (!anime.videoSrc) {
      console.log("[展示] 未配置视频，videoSrc 为空");
      return;
    }
    // 循环模式常驻画布；否则视频无法加载/播放时约 6s 兜底释放（视频成功加载后清除），避免永久遮挡
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

  return (
    // 画布本身有指定背景色（#B7EBA4），不叠加黑底遮罩；等比缩放后视频四周留出的
    // 空白直接透出画布背景，避免出现黑边。
    <div
      className={`absolute inset-0 z-[1] transition-opacity duration-700 ${
        fadeOut ? "opacity-0" : "opacity-100"
      } pointer-events-none`}
    >
      {anime.videoSrc && !loadError ? (
        <video
          ref={videoRef}
          key={`${displaySrc}|${gen}`}
          src={displaySrc}
          autoPlay
          muted={muted}
          loop={loop}
          playsInline
          className="w-full h-full object-contain"
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
            // 兜底结束检测：媒体片段在部分内核下暂停而不派发 ended，
            // currentTime 到达片段结束点附近时同样触发淡出释放
            const el = videoRef.current;
            if (!el || loop) return;
            const end = endSecRef.current;
            if (end > 0 && el.currentTime >= end - END_EPSILON) {
              handleEnd();
            }
          }}
          onWaiting={() => logVideoEvent("waiting")}
          onStalled={() => logVideoEvent("stalled")}
          onProgress={() => logVideoEvent("progress")}
          onEnded={handleEnd}
          onError={handleVideoError}
        />
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
          {muted ? "🔇" : "🔊"}
        </button>
      )}
    </div>
  );
}
