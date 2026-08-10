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
 *
 * 定位说明：列表用 position:fixed 相对视口定位（页面主滚动容器已移除 transform，
 * 不再会破坏 fixed 定位，因此无需再通过 Portal 挂到 body）。
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

/**
 * 测量"最长选项"的渲染宽度（保证列表内所有选项单行显示、不换行）。
 * 用隐藏 span 实测文本宽度；若 label 不是纯字符串则取其文本内容。
 */
function measureOptionsWidth(options: DropdownOption[]): number {
  try {
    const span = document.createElement("span");
    span.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap;font-size:13px;padding:0 14px;";
    document.body.appendChild(span);
    let max = 0;
    for (const o of options) {
      const label = o.label;
      span.textContent = typeof label === "string" ? label : String(label ?? "");
      max = Math.max(max, span.offsetWidth);
    }
    document.body.removeChild(span);
    // 加上选项内边距(28px)与右侧箭头/间距(~16px)
    return max + 44;
  } catch {
    return 0;
  }
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
    // 宽度：取"最长选项"的宽度（保证所有选项不换行），再与按钮宽度、最小宽度比较，最终受视口限制
    const maxOptionWidth = measureOptionsWidth(options);
    const width = Math.min(Math.max(rect.width, maxOptionWidth, 160), window.innerWidth - margin * 2);
    let top = rect.bottom + 4;
    // 预估列表高度（受 max-height 限制），若超出视口则向上弹出
    const estimatedH = Math.min(options.length * 44 + 16, 300);
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
      // resize/scroll 等事件的 target 可能是 window/document，非 Node，需先判断再 contains
      const t = e.target;
      if (t instanceof Node && (btnRef.current?.contains(t) || listRef.current?.contains(t))) return;
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
      // resize 的 target 是 window（非 Node）；scroll 的 target 也可能是 document/window。
      // 先判断 isNode 再调用 contains，否则会抛 "parameter 1 is not of type 'Node'"。
      const t = e.target;
      // 滚动发生在下拉列表内部 → 不关闭
      if (t instanceof Node && listRef.current?.contains(t)) return;
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
          className="fixed z-[70] max-h-[300px] overflow-y-auto rounded-lg border border-black/10 bg-white shadow-xl"
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
              className={`block w-full whitespace-nowrap px-4 py-2.5 text-left text-[13px] transition ${
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
