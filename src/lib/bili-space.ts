/**
 * 打开 B站用户个人空间（供各页面复用）。
 *
 * - 移动端优先用 bilibili://space/{uid} 唤起 APP，1.2s 后回退网页版；
 * - 桌面端直接在新窗口打开 https://space.bilibili.com/{uid}；
 * - Tauri（原生客户端）走 @tauri-apps/plugin-opener。
 */

import { getPlatform } from "@/lib/platform";

export function biliSpaceWebUrl(uid: number): string {
  return `https://space.bilibili.com/${uid}`;
}

export async function openBiliSpace(uid: number): Promise<void> {
  if (!uid) return;
  const platform = await getPlatform();
  const appScheme = `bilibili://space/${uid}`;
  const webUrl = biliSpaceWebUrl(uid);
  const isMobile =
    platform.os === "android" ||
    platform.os === "ios" ||
    (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));

  if (platform.isNative) {
    let opened = false;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      if (isMobile) {
        try {
          await openUrl(appScheme);
          opened = true;
        } catch {
          /* 协议唤起失败，改用网页版 */
        }
      }
      if (!opened) {
        try {
          await openUrl(webUrl);
          opened = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* plugin-opener 不可用，降级到 window.open */
    }
    if (opened) return;
  }

  if (!isMobile) {
    window.open(webUrl, "_blank", "noopener,noreferrer");
    return;
  }

  // 移动端 Web：先尝试协议唤起 APP，失败后回退网页版
  try {
    const schemeWin = window.open(appScheme, "_blank");
    setTimeout(() => {
      try {
        if (schemeWin) schemeWin.location.href = webUrl;
      } catch {
        /* ignore cross-origin */
      }
    }, 1200);
  } catch {
    window.open(webUrl, "_blank", "noopener,noreferrer");
  }
}
