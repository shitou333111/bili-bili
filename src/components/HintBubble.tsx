"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import BulbIcon from "@/components/BulbIcon";

/**
 * 黄色灯泡 + 浮层说明。
 * 点击灯泡展开；再次点击灯泡、或点击页面其它任意位置都会收起。
 */
export default function HintBubble({
  children,
  label = "说明",
  align = "right",
  className = "",
}: {
  children: ReactNode;
  label?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-6 w-6 items-center justify-center rounded-full transition ${
          open ? "bg-amber-300/60" : "hover:bg-amber-200/50"
        }`}
      >
        <BulbIcon className="h-4 w-4" />
      </button>
      {open && (
        <div
          className={`absolute top-7 z-30 w-64 rounded-xl border border-black/10 bg-white p-2.5 text-[11px] leading-relaxed text-black/60 shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
