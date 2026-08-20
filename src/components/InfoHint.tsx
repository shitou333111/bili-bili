"use client";

import { useState } from "react";

/**
 * 行内提示图标（?）：点击后显示浅色小弹层说明（macOS 风格浅底黑字）。
 * align="right" 用于右侧对齐（ml-auto）的场景，弹层向左展开避免超出屏幕/卡片。
 */
export default function InfoHint({
  text,
  align = "left",
}: {
  text: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-3.5 h-3.5 rounded-full bg-black/10 text-black/40 text-[9px] flex items-center justify-center hover:bg-black/20 hover:text-black/60 transition-colors cursor-pointer"
        title="点击查看说明"
        aria-label="提示"
      >
        ?
      </button>
      {open && (
        <span
          className={`absolute top-full mt-1.5 z-50 w-56 bg-white border border-black/10 rounded-lg shadow-lg px-3 py-2 text-xs text-black/70 leading-relaxed ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {text}
        </span>
      )}
    </span>
  );
}
