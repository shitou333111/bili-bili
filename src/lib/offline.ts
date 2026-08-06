/**
 * 离线模式判断与离线数据回退
 *
 * 架构说明：Next.js 服务器与 Tauri 前端运行在同一台机器（localhost），
 * 机器断网时服务器仍可达，但无法访问 B 站。此时各 API 路由应返回本地缓存数据
 * （.data/ 下已保存的上次更新数据），而不是 mock 或 401。
 *
 * 前端通过 navigator.onLine 检测到断网后，会在请求 URL 末尾追加 `offline=1`，
 * 服务器据此跳过 B 站凭证校验与 B 站抓取，直接读取本地缓存。
 */

/** 判断当前请求是否为离线模式（前端检测到断网后传入 ?offline=1） */
export function isOffline(url: URL): boolean {
  return url.searchParams.get("offline") === "1";
}