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
        // iOS：刘海 + Home indicator，顶部安全距离（在实测值基础上减3px，避免与通知栏间空白过大）；
        // 托盘栏上移：上一版误用了"减小 bottom"导致反而下移3px，从 9px 增大到 15px（净上移6px），
        // 再上移 3px → 18px，满足"只调 iOS 向上移动3px"
        safeTop = "calc(env(safe-area-inset-top, 47px) - 3px)";
        // 再上移 2px：15→18→20→22
        dockBottom = "30px";
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