/**
 * 服务器 API 请求封装
 *
 * - Web 模式：使用相对路径 /api/... （由 Next.js 服务器处理）
 * - Tauri 模式：前端是静态文件，需将 /api/... 转发到服务器（NEXT_PUBLIC_SERVER_URL）
 */

const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

/** 构建日期（CI 构建时注入；本地开发为"开发版"），用于判定是否生产打包 */
const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || "开发版";

/** 检测是否在 Tauri 环境 */
export function isTauri(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/**
 * 当前是否为 Tauri 生产构建。
 * 主要依据：构建期注入的 NEXT_PUBLIC_IS_TAURI_PROD=1（见 scripts/build-tauri.mjs，
 * 仅 `tauri build` 会经过该脚本；`tauri dev` 走 next dev 不注入）。
 * 兜底保留旧特征检测（file: 协议 / .html 路径），兼容未注入标志的历史构建。
 * 注意：不能用 __TAURI_ENVIRONMENT__ 或 file: 协议唯一判定——Tauri v2 生产窗口
 * 通过自定义资产协议加载（既非 file:，pathname 也可能不是 .html），曾被错误判为 false，
 * 导致热更新检查被短路拦截。
 */
export function isTauriProduction(): boolean {
  if (!isTauri()) return false;
  if (process.env.NEXT_PUBLIC_IS_TAURI_PROD === "1") return true;
  try {
    if (typeof window !== "undefined" && window.location?.protocol === "file:") return true;
    // 兜底：如果页面URL里含 ".html" 说明已经是静态导出页了
    if (typeof window !== "undefined" && /\.html($|\?|#)/.test(window.location.pathname)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 解析页面导航 URL。
 * Tauri 生产构建（静态导出）才生成 path.html（如 admin.html），WebView 不会自动补 .html，
 * 导航到 /admin 会 "this page couldn't load"。
 * Tauri 开发模式走 Next dev server（http://），无 .html，加了会 404。
 */
export function pageUrl(path: string): string {
  if (isTauriProduction()) {
    if (path === "/") return "/index.html";
    return path + ".html";
  }
  return path;
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