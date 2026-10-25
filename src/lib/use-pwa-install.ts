"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * PWA「添加到主屏幕」安装引导（仅移动端浏览器网页）。
 *
 * 三条路径：
 *  1. Android + Chrome/Edge 等支持 beforeinstallprompt 的浏览器
 *     → 捕获事件（调 preventDefault 阻止浏览器自带的迷你提示），由我们自己的卡片
 *       调用 prompt() 弹出系统安装对话框；
 *  2. iOS（Safari / Chrome / Edge，全部是 WebKit，无 beforeinstallprompt）
 *     → 显示「分享 → 添加到主屏幕」图文指引；
 *  3. Android 但没拿到 beforeinstallprompt（浏览器不实现 / PWA 判定不可安装）
 *     → 显示「⋮ 菜单 → 添加到主屏幕」手动指引。
 *
 * 不显示的场景：Tauri 客户端、桌面浏览器、已经以独立窗口运行（standalone）。
 *
 * 注意：Chrome 的 beforeinstallprompt 可能在 React 挂载之前就触发，
 * 因此由 layout.tsx 里的内联脚本最早登记事件（window.__bguaguaInstallPrompt），
 * 本 hook 既读这个全局，也监听后续的自定义事件。
 */

export type PwaInstallMode = "prompt" | "ios" | "android-manual";

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

declare global {
  interface Window {
    __bguaguaInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

/** 关闭后的冷却时间：7 天内不再打扰（用户明确选择"以后再说"） */
const DISMISS_KEY = "bguagua-pwa-install-dismissed";
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
/** 页面加载后延迟出现，避免和首屏渲染/登录弹窗抢注意力 */
const SHOW_DELAY_MS = 3000;
/** Android 等待 beforeinstallprompt 的宽限期，超时才退化为手动指引 */
const PROMPT_GRACE_MS = 4000;

function isStandalone(): boolean {
  const mm = window.matchMedia ? window.matchMedia("(display-mode: standalone)").matches : false;
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mm || iosStandalone;
}

function isIosDevice(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS 13+ 的 UA 伪装成 Macintosh，用触点数区分
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

function isMobileDevice(): boolean {
  return isIosDevice() || /Android/i.test(navigator.userAgent);
}

function isDismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

function markDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
}

export interface PwaInstallController {
  visible: boolean;
  mode: PwaInstallMode | null;
  /** 调用系统安装对话框（仅 mode === "prompt" 时有效） */
  install: () => void;
  /** 用户关闭卡片：写入冷却时间并隐藏 */
  dismiss: () => void;
}

export function usePwaInstall(): PwaInstallController {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<PwaInstallMode | null>(null);

  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) return; // 客户端不显示
    if (!isMobileDevice()) return; // 电脑端网页不显示
    if (isStandalone()) return; // 已经是独立 App
    if (isDismissedRecently()) return;

    const ios = isIosDevice();
    let disposed = false;
    let shownMode: PwaInstallMode | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // 允许"手动指引"随后升级为系统安装按钮（beforeinstallprompt 迟到的情况）
    const show = (m: PwaInstallMode) => {
      if (disposed || shownMode === "prompt") return;
      if (shownMode === m) return;
      shownMode = m;
      setMode(m);
      setVisible(true);
    };

    const onInstallable = () => {
      if (ios) return; // iOS 永远拿不到该事件，走图文指引
      show("prompt");
    };
    const onInstalled = () => {
      window.__bguaguaInstallPrompt = null;
      shownMode = "prompt"; // 不再展示任何引导
      setVisible(false);
    };

    window.addEventListener("bguagua:pwa-installable", onInstallable);
    window.addEventListener("appinstalled", onInstalled);

    // 内联脚本可能已经捕获到事件（早于本 hook 挂载）
    if (!ios && window.__bguaguaInstallPrompt) show("prompt");

    // 兜底：延迟后仍没有可用的安装入口 → 给图文指引
    timers.push(
      setTimeout(
        () => {
          if (shownMode) return;
          show(ios ? "ios" : "android-manual");
        },
        SHOW_DELAY_MS + (ios ? 0 : PROMPT_GRACE_MS),
      ),
    );

    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("bguagua:pwa-installable", onInstallable);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    const ev = window.__bguaguaInstallPrompt;
    if (!ev) return;
    void (async () => {
      try {
        await ev.prompt();
        const choice = await ev.userChoice;
        // 事件只能用一次，无论用户选什么都释放掉
        window.__bguaguaInstallPrompt = null;
        setVisible(false);
        if (choice?.outcome !== "accepted") markDismissed();
      } catch {
        // 某些浏览器在事件过期后调用会抛错：退化为隐藏卡片
        window.__bguaguaInstallPrompt = null;
        setVisible(false);
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    markDismissed();
    setVisible(false);
  }, []);

  return { visible, mode, install, dismiss };
}
