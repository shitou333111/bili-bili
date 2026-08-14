"use client";

import type { ActivityRenderMode } from "./types";

/**
 * 环境检测：区分「原生客户端 WebView」与「浏览器」
 *
 * 原生客户端（Android WebView / iOS WKWebView / 桌面端壳）运行同一套 React 代码，
 * 但活动页的渲染方式不同：
 *  - 原生客户端：嵌入真实 B站 H5（iframe），由原生层 shouldInterceptRequest /
 *    WKURLSchemeHandler 拦截 StarStoneDraw/Replace/Compose 三个接口并返回本地 mock JSON
 *  - 浏览器：浏览器无法拦截跨域 iframe 请求，故默认用本地复刻页（replica）演示
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
 * 解析活动渲染模式：
 *  - 原生客户端：一律 iframe（嵌入真实 B站 H5，原生层拦截 mock）
 *  - 浏览器：默认使用配置值（replica）；可用 ?activity_mode=iframe 临时切换以调试真实页面
 */
export function resolveActivityMode(preferred: ActivityRenderMode): ActivityRenderMode {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("activity_mode");
    if (param === "iframe" || param === "replica") return param;
  }
  return isNativeWebView() ? "iframe" : preferred;
}
