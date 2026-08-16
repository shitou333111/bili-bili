"use client";

/**
 * 直播流背景播放组件
 *
 * 使用 hls.js 加载 B站 HLS 直播流，在 <video> 元素中播放。
 * 定位在模拟器页面最底层（z-0），作为背景画面。
 * 未开播或加载失败时显示渐变占位背景。
 */

import { useEffect, useRef, useState } from "react";
import { getLiveStreamUrl } from "./liveStream";

interface Props {
  roomId: number;
}

export default function LiveStreamBackground({ roomId }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const [status, setStatus] = useState<"loading" | "playing" | "error">("loading");
  // 是否为竖屏直播流（高/宽 > 1.2，严格判定，避免接近方形的流被误判）。竖屏时填满整个屏幕（含通知栏与底部安全区）
  const [portrait, setPortrait] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 切换直播间时重置方向判断
    setPortrait(false);

    async function init() {
      if (!roomId || !videoRef.current) return;
      setStatus("loading");

      try {
        const streamUrl = await getLiveStreamUrl(roomId);
        if (cancelled || !streamUrl) {
          if (!cancelled) setStatus("error");
          return;
        }

        const video = videoRef.current;
        if (!video) return;

        // 原生 HLS 支持（Safari/iOS）
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = streamUrl;
          video.muted = false;
          video.play().catch(() => {
            // 自动播放被阻止时降级为静音播放
            video.muted = true;
            video.play().catch(() => {});
          });
          if (!cancelled) setStatus("playing");
          return;
        }

        // 使用 hls.js
        const Hls = (await import("hls.js")).default;
        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            maxBufferLength: 10,
          });
          hlsRef.current = hls;
          hls.loadSource(streamUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            video.muted = false;
            video.play().catch(() => {
              // 自动播放被阻止时降级为静音播放
              video.muted = true;
              video.play().catch(() => {});
            });
            setStatus("playing");
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setStatus("error");
            }
          });
        } else {
          setStatus("error");
        }
      } catch (e) {
        console.error("LiveStreamBackground error:", e);
        if (!cancelled) setStatus("error");
      }
    }

    init();

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.src = "";
      }
    };
  }, [roomId]);

  return (
    <div className="absolute inset-0 z-0 overflow-hidden bg-[#1a1a2e]">
      {/* 直播视频流：竖屏时填满整个容器（含安全区），横屏时保持宽度对应页面宽度、高度按比例自适应 */}
      <video
        ref={videoRef}
        className={portrait ? "absolute inset-0 w-full h-full object-cover" : "absolute left-0 w-full object-contain"}
        style={portrait ? undefined : { top: "100px" }}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          // 严格竖屏判定：高/宽 > 1.2 才算竖屏，接近方形的流不铺满全屏
          if (v.videoWidth && v.videoHeight) setPortrait(v.videoHeight / v.videoWidth > 1.2);
        }}
        autoPlay
        playsInline
        loop
      />

      {/* 加载中 / 未开播 时的渐变占位 */}
      {status !== "playing" && (
        <div className="absolute inset-0 bg-gradient-to-b from-[#2B1F2B] via-[#1a1a2e] to-[#0f0f1a] flex items-center justify-center">
          {status === "loading" && (
            <div className="text-white/40 text-sm flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-white/30 border-t-white/60 rounded-full animate-spin" />
              正在连接直播流...
            </div>
          )}
          {status === "error" && (
            <div className="text-white/30 text-xs text-center">
              <div className="mb-1">📡</div>
              直播未开播或连接失败
            </div>
          )}
        </div>
      )}

      {/* 半透明遮罩，让上层内容更清晰 */}
      <div className="absolute inset-0 bg-black/30" />
    </div>
  );
}
