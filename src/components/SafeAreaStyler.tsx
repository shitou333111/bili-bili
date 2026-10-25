"use client";

import { useEffect } from "react";
import { DESKTOP_TITLEBAR_H } from "@/lib/layout";

/**
 * 平台安全区适配器
 * 根据运行平台（iOS / Android / 桌面 Tauri / Web）注入 CSS 变量：
 *   --safe-top   : 顶部通知栏/刘海安全区，让顶部内容避开状态栏
 *   --safe-bottom: 底部 Home Indicator 安全区，让底部内容避开屏幕边缘
 *   --dock-bottom: 底部托盘栏距屏幕底部的距离（平台差异化微调）
 *   --dock-safe  : 托盘栏需要额外避让的系统底部区域（Android 虚拟导航栏 / 移动端 PWA 的
 *                  Home Indicator）。与 --dock-bottom 相加后才是托盘栏真正的 bottom 值。
 *                  iOS 客户端保持 0（用户已按观感调到 24px），避免托盘栏被抬得过高。
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
    // 托盘栏额外避让的系统底部区域（默认 0：桌面与 iOS 客户端不额外上移）
    let dockSafe = "0px";
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
        // Android 15+ 强制 edge-to-edge，WebView 铺到系统状态栏/导航栏下方；
        // 托盘栏若不额外上移，下半部分会被虚拟导航栏（返回/主页键）盖住。
        dockSafe = "env(safe-area-inset-bottom, 0px)";
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
        // iOS（含"添加到主屏幕"后的独立 PWA）：与 iOS 客户端保持一致，托盘栏不额外避让
        // Home Indicator。本项目 viewport-fit:cover，内容已延伸到屏幕底边；若托盘再上移
        // env(safe-area-inset-bottom)（约 34px），底部就会露出一条页面背景横条（真机仅苹果复现）。
        // Android 仍需避让虚拟导航栏（edge-to-edge 下托盘会被盖住）。
        dockSafe = isAndroid ? "env(safe-area-inset-bottom, 0px)" : "0px";
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
    doc.style.setProperty("--dock-safe", dockSafe);
    doc.style.setProperty("--activity-top", activityTop);

    // ===== 视口宽度自适应缩放 =====
    // 窗口宽度不足 MIN_WIDTH 时把整份 UI 等比缩小（zoom 是布局级缩放，比 transform:scale
    // 更清晰）。原先写在 page.tsx 里，但它会让整页的 CSS 像素同步变小——包括 html/body 的
    // 高度：外壳高度按 innerHeight 注入后，渲染出来只剩 innerHeight × zoom，
    // 底部于是露出 (1 - zoom) × innerHeight 的页面背景带（窄屏、360dp 安卓机型上最明显）。
    // 所以缩放与高度实测必须放在一起：高度按 zoom 反向补偿，保证外壳的"视觉高度"始终等于视口。
    // 只在主应用页（.page-main）启用，login / admin 等页面维持原样不缩放。
    const MIN_WIDTH = 380;
    const applyZoom = (innerW: number) => {
      const hasShell = !!document.querySelector(".page-main");
      const zoom = hasShell && innerW > 0 && innerW < MIN_WIDTH ? innerW / MIN_WIDTH : 1;
      const zoomStr = zoom < 1 ? String(zoom) : "";
      if (doc.style.zoom !== zoomStr) doc.style.zoom = zoomStr;
      return zoom;
    };

    // ===== 可视区域实测 =====
    // 浏览器的 layout viewport（window.innerHeight）与真正可见的高度
    // （visualViewport.height）在部分安卓机型上并不一致：
    //   · 安卓 edge-to-edge（Android 15+）与部分三星机型：innerHeight 偏大，包含系统导航栏/
    //     浏览器工具栏遮住的底部区域 → 外壳比可见区域高一截，底部托盘栏落在被遮住的条带里，
    //     页面上就露出"页面背景色带"；
    // 因此外壳高度以 visualViewport.height 为准，innerHeight 只做兜底。
    // 例外：软键盘弹出时 visualViewport 会缩小而 innerHeight 不变，此时保留 innerHeight，
    //       避免输入时整页被压扁；双指缩放（scale>1）时 visualViewport 同样不能用于布局。
    // 例外：iOS（含独立 PWA）visualViewport.height 不含 Home Indicator 遮盖的约 34px，
    //       但本项目 viewport-fit:cover，该区域内容实际完全可见——若按"被遮挡"处理，
    //       外壳会矮 34px（底部露出页面背景横条），托盘还会被 --view-hidden-bottom
    //       再抬高 34px。故 iOS 直接信 innerHeight，此实测仅供安卓 edge-to-edge 使用。
    const KEYBOARD_GAP = 150;
    const applyViewport = () => {
      // 先算缩放：下面的高度/避让值都要除以它，换算回"被缩放的 CSS 像素"空间
      const zoom = applyZoom(window.innerWidth || 0);
      const vv = window.visualViewport;
      const innerH = window.innerHeight || 0;
      let height = innerH;
      let hiddenBottom = 0;
      if (!isIOS && vv && vv.height > 0 && vv.scale <= 1.05) {
        // 被遮住的底部高度（layout viewport 底边 - 可视区底边）
        const gap = Math.round(innerH - (vv.offsetTop + vv.height));
        if (gap >= 0 && gap < KEYBOARD_GAP) {
          hiddenBottom = gap;
          height = Math.round(vv.height);
        }
      }
      if (height > 0) doc.style.setProperty("--app-height", `${Math.round(height / zoom)}px`);
      // 托盘栏避让：被遮住的底部条带与 env(safe-area-inset-bottom) 描述的是同一块区域，
      // 由 globals.css 取二者较大值，避免重复上移（iOS 客户端 --dock-safe 仍只走 env）。
      doc.style.setProperty("--view-hidden-bottom", `${hiddenBottom / zoom}px`);
    };
    applyViewport();
    window.addEventListener("resize", applyViewport);
    window.addEventListener("orientationchange", applyViewport);
    window.visualViewport?.addEventListener("resize", applyViewport);
    window.visualViewport?.addEventListener("scroll", applyViewport);

    return () => {
      window.removeEventListener("resize", applyViewport);
      window.removeEventListener("orientationchange", applyViewport);
      window.visualViewport?.removeEventListener("resize", applyViewport);
      window.visualViewport?.removeEventListener("scroll", applyViewport);
    };
  }, []);

  return null;
}