/**
 * 服务器 API 请求封装
 *
 * - Web 模式：使用相对路径 /api/... （由 Next.js 服务器处理）
 * - Tauri 模式：前端是静态文件，需将 /api/... 转发到服务器（NEXT_PUBLIC_SERVER_URL）
 */

const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "https://your-server.com";

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
  if (isTauri()) {
    return `${SERVER_BASE_URL}${path}`;
  }
  return path;
}

/** 请求服务器 API（自动处理平台差异） */
export async function serverFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = serverApiUrl(path);
  const res = await fetch(url, { cache: "no-store", ...options });
  return res.json() as Promise<T>;
}

/** 请求服务器 API（POST） */
export async function serverPost<T>(path: string, body?: unknown): Promise<T> {
  return serverFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}