"use client";

/**
 * 自动抢运行状态（轻量独立模块）
 *
 * 与后台运行器分开，避免「帮助」页为了在卡片上显示运行状态而引入整个抢奖逻辑，
 * 进而在用户从未使用该功能时也启动长轮询。
 */

import { useSyncExternalStore } from "react";

let running = false;
const listeners = new Set<() => void>();

export function setAutoLotteryRunning(value: boolean) {
  if (running === value) return;
  running = value;
  for (const l of listeners) l();
}

export function isAutoLotteryRunning(): boolean {
  return running;
}

export function subscribeAutoLotteryRunning(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React Hook：订阅自动抢是否正在后台运行 */
export function useAutoLotteryRunning(): boolean {
  return useSyncExternalStore(subscribeAutoLotteryRunning, isAutoLotteryRunning, () => false);
}
