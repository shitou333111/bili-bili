/**
 * 黑白榜时间工具（纯函数，可同时用于浏览器与服务器）
 *
 * 榜单的日期口径统一按北京时间（UTC+8）计算，与 B站 记录时间一致，
 * 避免服务器/客户端时区不同导致「今天」「上周五」错位。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 某个时间戳对应的北京时间日期键：YYYY-MM-DD */
export function beijingDateKey(ts: number = Date.now()): string {
  const d = new Date(ts + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 最近一个「已经过去」的周五（北京时间）日期键：YYYY-MM-DD。
 * 若今天就是周五，则取上周五（今天尚未过完，不算）。
 */
export function lastPastFridayKey(ts: number = Date.now()): string {
  const d = new Date(ts + BEIJING_OFFSET_MS);
  const dayOfWeek = d.getUTCDay(); // 0=周日, 5=周五, 6=周六
  let diff = (dayOfWeek - 5 + 7) % 7;
  if (diff === 0) diff = 7;
  const friday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - diff * DAY_MS);
  return `${friday.getUTCFullYear()}-${pad2(friday.getUTCMonth() + 1)}-${pad2(friday.getUTCDate())}`;
}

/**
 * 日期范围类型 → 精确日期键（仅 today / lastFriday 需要，其余返回 null）。
 * 主播收益记录时间形如 "YYYY-MM-DD HH:mm:ss"，可直接取前 10 位按日期比较。
 */
export function dateKeyForRange(range: string): string | null {
  if (range === "today") return beijingDateKey();
  if (range === "lastFriday") return lastPastFridayKey();
  return null;
}
