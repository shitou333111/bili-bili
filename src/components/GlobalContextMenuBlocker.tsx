"use client";

import { useEffect } from "react";

/**
 * 在 Tauri 客户端中禁用全局右键菜单（整个 APP 界面右键点击无反应）。
 * 通过在捕获阶段拦截 contextmenu 并 preventDefault，WebView2 不会弹出原生右键菜单。
 * Web 模式不生效（浏览器保留原生右键，便于调试/复制）。
 */
export default function GlobalContextMenuBlocker() {
  useEffect(() => {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;

    function handleContextMenu(e: MouseEvent) {
      e.preventDefault();
      e.stopPropagation();
    }
    // 用捕获阶段拦截，确保任何子元素（含已 stopPropagation 的）都无法触发默认右键菜单
    document.addEventListener("contextmenu", handleContextMenu, true);
    return () => document.removeEventListener("contextmenu", handleContextMenu, true);
  }, []);

  return null;
}