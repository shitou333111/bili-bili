"use client";

/**
 * 饼图自定义 Tooltip
 * - 第一行昵称（自适应宽度，过长自动换行）
 * - 第二行数额（超过1万以"万"为单位显示1位小数，如 1.2万）
 * - 文字小、padding 小，宽度自适应内容，位置约束在视口内（不超出屏幕右/下边缘）
 */

interface PieTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: React.ReactNode; value?: React.ReactNode; payload?: { fill?: string; battery?: number } }>;
  coordinate?: { x?: number; y?: number } | null;
}

/** 超过1万以"万"为单位显示1位小数 */
function formatWithWan(v: number): string {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return String(v);
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

export default function PieTooltip({ active, payload, coordinate }: PieTooltipProps) {
  if (!active || !payload || !payload.length || !coordinate) return null;
  const item = payload[0];
  const name = item.name;
  const fill = item.payload?.fill;
  // 优先使用 payload 中的电池数值（各饼图已归一化的显示单位），否则回退到原始 value
  const value = item.payload?.battery != null ? item.payload.battery : (typeof item.value === "number" ? item.value : Number(item.value));

  // 计算气泡位置，约束在视口内（宽度自适应，按内容估算高度）
  const pad = 8;
  const maxW = Math.min(window.innerWidth - pad * 2, 220);
  const estimatedH = 40;
  const x = coordinate.x != null ? Math.min(coordinate.x + pad, window.innerWidth - maxW - pad) : pad;
  const y = coordinate.y != null ? Math.min(coordinate.y + pad, window.innerHeight - estimatedH - pad) : pad;

  return (
    <div
      className="pointer-events-none rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[12px] leading-snug shadow-lg"
      style={{
        position: "absolute",
        left: x,
        top: y,
        maxWidth: maxW,
        width: "max-content",
        zIndex: 60,
      }}
    >
      <div className="font-medium break-words whitespace-normal" style={{ color: fill || "#1f1c17" }}>
        {name}
      </div>
      <div className="text-black/55 mt-0.5 whitespace-nowrap">{formatWithWan(value)}</div>
    </div>
  );
}