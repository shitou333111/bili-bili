"use client";

import { type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 全屏模态框内图表的固定高度（竖直居中，不随窗口尺寸变化） */
const CHART_HEIGHT = 200;

/**
 * 图表全屏模态框：fixed inset-0 覆盖整个软件视口（宽度跟随软件窗口，而非所在页面宽度，
 * 与「编辑布局」模态框一致）。内容由外部传入的 render 函数按固定高度 500px 渲染，竖直居中。
 */
export default function ChartFullscreenModal({
  open,
  onClose,
  title,
  render,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  render: (height: number) => ReactNode;
}) {
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={onClose}>
      <div
        className="flex max-h-full flex-col rounded-2xl border border-black/10 bg-[#faf9f6] p-3 shadow-2xl"
        style={{ width: "calc(100vw - 32px)", maxWidth: "calc(100vw - 32px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="text-sm font-semibold">{title}</div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/5 hover:text-black/80"
            title="关闭"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 overflow-hidden">{render(CHART_HEIGHT)}</div>
      </div>
    </div>,
    document.body
  );
}
