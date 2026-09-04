"use client";

/**
 * 布局编辑模态框：在主播 APP 内嵌一个同源 iframe 加载展示编辑页（/display?mode=edit），
 * 替代旧的独立 Tauri 展示窗口（浏览器源架构下不再有画布窗口）。用于直播姬「浏览器源」透
 * 明叠加前的视觉编排。
 *
 * 顶部可切换横/竖屏，分别调整两套独立布局：切换后经 WS 下发 {type:"orientation"}，
 * 主进程持久化并广播，iframe 内的画布自动翻转，同时本组件按新朝向算出新的 iframe 展示尺寸。
 *
 * iframe 同源（http://127.0.0.1:<port>/display?mode=edit），内部走与浏览器源一致的 WS，
 * 拖动/缩放经 {type:"saveLayout"} 落盘 .data/display-config.json。为把大画布塞进模态框，
 * 用 CSS transform scale 等比缩放展示（指针坐标会被浏览器折算进 iframe 文档坐标系，
 * 因此内部拖动仍按 1:1 画布坐标精确换算）。
 */
import { useEffect, useRef, useState } from "react";
import { CANVAS_SIZE } from "./DisplayCanvas";
import type { ScreenOrientation } from "@/lib/display/types";
import { DESKTOP_TITLEBAR_H } from "@/lib/layout";

/** 底部托盘（iOS 悬浮胶囊 Dock）：容器 bottom 16px + 胶囊高约 47px → 顶边距窗口底部约 63px */
const DOCK_TOP_PX = 63;

interface Props {
  /** 本地浏览器源服务端口（127.0.0.1:<port>） */
  port: number;
  /** 当前朝向（横屏/竖屏），切换后 iframe 尺寸随之变化 */
  orientation: ScreenOrientation;
  onOrientationChange: (v: ScreenOrientation) => void;
  onClose: () => void;
}

export default function DisplayEditModal({
  port,
  orientation,
  onOrientationChange,
  onClose,
}: Props) {
  // 计算可用区域：容纳 iframe 的弹性盒子实测宽高，据此把画布等比缩到能完整放入
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setArea({ w: rect.width, h: rect.height });
    });
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 顶部胶囊条高度（内容撑开自适应），供画布上边界取「胶囊条 + 10px」
  const pillRef = useRef<HTMLDivElement | null>(null);
  const [pillH, setPillH] = useState(0);
  useEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setPillH(r.height);
    });
    ro.observe(el);
    setPillH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const canvas = CANVAS_SIZE[orientation];
  // 等比缩放到内部可用区域（防 0/极小导致除零）
  const scale =
    area.w > 0 && area.h > 0
      ? Math.min(area.w / canvas.w, area.h / canvas.h)
      : 1;
  // 缩放后 iframe 真正占据的版块尺寸（layout box），供后续布局项排布
  const wrapW = Math.floor(canvas.w * scale);
  const wrapH = Math.floor(canvas.h * scale);

  // 画布区域上边界 = 标题栏(36px)+10 + 胶囊条高 +20（上间隔）；
  // 下边界 = 托盘顶(63px)+0（贴托盘）。
  // 对齐：横屏竖直居中；竖屏贴底（窄窗口宽度受限时多余空间留在上方，避免下边距过大）。
  const canvasTop = DESKTOP_TITLEBAR_H + 10 + pillH + 20;
  const canvasBottom = DOCK_TOP_PX + 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md">
      {/* 顶部悬浮标题栏：标题栏(36px)下方 10px；宽度 w-max 由内容撑开、文字禁止换行，任何情况下不挤压 */}
      <div
        ref={pillRef}
        className="absolute left-1/2 -translate-x-1/2 z-20 flex w-max items-center gap-3 rounded-full bg-white/95 py-0.5 pl-5 pr-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.35)] ring-1 ring-black/5"
        style={{ top: DESKTOP_TITLEBAR_H + 10 }}
      >
        <h3 className="text-sm font-bold text-black/75 whitespace-nowrap">布局调整 · 缩放/拖动</h3>
        <div className="mx-0.5 h-6 w-px shrink-0 bg-black/10" />
        {/* 横屏 / 竖屏 分段：分别编辑两套独立布局 */}
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-black/5 p-1">
          {(
            [
              { key: "landscape", label: "横屏" },
              { key: "portrait", label: "竖屏" },
            ] as Array<{ key: ScreenOrientation; label: string }>
          ).map((o) => {
            const active = orientation === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => onOrientationChange(o.key)}
                className={`relative flex shrink-0 items-center gap-1.5 rounded-full px-4 py-1.5 transition ${
                  active
                    ? "bg-[#1f1c17] text-white shadow"
                    : "text-black/55 hover:bg-black/5"
                }`}
              >
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
                <span className="text-xs font-medium leading-none whitespace-nowrap">{o.label}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="flex items-center justify-center w-8 h-8 rounded-full bg-black/5 text-black/60 transition hover:bg-red-500 hover:text-white text-base leading-none shrink-0"
        >
          ×
        </button>
      </div>

      {/* 悬浮画布：上边界距胶囊条 20px，下边界贴托盘；横屏竖直居中、竖屏贴底 */}
      <div
        ref={areaRef}
        className={`absolute inset-x-2 flex justify-center ${orientation === "portrait" ? "items-end" : "items-center"}`}
        style={{ top: canvasTop, bottom: canvasBottom }}
      >
        <div
          className="relative rounded-xl overflow-hidden shadow-[0_20px_70px_rgba(0,0,0,0.55)] ring-1 ring-black/25"
          style={{ width: wrapW, height: wrapH }}
          data-testid="display-edit-frame"
        >
          <iframe
            title="展示布局调整"
            src={`http://127.0.0.1:${port}/display?mode=edit`}
            className="absolute top-0 left-0 bg-white"
            style={{
              width: canvas.w,
              height: canvas.h,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        </div>
      </div>
    </div>
  );
}