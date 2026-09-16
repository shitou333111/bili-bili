"use client";

import type { ActivityRenderMode } from "./types";

/**
 * 环境检测：区分「原生客户端 WebView」与「浏览器」
 *
 * 原生客户端（Android WebView / iOS WKWebView / 桌面端壳）运行同一套 React 代码，
 * 但活动页统一以 iframe 模式打开真实 B站 H5（原生层注入 mock-shim 本地返回模拟数据），
 * 浏览器不再提供本地复刻页。
 */

export function isNativeWebView(): boolean {
  if (typeof window === "undefined") return false;

  const w = window as unknown as Record<string, unknown>;
  // 0) Tauri 原生客户端（桌面/移动三平台统一标记）
  if ("__TAURI_INTERNALS__" in w) return true;
  // 1) 原生层注入标记（推荐方式）：原生启动 WebView 时设置 window.__BILI_NATIVE__ = true
  if (w.__BILI_NATIVE__ === true) return true;

  const ua = navigator.userAgent.toLowerCase();
  // 2) Android WebView：UA 含 android + wv
  if (ua.includes("android") && ua.includes("wv")) return true;
  // 3) iOS WKWebView：iPhone/iPad + AppleWebKit 且非普通 Safari
  if (/iphone|ipad|ipod/.test(ua) && ua.includes("applewebkit") && !ua.includes("safari")) {
    return true;
  }
  return false;
}

/**
 * 活动渲染模式：所有活动统一为 iframe（打开真实 B站 H5，原生层注入 mock-shim 拦截）。
 */
export function resolveActivityMode(): ActivityRenderMode {
  return "iframe";
}
