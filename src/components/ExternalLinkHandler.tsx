"use client";

import { useEffect } from "react";

/**
 * 在 Tauri 客户端中拦截外部 http(s) 链接的点击，
 * 用系统默认浏览器（或系统识别的对应 APP）打开，避免在 webview 内跳转无反应。
 * Web 模式不生效（浏览器原生行为即可）。
 */
export default function ExternalLinkHandler() {
  useEffect(() => {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;

    let disposed = false;
    let openUrl: ((url: string) => Promise<void>) | null = null;

    import("@tauri-apps/plugin-opener")
      .then((mod) => {
        openUrl = mod.openUrl;
        if (!disposed) {
          document.addEventListener("click", handleClick);
        }
      })
      .catch(() => {
        // 插件不可用时，保持默认行为
      });

    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement)?.closest?.("a");
      if (!target) return;
      const anchor = target as HTMLAnchorElement;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // 内部路由（以 / 开头，非 // 协议相对）交给 Next.js
      if (href.startsWith("/") && !href.startsWith("//")) return;
      // 无协议（如 hash、相对路径）不处理
      if (!/^[a-z][a-z0-9+.\-]*:/i.test(href)) return;
      // 阻止 javascript/data/vbscript 等危险协议
      if (/^(javascript|data|vbscript):/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      if (openUrl) {
        openUrl(href).catch(() => {
          // 打开失败时回退到浏览器新窗口
          window.open(href, "_blank");
        });
      } else {
        window.open(href, "_blank");
      }
    }

    return () => {
      disposed = true;
      document.removeEventListener("click", handleClick);
    };
  }, []);

  return null;
}