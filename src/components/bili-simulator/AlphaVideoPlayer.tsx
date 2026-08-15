"use client";

import { useEffect, useRef, useState } from "react";
import type { EffectConfig } from "./types";

interface AlphaVideoPlayerProps {
  src: string;
  config: EffectConfig | null;
  onEnded: () => void;
}

export default function AlphaVideoPlayer({ src, config, onEnded }: AlphaVideoPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // src 切换（队列中下一个特效）时重置可见，避免上个特效淡出后保持隐藏
    setVisible(true);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 创建隐藏的video元素
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;
    videoRef.current = video;

    let hasEnded = false;

    const handleEnded = () => {
      if (hasEnded) return;
      hasEnded = true;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setVisible(false);
      setTimeout(onEnded, 300);
    };

    const renderFrame = () => {
      if (hasEnded) return;
      if (video.readyState < 2) {
        rafRef.current = requestAnimationFrame(renderFrame);
        return;
      }

      const info = config?.info;
      if (!info) {
        // 没有配置，直接绘制整个视频（回退方案）
        canvas.width = video.videoWidth || 720;
        canvas.height = video.videoHeight || 1280;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      } else {
        const [rx, ry, rw, rh] = info.rgbFrame;
        const [ax, ay, aw, ah] = info.aFrame;
        const outW = Math.max(1, Math.round(info.w * (info.scale || 1)));
        const outH = Math.max(1, Math.round(info.h * (info.scale || 1)));

        canvas.width = outW;
        canvas.height = outH;

        // 1. 绘制RGB帧
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(video, rx, ry, rw, rh, 0, 0, outW, outH);

        // 2. 获取alpha帧数据并应用
        try {
          const alphaCanvas = document.createElement("canvas");
          alphaCanvas.width = aw;
          alphaCanvas.height = ah;
          const aCtx = alphaCanvas.getContext("2d");
          if (aCtx) {
            aCtx.drawImage(video, ax, ay, aw, ah, 0, 0, aw, ah);
            const alphaData = aCtx.getImageData(0, 0, aw, ah);
            const frameData = ctx.getImageData(0, 0, outW, outH);

            // 双线性采样alpha值到输出尺寸
            for (let y = 0; y < outH; y++) {
              for (let x = 0; x < outW; x++) {
                const srcX = Math.floor((x / outW) * aw);
                const srcY = Math.floor((y / outH) * ah);
                const srcIdx = (srcY * aw + srcX) * 4;
                const alpha = alphaData.data[srcIdx]; // 取R通道作为alpha
                const dstIdx = (y * outW + x) * 4;
                frameData.data[dstIdx + 3] = alpha;
              }
            }
            ctx.putImageData(frameData, 0, 0);
          }
        } catch (e) {
          // 跨域等问题导致无法读取像素，保持原样绘制
        }
      }

      rafRef.current = requestAnimationFrame(renderFrame);
    };

    video.addEventListener("ended", handleEnded);
    video.addEventListener("loadedmetadata", () => {
      video.play().catch(console.error);
      rafRef.current = requestAnimationFrame(renderFrame);
    });

    video.load();

    return () => {
      hasEnded = true;
      video.removeEventListener("ended", handleEnded);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      video.pause();
      video.src = "";
    };
  }, [src, config, onEnded]);

  return (
    <div
      className={`absolute inset-0 z-50 flex items-center justify-center transition-opacity duration-300 pointer-events-none ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-auto"
        style={{ imageRendering: "auto", maxHeight: "100%" }}
      />
    </div>
  );
}
