"use client";

import { useEffect, useState } from "react";

/**
 * 反应式监测浏览器在线/离线状态。
 * 离线时返回 false，用于驱动离线横幅、卡片置灰等 UI 提示。
 */
export function useOnlineStatus(): boolean {
  // 初始一律视为在线：确保 SSR 与客户端首屏渲染一致，避免 hydration 不匹配。
  // 真实在线状态在挂载后通过事件/立即同步更新。
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // 挂载后立即同步一次真实状态（部分 WebView 可能在事件监听前就已断网）
    setOnline(navigator.onLine);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}