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

/**
 * 逐级开箱（玲珑宝斋）默认配置：各层级宝箱的静态数据（单源配置）。
 *
 * 玩法：分多级（这里5级）宝箱，只有开出上一级的"目标宝物"才能开启下一级；每级 box_count 个宝箱，
 * 开一个花费 item_price（电池），开出目标材料则本级成功得到 item_name 礼物并自动进入下一级，
 * 最高一级开出大奖即结束。
 *
 * 字段与真实 LingLongGetGameState/LingLongOpenBox 响应一致：
 *  - item_level：层级(1..5)
 *  - box_name / box_icon：该层宝箱名与图标
 *  - item_name / item_price / item_gift_value / item_gift_icon：该层礼物名、开箱单价、礼物价值、图标
 *  - target：本层目标材料（开出即成功）
 *  - materials：普通材料池（开出后即消耗一个宝箱）
 *  - box_count：每层宝箱数（默认6）
 * 数值取自 .data/test-data/activity/multi-lever-open-box-state.json（含 obtained 版），可被算法参数覆盖。
 */
const LING_COMMON_MATERIALS = [
  {
    id: 6,
    name: "铜饰",
    icon: "https://i0.hdslb.com/bfs/live/9fc60e990e2645474616fd0f6739a02b5666111f.png",
  },
  {
    id: 7,
    name: "琉璃",
    icon: "https://i0.hdslb.com/bfs/live/d35c3882a319c166ae7c41efca39829fd6c7f0f1.png",
  },
  {
    id: 9,
    name: "彩石",
    icon: "https://i0.hdslb.com/bfs/live/ceb71201a35fc592af1f28529b114b88d31be5d8.png",
  },
  {
    id: 12,
    name: "粗绸",
    icon: "https://i0.hdslb.com/bfs/live/95287f5b049a751315b6a52ed1e49c3e9cbf4093.png",
  },
];

interface LingLevelConfig {
  item_level: number;
  box_name: string;
  box_icon: string;
  item_name: string;
  item_price: number;
  item_gift_value: number;
  item_gift_icon: string;
  /** 结算/合成退出时返回的礼物 id（真实 LingLongSettleGame 响应字段） */
  gift_id: number;
  target: { id: number; name: string; icon: string };
  materials: typeof LING_COMMON_MATERIALS;
  box_count: number;
}

/** 从真实抓包提取的 5 级宝箱静态数据 */
const LING_LEVELS: LingLevelConfig[] = [
  {
    item_level: 1,
    box_name: "锦囊",
    box_icon: "https://i0.hdslb.com/bfs/live/d77e05af3c913a891d3ee6142878cd20696df2f2.png",
    item_name: "相识玉扣",
    item_price: 100,
    item_gift_value: 350,
    item_gift_icon: "https://s1.hdslb.com/bfs/live/bff63d7642954aa6ee4df9ecbe0e1c6646140c82.png",
    gift_id: 35777,
    target: {
      id: 1,
      name: "纯银",
      icon: "https://i0.hdslb.com/bfs/live/f56ed56bbdecc71f3d0995becde44659aecb7f58.png",
    },
    materials: LING_COMMON_MATERIALS,
    box_count: 6,
  },
  {
    item_level: 2,
    box_name: "瓷瓶",
    box_icon: "https://i0.hdslb.com/bfs/live/7bed855d19fc76b1a93c56e4641e95dd8a191601.png",
    item_name: "常伴珠钗",
    item_price: 185,
    item_gift_value: 1000,
    item_gift_icon: "https://s1.hdslb.com/bfs/live/064108fdf7b61328b3f72cd14d7f2762a5f8dd6e.png",
    gift_id: 35778,
    target: {
      id: 2,
      name: "和田玉",
      icon: "https://i0.hdslb.com/bfs/live/a0b29518efb44cdaf928043499868db75558f940.png",
    },
    materials: LING_COMMON_MATERIALS,
    box_count: 6,
  },
  {
    item_level: 3,
    box_name: "银盒",
    box_icon: "https://i0.hdslb.com/bfs/live/f32e0a8915e2ae9d7ee902d7b9e494b38269bc8f.png",
    item_name: "缘起瓷瓶",
    item_price: 570,
    item_gift_value: 3000,
    item_gift_icon: "https://s1.hdslb.com/bfs/live/1dc3f0b3297afadf9e7cf65662bfa4f32d37f5e1.png",
    gift_id: 35779,
    target: {
      id: 3,
      name: "足金",
      icon: "https://i0.hdslb.com/bfs/live/9faccdc8ec230f4d8e6eb8eda7ed3b02cabb9a06.png",
    },
    materials: LING_COMMON_MATERIALS,
    box_count: 6,
  },
  {
    item_level: 4,
    box_name: "卷轴",
    box_icon: "https://i0.hdslb.com/bfs/live/dae7066b333b49dfb2ee813a4d988245a9fd1a51.png",
    item_name: "倾心宝冠",
    item_price: 1420,
    item_gift_value: 8000,
    item_gift_icon: "https://s1.hdslb.com/bfs/live/b9ac10fd732197fcf8b76e3e37fcf6eb0139efff.png",
    gift_id: 35780,
    target: {
      id: 4,
      name: "云锦",
      icon: "https://i0.hdslb.com/bfs/live/3623e557f3acffacbb66be92dc545edef11d8180.png",
    },
    materials: LING_COMMON_MATERIALS,
    box_count: 6,
  },
  {
    item_level: 5,
    box_name: "玉函",
    box_icon: "https://i0.hdslb.com/bfs/live/c7ee8442d5326d93312ab40f311f6202695f10d2.png",
    item_name: "万象天衣",
    item_price: 6280,
    item_gift_value: 30000,
    item_gift_icon: "https://s1.hdslb.com/bfs/live/14ba1e8bb376e8b256494fdb2fe34dfbc7204558.png",
    gift_id: 35600,
    target: {
      id: 5,
      name: "红珊瑚",
      icon: "https://i0.hdslb.com/bfs/live/e73d2530a6acd4998b5ba47f9da56217d833fa9b.png",
    },
    materials: LING_COMMON_MATERIALS,
    box_count: 6,
  },
];

/** 组装逐级开箱算法的默认 CONFIG（可在参数 confirmation 中覆盖 item_levels/end_time 等） */
function buildLinglongConfig(params: Record<string, unknown>): Record<string, unknown> {
  const levels = Array.isArray(params.item_levels) ? params.item_levels : LING_LEVELS;
  return {
    end_time: typeof params.end_time === "number" ? params.end_time : 1788148799,
    item_levels: levels,
  };
}

/** 逐级点亮（成名之路）单档配置 */
interface ChengmingLevelConfig {
  item_level: number;
  level_name: string;
  level_icon: string;
  gift_id: number;
  gift_name: string;
  gift_icon: string;
  gift_value: number;
  price: number;
  /** 成功率，万分比，4800 = 48% */
  success_rate: number;
  pity_limit: number;
}

/** 从真实抓包提取的 5 档成名之路静态数据 */
const CHENG_LEVELS: ChengmingLevelConfig[] = [
  {
    item_level: 1,
    level_name: "深夜街角",
    level_icon: "https://i0.hdslb.com/bfs/live/a05c8d639b205ac869fee63d296ff313d80f0dc9.png",
    gift_id: 35781,
    gift_name: "深夜街角",
    gift_icon: "https://s1.hdslb.com/bfs/live/a05c8d639b205ac869fee63d296ff313d80f0dc9.png",
    gift_value: 350,
    price: 180,
    success_rate: 4800,
    pity_limit: 3,
  },
  {
    item_level: 2,
    level_name: "灯火小馆",
    level_icon: "https://i0.hdslb.com/bfs/live/e54cb19bf0de40a58cd8cb5e954748a8df626f6c.png",
    gift_id: 35782,
    gift_name: "灯火小馆",
    gift_icon: "https://s1.hdslb.com/bfs/live/e54cb19bf0de40a58cd8cb5e954748a8df626f6c.png",
    gift_value: 1000,
    price: 180,
    success_rate: 4500,
    pity_limit: 3,
  },
  {
    item_level: 3,
    level_name: "聚光灯下",
    level_icon: "https://i0.hdslb.com/bfs/live/07a3ce0a27cad14d597e8c8713c38d89f04f37f9.png",
    gift_id: 35783,
    gift_name: "聚光灯下",
    gift_icon: "https://s1.hdslb.com/bfs/live/07a3ce0a27cad14d597e8c8713c38d89f04f37f9.png",
    gift_value: 3000,
    price: 670,
    success_rate: 4200,
    pity_limit: 4,
  },
  {
    item_level: 4,
    level_name: "万人合唱",
    level_icon: "https://i0.hdslb.com/bfs/live/3719650576cea2cf3a47ec52c803b8758cc9ef5f.png",
    gift_id: 35784,
    gift_name: "万人合唱",
    gift_icon: "https://s1.hdslb.com/bfs/live/3719650576cea2cf3a47ec52c803b8758cc9ef5f.png",
    gift_value: 8000,
    price: 1300,
    success_rate: 3900,
    pity_limit: 4,
  },
  {
    item_level: 5,
    level_name: "环球巡演",
    level_icon: "https://i0.hdslb.com/bfs/live/0524cfe42d17ca798f11c55e2a339486e4152039.png",
    gift_id: 35785,
    gift_name: "环球巡演",
    gift_icon: "https://s1.hdslb.com/bfs/live/0524cfe42d17ca798f11c55e2a339486e4152039.png",
    gift_value: 30000,
    price: 6400,
    success_rate: 3500,
    pity_limit: 5,
  },
];

/** 组装逐级点亮算法的默认 CONFIG */
function buildProgressiveLightConfig(params: Record<string, unknown>): Record<string, unknown> {
  const levels = Array.isArray(params.chengming_levels) ? params.chengming_levels : CHENG_LEVELS;
  return {
    start_time: typeof params.start_time === "number" ? params.start_time : 1788148800,
    end_time: typeof params.end_time === "number" ? params.end_time : 1788753599,
    chengming_levels: levels,
  };
}

/**
 * 同数间隔合成（星座回响）默认配置。
 *
 * 玩法：8 个空槽，每次付费从剩余库存随机抽 1 个【星座】顺时针填充空槽，库存中该星座数量 -1。
 * 库存固定：9 种星座各 2 个（共 18 个）。已召唤数量决定继续召唤的价格（res_price_schedule）。
 * 结束与结算（N 决定奖励，prize_config 按 N 取，price/gift_value 单位为分）：
 *   ① 出现 2 个相同星座 → 结束，N = 两相同星座间的星座数量 + 1；
 *   ② 主动退出 → N = 已召唤的星座数量；
 *   ③ 出现 8 个不同的星座 → N = 8；
 *   ④ 活动结束 → 按现有星座数量结算。
 * 字段与 mock-shim.js 的 res_* 分派（/resonance/* 接口）一一对应，可被算法参数覆盖。
 */
const RESONANCE_START = 1788753600; // 2026-09-07 12:00 (+08:00)
const RESONANCE_END = 1789315200; // 2026-09-14 00:00 (+08:00) = 9月13日24:00

// 9 种星座（id 1..9，与 HalfInit style_config_map 的 heart_1..heart_9 一一对应）
const RESONANCE_CONSTELLATIONS = [
  "双鱼座", "猎户座", "天琴座", "双子座", "狮子座",
  "射手座", "大熊座", "天蝎座", "英仙座",
];

// 已召唤数量(0..7) → 继续召唤价格（电池）。第 n+1 次召唤按"已召唤 n 个"查表。
const RESONANCE_PRICE_SCHEDULE = [50, 50, 85, 220, 420, 800, 1820, 3360];

// N=1..8 → 奖励礼物（price/gift_value 单位为分 = 电池×100；gift_id 为真实礼物目录 id）
const RESONANCE_PRIZES = [
  { n: 1, price: 5000, gift_id: 35849, gift_name: "初遇引星", gift_img: "https://s1.hdslb.com/bfs/live/c66229300d107e844596d65c6ec4d00b6ae0233e.png" },
  { n: 2, price: 10000, gift_id: 35850, gift_name: "驻听星语", gift_img: "https://s1.hdslb.com/bfs/live/2d7b22c2f6e18f085b82d286068718720ec40f81.png" },
  { n: 3, price: 20000, gift_id: 35851, gift_name: "并蒂双星", gift_img: "https://s1.hdslb.com/bfs/live/e07053b8a91b36722c276de12cc87e985f37bec9.png" },
  { n: 4, price: 50000, gift_id: 35852, gift_name: "欢跃星阵", gift_img: "https://s1.hdslb.com/bfs/live/78de897903ce5dc79f550ae9066bae7f988b3482.png" },
  { n: 5, price: 120000, gift_id: 35853, gift_name: "引路同星", gift_img: "https://s1.hdslb.com/bfs/live/2a0b00ccfe94f8017725c76e2cac5f08429ce3c8.png" },
  { n: 6, price: 300000, gift_id: 35854, gift_name: "守护星盾", gift_img: "https://s1.hdslb.com/bfs/live/e5176ff862e02474b1b9c3dae887ff531bacc790.png" },
  { n: 7, price: 880000, gift_id: 35856, gift_name: "星烙徽印", gift_img: "https://s1.hdslb.com/bfs/live/8b1fbfe2b401d608cc32edf53a855aa397ed95c9.png" },
  { n: 8, price: 3000000, gift_id: 35857, gift_name: "长明星河", gift_img: "https://s1.hdslb.com/bfs/live/77ad18c4403ae1b89f10a5ca7dc52561ec1f21a4.png" },
];

/** 组装同数间隔合成算法的默认 CONFIG（可在参数中覆盖 prize_config/carousel_pool/时间等） */
function buildResonanceConfig(params: Record<string, unknown>): Record<string, unknown> {
  return {
    start_time: typeof params.start_time === "number" ? params.start_time : RESONANCE_START,
    end_time: typeof params.end_time === "number" ? params.end_time : RESONANCE_END,
    res_slot_count: 8,
    res_price_schedule: RESONANCE_PRICE_SCHEDULE,
    res_inventory_per_type: 2,
    res_constellations: RESONANCE_CONSTELLATIONS,
    res_gift_ids: RESONANCE_PRIZES.map((p) => p.gift_id),
    prize_config: Array.isArray(params.prize_config) ? params.prize_config : RESONANCE_PRIZES,
    res_carousel_pool: Array.isArray(params.carousel_pool) ? params.carousel_pool : undefined,
  };
}

/** 算法注册表：键 = algorithmType，与 mock-shim.js 的分派一致 */
export const ALGORITHM_REGISTRY: Record<string, AlgorithmDefinition> = {
  /** 晶石工坊（山海工坊）：6 槽位抽取/替换/合成 */
  "stone-gongfang": {
    label: "槽位抽同",
    description: "6 槽位抽取材料 → 替换 → 按相同素材数合成礼物",
    // 剔除 replace_price/draw_gift_info：mock-shim.js 已改用 REPLACE_PRICE_MAP 动态定价 +
    // gift_info 完整礼物表，这两字段仅本地复刻页在用，不应注入真实 H5 mock 配置。
    buildMockConfig: (params) => {
      const { replace_price: _r, draw_gift_info: _d, ...rest } = STONE_GONGFANG;
      return { ...rest, ...(params ?? {}) };
    },
  },
  /**
   * 玲珑宝斋（逐级开箱）：分多级宝箱，只有开出上一级目标宝物才能进入下一级。
   * 每级开箱花费递增（item_price），开出目标即得到该级礼物；最高级开出大奖结束。
   * 算法逻辑在 mock-shim.js 的 linglong 分派中，数据在此注册表中，改完随前端热更新推送即可。
   */
  "linglong-open-box": {
    label: "逐级开箱",
    description: "分5级开箱，开出上一级宝物才能进下一级；每级开箱花费递增，开出目标级宝物即获得该级礼物",
    buildMockConfig: buildLinglongConfig,
  },
  /**
   * 逐级点亮（成名之路）：5 档顺序点亮，失败则上一档熄灭并累计人气，
   * 人气达到上限后该档必定成功；点亮第 5 档自动结束，也可主动结算。
   */
  "progressive-light-up": {
    label: "逐级点亮",
    description: "成名之路玩法：5档顺序点亮，失败则上一档熄灭并累计人气，人气满则保底成功",
    buildMockConfig: buildProgressiveLightConfig,
  },
  /**
   * 同数间隔合成（星座回响）：8 槽位顺时针填充星座，库存 9 种各 2 个；
   * 出现相同星座 / 主动退出 / 8 个全不同 / 活动结束按 N 结算（N=两相同星座间隔+1 或已召唤数）。
   */
  "number_between_same": {
    label: "同数间隔合成",
    description: "星座回响玩法：8槽位抽星座填槽，相同星座间隔决定N值，按N结算奖励",
    buildMockConfig: buildResonanceConfig,
  },
};

/** 根据算法类型取定义（未注册返回 null） */
export function getAlgorithmDefinition(
  algorithmType?: string
): AlgorithmDefinition | null {
  if (!algorithmType) return null;
  return ALGORITHM_REGISTRY[algorithmType] ?? null;
}
