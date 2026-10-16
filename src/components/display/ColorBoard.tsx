"use client";

/**
 * 二维拾色面板 —— 入场提示「设置样式」模态框用的极简取色控件。
 *
 * 交互：面板横向为色相（Hue 0~360），纵向为明暗（上=白 → 中=纯色 → 下=黑）。
 *      在面板上按下 / 拖动选色（pointer 捕获，松手结束），输出 #rrggbb。
 *      value 与 onChange 均以 #rrggbb 传递。
 * 状态：本地维持 { hue, t }（t 为纵向位置 0~1）；仅当外部 value 变化（切换编辑目标 /
 *      恢复默认 / 编码输入）时才反向同步，避免拖动时被外部值打断。
 *
 * 【取舍】只保留一个面板（不设独立的饱和度/明度滑条、不设透明度条）：
 *  - 纵向把「纯色 → 白 / 黑」一体化，可直接选到粉彩与深色；
 *  - 无彩色（纯白 #fff 落在左上、纯黑 #000 落在左下）因色相无定义会被归到 hue=0，
 *    视觉上仍表现为白/黑（因为该点的 s/v 决定），不影响观感；
 *  - 需要精确某色时，用每行右侧的编码输入框直接输入十六进制即可。
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** HSV → #rrggbb（h: 0~360，s/v: 0~1） */
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const hp = ((((h % 360) + 360) % 360) / 60);
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = v - c;
  const to = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n + m)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** #rrggbb / #rgb → HSV（h: 0~360；灰阶时 h 返回 0；非法回退 h=0,s=1,v=1） */
function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const raw = String(hex || "").trim().replace("#", "");
  const n = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return { h: 0, s: 1, v: 1 };
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    h = (h % 360 + 360) % 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** HSV → 面板纵向位置 t（0=顶端白，0.5=中段纯色，1=底端黑） */
function svToT(s: number, v: number): number {
  return v >= 1 - 1e-6 ? s / 2 : 1 - v / 2;
}

/** 面板纵向位置 t → { s, v }（上半降饱和到白，下半降明度到黑） */
function tToSv(t: number): { s: number; v: number } {
  const c = Math.min(1, Math.max(0, t));
  if (c <= 0.5) return { s: c * 2, v: 1 };
  return { s: 1, v: (1 - c) * 2 };
}

/** 色相彩虹（0°→360° 一圈，红→黄→绿→青→蓝→品→红） */
const SPECTRUM =
  "linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%)";
/** 明暗叠层：顶端叠白（→白），中段透明（→纯色），底端叠黑（→黑）。
 *  中段必须用 CSS `transparent`（= 透明黑 rgba(0,0,0,0)）而非 rgba(255,255,255,0)：
 *  下半段由"透明黑 → 纯黑"插值，才是纯黑透明度的渐变；若用透明白，下半段会插值成
 *  "白 50%"，底端发灰而非变黑。 */
const LIGHTNESS = "linear-gradient(to bottom,#fff 0%,transparent 50%,#000 100%)";

interface Props {
  /** 当前颜色（#rrggbb） */
  value: string;
  /** 取色回调（#rrggbb） */
  onChange: (hex: string) => void;
}

export default function ColorBoard({ value, onChange }: Props) {
  const [hue, setHue] = useState(() => hexToHsv(value).h);
  const [t, setT] = useState(() => {
    const c = hexToHsv(value);
    return svToT(c.s, c.v);
  });
  const dragging = useRef(false);
  // 最近一次由本组件送出的色值：外部 value 与它不同才反向同步（防止拖动被外部值打断）
  const lastOut = useRef(value.toLowerCase());

  // 外部 value 变化（切换编辑目标 / 恢复默认 / 编码输入）时同步本地位置
  useEffect(() => {
    const v = String(value).toLowerCase();
    if (v === lastOut.current) return;
    lastOut.current = v;
    const c = hexToHsv(value);
    setHue(c.h);
    setT(svToT(c.s, c.v));
  }, [value]);

  const pick = useCallback(
    (el: HTMLElement, clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      const tx = Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
      const ty = Math.min(1, Math.max(0, (clientY - r.top) / (r.height || 1)));
      const h = tx * 360;
      const { s, v } = tToSv(ty);
      setHue(h);
      setT(ty);
      const hex = hsvToHex(h, s, v);
      lastOut.current = hex.toLowerCase();
      onChange(hex);
    },
    [onChange],
  );

  return (
    <div
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e.currentTarget, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => dragging.current && pick(e.currentTarget, e.clientX, e.clientY)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      className="relative h-32 w-full cursor-pointer touch-none select-none overflow-hidden rounded-xl border border-black/35"
      style={{ background: SPECTRUM }}
    >
      {/* 明暗叠层：白 → 透明 → 黑 */}
      <div className="pointer-events-none absolute inset-0" style={{ background: LIGHTNESS }} />
      {/* 当前选色指示环 */}
      <div
        className="pointer-events-none absolute h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          left: `${(hue / 360) * 100}%`,
          top: `${t * 100}%`,
          background: value,
          boxShadow: "0 0 0 2px #fff, 0 1px 3px rgba(0,0,0,0.35)",
        }}
      />
    </div>
  );
}
