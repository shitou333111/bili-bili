/**
 * 构建信息（单一来源）。
 *
 * 三个变量都由 CI 注入：
 *  - NEXT_PUBLIC_APP_VERSION = 应用版本号（构建期读 src-tauri/tauri.conf.json，与客户端同一个值）
 *  - NEXT_PUBLIC_BUILD_SEQ   = github.run_number（每次 CI 运行单调递增，仅内部用于 SW 版本比较）
 *  - NEXT_PUBLIC_BUILD_DATE  = 构建时间戳（YYYYMMDD-HHMMSS，东八区）
 *
 * 通过 next.config.ts 的 env 映射，值在构建期被内联进产物：
 * 服务端（standalone 的 server.js 运行时）拿不到 CI 环境变量，
 * 若在运行时读 process.env 会永远为空，因此必须依赖构建期内联。
 */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";
export const BUILD_SEQ = process.env.NEXT_PUBLIC_BUILD_SEQ || "";
export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || "";

/**
 * 构建日期紧凑显示："20260816-123456" → "20260816"、"2026-08-16" → "20260816"。
 * 无日期信息时原样返回。
 */
export function compactBuildDate(d: string): string {
  const m = d.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : d;
}

/**
 * 版本显示（与客户端格式统一）：V{版本}-{YYYYMMDD}，如 V0.2.8-20261023。
 * 构建序号（BUILD_SEQ）只用于内部比较新旧，不进显示文本。
 * 缺少版本号时退化为"开发版"。
 */
export function formatVersionLabel(
  version: string = APP_VERSION,
  date: string = BUILD_DATE,
): string {
  if (!version) return "开发版";
  const day = compactBuildDate(date);
  return day ? `V${version}-${day}` : `V${version}`;
}
