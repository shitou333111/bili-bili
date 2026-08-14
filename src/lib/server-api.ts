/**
 * 服务器 API 请求封装
 *
 * - Web 模式：使用相对路径 /api/... （由 Next.js 服务器处理）
 * - Tauri 模式：前端是静态文件，需将 /api/... 转发到服务器（NEXT_PUBLIC_SERVER_URL）
 */

const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.1.2:3000";

/** 检测是否在 Tauri 环境 */
export function isTauri(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/** 获取服务器 API 完整 URL */
export function serverApiUrl(path: string): string {
  const tauri = isTauri();
  if (tauri) {
    return `${SERVER_BASE_URL}${path}`;
  }
  return path;
}

/** 请求服务器 API（自动处理平台差异） */
export async function serverFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = serverApiUrl(path);
  const ctrl = new AbortController();
  // 服务器请求加超时，避免原生模式下服务器不可达时长时间挂起
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    if (isTauri()) {
      // Tauri 原生：前端与服务器跨源，必须走 @tauri-apps/plugin-http（Rust 侧 HTTP 客户端，无 CORS 限制），
      // 否则 WebView 原生 fetch 到跨源地址会抛 "Failed to fetch"（如管理员登录）。
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const res = await tauriFetch(url, { ...options, signal: ctrl.signal });
      return (await res.json()) as T;
    }
    const res = await fetch(url, { cache: "no-store", ...options, signal: ctrl.signal });
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

/** 请求服务器 API（POST） */
export async function serverPost<T>(path: string, body?: unknown): Promise<T> {
  return serverFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}