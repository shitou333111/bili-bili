"use client";

import { useEffect, useRef, useState } from "react";
import BulbIcon from "@/components/BulbIcon";

/**
 * 行内提示图标（黄色灯泡）：点击后显示浅色小弹层说明（macOS 风格浅底黑字）。
 * align="right" 用于右侧对齐（ml-auto）的场景，弹层向左展开避免超出屏幕/卡片。
 * 点击页面其他任意区域自动收起。
 */
export default function InfoHint({
  text,
  align = "left",
}: {
  text: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 点击组件外部区域时收起（按钮自身的 toggle 在 onClick 里处理）
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex h-5 w-5 items-center justify-center rounded-full transition ${
          open ? "bg-amber-300/60" : "hover:bg-amber-200/50"
        }`}
        title="点击查看说明"
        aria-label="提示"
        aria-expanded={open}
      >
        <BulbIcon className="h-3.5 w-3.5" />
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
