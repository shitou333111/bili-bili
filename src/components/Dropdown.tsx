"use client";

import { useState, useRef, useEffect } from "react";

/**
 * 自定义下拉框（替代原生 <select>）
 *
 * 原生 <select> 在移动端体验不佳：
 *   - iOS 弹出系统滚轮选择器，位置固定不跟随，且有"闪现/移动"感；
 *   - Android 弹出全屏对话框，占满屏幕、无法点击空白收起。
 *
 * 本组件改为按钮 + 绝对定位列表：
 *   - 列表紧贴触发按钮下方出现，随按钮位置定位（无闪现）；
 *   - 列表约束在视口内（四周留边距），不铺满屏幕，内部滚动；
 *   - 点击列表外任意处收起。
 */

interface DropdownOption {
  value: string;
  label: React.ReactNode;
}

interface DropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  className?: string;
  placeholder?: string;
}

export default function Dropdown({ value, onChange, options, className = "", placeholder = "请选择" }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);

  const openList = () => {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    // 列表宽度取触发按钮与视口的较小值（最小 150，保证四周留边距且不过窄）
    const width = Math.min(Math.max(rect.width, 150), window.innerWidth - margin * 2);
    let top = rect.bottom + 4;
    // 预估列表高度（受 max-height 限制），若超出视口则向上弹出
    const estimatedH = Math.min(options.length * 40 + 16, 280);
    if (top + estimatedH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - estimatedH - 4);
    }
    setPos({ top, left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)), width });
    setOpen(true);
  };

  // 点击外部收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open]);

  // 页面滚动/尺寸变化时关闭，避免位置错乱。
  // 注意：下拉列表自身内部滚动（overflow-y-auto）也会冒泡 scroll 事件，需忽略，否则"一滑动就消失"。
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      // 滚动发生在下拉列表内部 → 不关闭
      if (listRef.current && listRef.current.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        className={`relative flex items-center justify-between gap-1 text-left ${className}`}
      >
        <span className="truncate">{current ? current.label : placeholder}</span>
        <svg className="w-3 h-3 flex-shrink-0 text-black/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && pos && (
        <div
          ref={listRef}
          className="fixed z-[70] max-h-[280px] overflow-y-auto rounded-lg border border-black/10 bg-white shadow-xl"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`block w-full px-3.5 py-2.5 text-left text-[13px] transition ${
                o.value === value ? "bg-[#1f1c17] text-white" : "text-black/70 hover:bg-black/5"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
