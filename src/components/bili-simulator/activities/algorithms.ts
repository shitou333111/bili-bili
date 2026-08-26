"use client";

/**
 * 活动算法注册表
 *
 * 概念：B站活动五花八门，但背后玩法（算法）只有几类。每个算法类型对应 mock-shim.js 里
 * 的一套拦截逻辑，负责给该活动的真实 H5 页面返回对应的模拟数据。
 *
 * 使用方式：
 *  - admin 页面为每个活动配置一个算法类型（下拉框选择本注册表的键），并附算法参数；
 *  - native.ts 打开真实 H5 时，根据 algorithmType 找到本表定义，生成注入的 mock 配置；
 *  - mock-shim.js 按 CONFIG.algorithmType 分派对应算法的请求拦截逻辑。
 *
 * 新增算法类型：
 *  1. 在本文件注册新键（label + buildMockConfig）；
 *  2. 在 mock-shim.js 的 shouldMock / handleRequest 中增加对应分派；
 *  3. 改完只需前端热更新推送（mock-shim.js + 本文件均打进 OTA 包），无需原生包更新。
 */

import { STONE_GONGFANG } from "./stone-gongfang/config";

/** 算法类型定义 */
export interface AlgorithmDefinition {
  /** 下拉框展示名 */
  label: string;
  /** 简短说明（可选） */
  description?: string;
  /**
   * 根据算法参数生成注入到 mock-shim 的配置（CONFIG 合并用）。
   * 返回对象会与 mock-shim 内置默认值合并，可覆盖 act_id/slotCount/draw_price/gift_info 等。
   */
  buildMockConfig: (params: Record<string, unknown>) => Record<string, unknown>;
}

/** 算法注册表：键 = algorithmType，与 mock-shim.js 的分派一致 */
export const ALGORITHM_REGISTRY: Record<string, AlgorithmDefinition> = {
  /** 晶石工坊（山海工坊）：6 槽位抽取/替换/合成 */
  "stone-gongfang": {
    label: "晶石工坊（槽位合成）",
    description: "6 槽位抽取材料 → 替换 → 按相同素材数合成礼物",
    buildMockConfig: (params) => ({ ...STONE_GONGFANG, ...(params ?? {}) }),
  },
  /**
   * 玲珑宝斋（fans_autumn_2026）：玩法算法占位。
   * 尚未研究真实玩法接口，暂用"通用拦截"：默认 mockAllApi=true，
   * 对 api.live.bilibili.com 一律返回通用成功，保证绝不产生真实扣费。
   * 待玩法实现后，在 mock-shim.js 补充具体接口分派并通过热更新推送。
   */
  "fans-autumn-2026": {
    label: "玲珑宝斋（玩法待实现）",
    description: "占位算法：通用成功拦截，避免真实扣费；具体玩法接口待实现后热更新",
    buildMockConfig: (params) => ({ mockAllApi: true, ...(params ?? {}) }),
  },
};

/** 根据算法类型取定义（未注册返回 null） */
export function getAlgorithmDefinition(
  algorithmType?: string
): AlgorithmDefinition | null {
  if (!algorithmType) return null;
  return ALGORITHM_REGISTRY[algorithmType] ?? null;
}
