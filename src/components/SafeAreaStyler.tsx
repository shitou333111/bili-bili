"use client";

import { useEffect } from "react";

/**
 * 平台安全区适配器
 * 根据运行平台（iOS / Android / 桌面 Tauri / Web）注入 CSS 变量：
 *   --safe-top   : 顶部通知栏/刘海安全区，让顶部内容避开状态栏
 *   --dock-bottom: 底部托盘栏距屏幕底部的距离（平台差异化微调）
 *
 * 用户在真机实测反馈：
 *   - 安卓托盘栏偏低 → 托盘栏上移（增大 bottom）
 *   - iOS 托盘栏偏高   → 托盘栏下移（减小 bottom）
 *   - iOS 刘海区占得更多 → 顶部安全距离更大
 */
export default function SafeAreaStyler() {
  useEffect(() => {
    const doc = document.documentElement;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);
    const isTauri =
      typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

    let safeTop = "0px";
    let dockBottom = "16px";

    if (isTauri) {
      if (isIOS) {
        // iOS：刘海 + Home indicator，顶部需留更多安全距离，托盘栏下移（减小 bottom）
        safeTop = "env(safe-area-inset-top, 47px)";
        dockBottom = "12px";
      } else if (isAndroid) {
        // Android：状态栏，留少量安全距离，托盘栏上移（增大 bottom），避免偏低
        safeTop = "env(safe-area-inset-top, 24px)";
        dockBottom = "26px";
      } else {
        // 桌面 Tauri：无通知栏
        safeTop = "0px";
        dockBottom = "16px";
      }
    } else {
      // Web 浏览器：移动端走安全区，桌面无
      if (isIOS || isAndroid) {
        safeTop = "env(safe-area-inset-top, 24px)";
        dockBottom = "16px";
      } else {
        safeTop = "0px";
        dockBottom = "16px";
      }
    }

    doc.style.setProperty("--safe-top", safeTop);
    doc.style.setProperty("--dock-bottom", dockBottom);
  }, []);

  return null;
}