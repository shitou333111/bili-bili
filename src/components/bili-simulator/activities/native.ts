"use client";

/**
 * 原生活动窗口助手
 *
 * 方案：不用 HTML iframe（跨域沙箱限制绕不过），改由 Tauri 原生层开一个 WebView 窗口
 * 直接加载真实 B站 H5，并在文档开始前注入 mock-shim.js —— 脚本运行在 B站 页面自身的
 * origin 上下文里，覆盖 fetch/XHR 拦截 StarStone 三接口，返回本地 mock 数据。
 * 结果：真实 B站 UI + 本地数据 + 不登录 + 不扣费 + 不走服务器。
 */

import type { ActivityConfig } from "./types";
import { buildActivityUrl } from "./types";
import { STONE_GONGFANG } from "./stone-gongfang/config";

/** 是否运行在 Tauri 原生客户端（三平台统一标记） */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

/**
 * 生成注入到 B站 H5 的 mock 配置（字段与 mock-shim.js 的 CONFIG 一致）。
 * 默认 mockAllApi=false：只拦截 StarStone 三接口，其余请求放行真实数据，保证页面正常渲染。
 */
function buildMockConfig(pageType: string): Record<string, unknown> {
  if (pageType === "stone-gongfang") {
    return { ...STONE_GONGFANG, mockAllApi: false };
  }
  return { mockAllApi: false };
}

/**
 * 在原生客户端打开真实 B站 H5 活动页。
 * 桌面端：主窗口内下方 2/3 子 WebView 面板（高 = 主窗口 2/3）；移动端回退独立全屏窗口。
 * @param config 活动配置
 * @param slotState 上次保存的槽位抽取状态（可选），随 mock 配置注入，
 *                  使活动页打开时即可还原上次的抽取状态
 * @returns 是否成功打开；浏览器环境下返回 false（调用方回退到本地复刻页）。
 */
export async function openActivityNative(
  config: ActivityConfig,
  slotState?: Record<string, number>
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const mockConfig: Record<string, unknown> = buildMockConfig(config.pageType);
    if (slotState && Object.keys(slotState).length > 0) {
      mockConfig.slot_state = slotState;
    }
    await invoke("open_activity_panel", {
      config: {
        url: buildActivityUrl(config),
        title: config.title,
        mockConfig,
      },
    });
    return true;
  } catch (e) {
    console.error("[Activity] 打开活动面板失败:", e);
    return false;
  }
}

/** 主动关闭活动页面板（顶部遮罩点击时调用） */
export async function closeActivityNative(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_activity_panel");
  } catch (e) {
    console.error("[Activity] 关闭活动面板失败:", e);
  }
}
