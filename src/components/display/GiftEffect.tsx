"use client";

/**
 * 礼物特效播放（画布侧）—— B站特效视频为"RGB 画面区 + 灰度透明区"拼接，需在 canvas 上
 * 按配套 JSON 的 rgbFrame/aFrame 合成 alpha 后播放（与模拟器 AlphaVideoPlayer 的处理完全一致）。
 *
 * 画布运行在外部浏览器（直播姬「浏览器源」），特效视频为 B站 CDN 远程直链（带 CORS），
 * 必须 crossOrigin="anonymous" 才能 getImageData 读像素做 alpha 合成。
 *
 * 时长策略：
 *  - 加载兜底：仅"尚未开始播放"时生效（8s 内没开始播即结束），开始播放后立即清除，不截断播放；
 *  - 播放时长：默认播放完整特效；仅当后面已排队的特效（queued）时才限时，避免队列积压。
 *
 * 播放结束 / 加载失败 → 淡出并回调 onEnd，由父级出队播放下一个。
 * canvas 内在分辨率按特效输出尺寸（info.w/info.h × scale）设置，CSS 铺满父容器（父容器按
 * 画布目标宽度等比设定），因此缩放/拖动（MovableBox transform）下依然清晰。
 */
import { useEffect, useRef, useState } from "react";
import type { GiftEffectFrameConfig } from "@/lib/display/types";

/** 加载兜底：超时仍未开始播放则结束，避免永久占用画布 */
const LOAD_TIMEOUT_MS = 8000;
/** 后面有特效排队时的最长播放时长（避免长特效把队列堵住） */
const MAX_QUEUED_PLAY_MS = 8000;

export default function GiftEffect({
  src,
  config,
  onEnd,
  onMeasure,
  queued = false,
}: {
  src: string;
  config: GiftEffectFrameConfig | null;
  onEnd: () => void;
  /** 特效输出尺寸（natural 像素）上报：无配套 JSON 时父级据此算默认摆放位置 */
  onMeasure?: (w: number, h: number) => void;
  /** 后面是否已有排队的特效：有则限时播放，否则播放完整特效 */
  queued?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(true);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;
  // 排队状态（供播放中动态判断）与"限时播放"计时器
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  const armCapRef = useRef<(() => void) | null>(null);

  // 播放途中又有特效排队 → 立即启用限时播放（已超时则马上收尾）
  useEffect(() => {
    armCapRef.current?.();
  }, [queued]);

  useEffect(() => {
    setVisible(true);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 隐藏的 video 元素（不进 DOM）：作为特效视频的帧源
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;

    let ended = false;
    let raf: number | null = null;
    /** 开始播放的时间戳（0=尚未开始）；用于计算"限时播放"的剩余时长 */
    let startedAt = 0;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (ended) return;
      ended = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      setVisible(false);
      setTimeout(() => onEndRef.current(), 300); // 等淡出动画（300ms）结束再通知父级
    };

    /**
     * 启/停"限时播放"：后面有排队特效时最多播 MAX_QUEUED_PLAY_MS，没有排队则不限时
     * （播放完整特效）。播放途中队列由空变有也会调用（见上方 queued 的 useEffect）。
     */
    const armCap = () => {
      if (capTimer) {
        clearTimeout(capTimer);
        capTimer = null;
      }
      if (!queuedRef.current || !startedAt) return;
      const remain = Math.max(0, MAX_QUEUED_PLAY_MS - (performance.now() - startedAt));
      capTimer = setTimeout(finish, remain);
    };
    armCapRef.current = armCap;

    const renderFrame = () => {
      if (ended) return;
      if (video.readyState < 2) {
        raf = requestAnimationFrame(renderFrame);
        return;
      }

      const info = config?.info;
      if (!info) {
        // 无配套 JSON：整段绘制（回退方案）
        const w = video.videoWidth || 720;
        const h = video.videoHeight || 720;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          onMeasureRef.current?.(w, h);
        }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(video, 0, 0, w, h);
      } else {
        const [rx, ry, rw, rh] = info.rgbFrame;
        const [ax, ay, aw, ah] = info.aFrame;
        const outW = Math.max(1, Math.round(info.w * (info.scale || 1)));
        const outH = Math.max(1, Math.round(info.h * (info.scale || 1)));
        if (canvas.width !== outW || canvas.height !== outH) {
          canvas.width = outW;
          canvas.height = outH;
          onMeasureRef.current?.(outW, outH);
        }

        // 1. 绘制 RGB 画面区
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(video, rx, ry, rw, rh, 0, 0, outW, outH);

        // 2. 取灰度透明区的 R 通道作为 alpha，双线性采样到输出尺寸
        try {
          const alphaCanvas = document.createElement("canvas");
          alphaCanvas.width = aw;
          alphaCanvas.height = ah;
          const aCtx = alphaCanvas.getContext("2d");
          if (aCtx) {
            aCtx.drawImage(video, ax, ay, aw, ah, 0, 0, aw, ah);
            const alphaData = aCtx.getImageData(0, 0, aw, ah);
            const frameData = ctx.getImageData(0, 0, outW, outH);
            for (let y = 0; y < outH; y++) {
              for (let x = 0; x < outW; x++) {
                const srcX = Math.floor((x / outW) * aw);
                const srcY = Math.floor((y / outH) * ah);
                const alpha = alphaData.data[(srcY * aw + srcX) * 4];
                frameData.data[(y * outW + x) * 4 + 3] = alpha;
              }
            }
            ctx.putImageData(frameData, 0, 0);
          }
        } catch {
          /* 跨域读像素失败：保持 RGB 原样绘制 */
        }
      }

      raf = requestAnimationFrame(renderFrame);
    };

    const onLoaded = () => {
      video.play().catch(() => finish());
      startedAt = performance.now();
      // 已开始播放：立即撤销加载兜底（否则会把长特效在 8s 处截断），改由"排队限时"接管
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      armCap();
      raf = requestAnimationFrame(renderFrame);
    };

    video.addEventListener("ended", finish);
    video.addEventListener("error", finish);
    video.addEventListener("loadedmetadata", onLoaded);
    video.load();

    loadTimer = setTimeout(finish, LOAD_TIMEOUT_MS);

    return () => {
      ended = true;
      if (loadTimer) clearTimeout(loadTimer);
      if (capTimer) clearTimeout(capTimer);
      armCapRef.current = null;
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", finish);
      video.removeEventListener("loadedmetadata", onLoaded);
      if (raf) cancelAnimationFrame(raf);
      video.pause();
      video.src = "";
    };
  }, [src, config]);

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-full transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
    />
  );
}