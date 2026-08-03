/**
 * 平台抽象层 - 自动检测当前平台
 *
 * 用法：
 *   import { platform } from "@/lib/platform";
 *   const data = await platform.fetchBilibiliJson({ url: "..." });
 */

import type { Platform } from "./types";

let _platform: Platform | null = null;

/** 检测是否是 Tauri 环境 */
function isTauri(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/** 获取当前平台实例 */
export async function getPlatform(): Promise<Platform> {
  if (_platform) return _platform;

  if (isTauri()) {
    const { tauriPlatform } = await import("./tauri");
    _platform = tauriPlatform;
    console.log("[Platform] 检测到 Tauri 环境");
  } else {
    const { webPlatform } = await import("./web");
    _platform = webPlatform;
    console.log("[Platform] 使用 Web 环境");
  }

  return _platform;
}

/** 同步获取平台（仅 Web 环境可用，Tauri 需要异步导入） */
export function getPlatformSync(): Platform {
  if (_platform) return _platform;
  // 默认返回 Web 平台（运行时环境）
  const { webPlatform } = require("./web");
  return webPlatform;
}

// 导出类型
export type { Platform, FetchJsonOptions, RawResponse } from "./types";