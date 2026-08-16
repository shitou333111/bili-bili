"use client";

import { useEffect } from "react";
import { DESKTOP_TITLEBAR_H } from "@/lib/layout";

/**
 * 平台安全区适配器
 * 根据运行平台（iOS / Android / 桌面 Tauri / Web）注入 CSS 变量：
 *   --safe-top   : 顶部通知栏/刘海安全区，让顶部内容避开状态栏
 *   --safe-bottom: 底部 Home Indicator 安全区，让底部内容避开屏幕边缘
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
    let safeBottom = "0px";
    let dockBottom = "16px";
    // 活动页/黑抽页顶部固定偏移：避免活动内容直接贴在模拟器顶部栏
    let activityTop = "100px";

    if (isTauri) {
      if (isIOS) {
        safeTop = "calc(env(safe-area-inset-top, 47px) - 3px)";
        safeBottom = "env(safe-area-inset-bottom, 20px)";
        dockBottom = "24px";
        activityTop = "80px";
      } else if (isAndroid) {
        safeTop = "env(safe-area-inset-top, 24px)";
        safeBottom = "env(safe-area-inset-bottom, 8px)";
        dockBottom = "26px";
        activityTop = "80px";
      } else {
        // 桌面 Tauri：启用自定义标题栏（decorations:false），顶部预留标题栏高度（单一源头 page-config.json）
        safeTop = DESKTOP_TITLEBAR_H + "px";
        // 桌面无物理 Home Indicator，但模拟器底部一行（输入框/礼物按钮）若贴 0 会太靠下，
        // 给一个固定底部留白，与移动端（safe-area-inset-bottom + 内边距）的视觉效果接近。
        safeBottom = "20px";
        dockBottom = "16px";
        activityTop = "100px";
      }
    } else {
      if (isIOS || isAndroid) {
        safeTop = "env(safe-area-inset-top, 24px)";
        safeBottom = "env(safe-area-inset-bottom, 8px)";
        dockBottom = "16px";
        activityTop = "80px";
      } else {
        // 桌面浏览器：与桌面 Tauri 保持一致，避免模拟器底部一行贴边
        safeTop = "0px";
        safeBottom = "20px";
        dockBottom = "16px";
        activityTop = "100px";
      }
    }

    doc.style.setProperty("--safe-top", safeTop);
    doc.style.setProperty("--safe-bottom", safeBottom);
    doc.style.setProperty("--dock-bottom", dockBottom);
    doc.style.setProperty("--activity-top", activityTop);
  }, []);

  return null;
}