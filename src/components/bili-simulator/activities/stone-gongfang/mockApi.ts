"use client";

import { STONE_GONGFANG } from "./config";
import type {
  StarStoneComposeResult,
  StarStoneDrawResult,
  StarStoneReplaceResult,
} from "../mock/types";

/**
 * 山海工坊三个接口的 mock 实现（本地算法）
 *
 * 返回结构与真实 B站接口完全一致。原生客户端 WebView 拦截这三个请求时，
 * 直接返回本模块产出的 JSON 即可（绕过登录与扣费）。
 *
 * 状态约定：槽位用一个 Record<string, number> 表示 { "1":5, "2":2, ... }。
 */

export type SlotState = Record<string, number>;

/** 当前时间戳 */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** 随机整数 [min, max] 含端点 */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 从 carousel 池中随机取 5 条 */
function pickCarousel(): string[] {
  const pool = STONE_GONGFANG.carousel_pool;
  const list: string[] = [];
  for (let i = 0; i < 5; i++) {
    list.push(pool[randInt(0, pool.length - 1)]);
  }
  return list;
}

/** 构造 draw/replace 的公共响应 data 部分 */
function buildCommonData(slots: SlotState): StarStoneDrawResult["data"] {
  return {
    act_id: STONE_GONGFANG.act_id,
    activity_name: STONE_GONGFANG.activity_name,
    start_time: STONE_GONGFANG.start_time,
    end_time: STONE_GONGFANG.end_time,
    cur_timestamp: now(),
    carousel_list: pickCarousel(),
    draw_price: STONE_GONGFANG.draw_price,
    replace_price: STONE_GONGFANG.replace_price,
    gift_info: STONE_GONGFANG.draw_gift_info,
    slot_info: JSON.stringify(slots),
  };
}

/**
 * 抽取：随机选中一个槽位，随机赋予一个新材料值，并更新该槽位。
 * @param slots 当前槽位状态（会被修改）
 * @param targetSlot 可选，指定抽取的槽位（默认随机）
 */
export function mockDraw(slots: SlotState, targetSlot?: number): StarStoneDrawResult {
  const idx = targetSlot ?? randInt(1, STONE_GONGFANG.slotCount);
  slots[String(idx)] = randInt(STONE_GONGFANG.slotMin, STONE_GONGFANG.slotMax);
  return {
    code: 0,
    message: "OK",
    ttl: 1,
    data: buildCommonData(slots),
  };
}

/**
 * 替换：随机（或指定）一个槽位，重新赋予材料值。
 */
export function mockReplace(slots: SlotState, targetSlot?: number): StarStoneReplaceResult {
  const idx = targetSlot ?? randInt(1, STONE_GONGFANG.slotCount);
  slots[String(idx)] = randInt(STONE_GONGFANG.slotMin, STONE_GONGFANG.slotMax);
  return {
    code: 0,
    message: "OK",
    ttl: 1,
    data: buildCommonData(slots),
  };
}

/**
 * 合成：按 6 个槽位材料总值匹配合成礼物表（总值越高礼物越大）。
 * @returns 合成的礼物信息（mock 中不真正消耗槽位，方便反复试玩）
 */
export function mockCompose(slots: SlotState): StarStoneComposeResult {
  const total = Object.values(slots).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const tier = STONE_GONGFANG.compose_gifts.find((t) => total >= t.minTotal);
  const gift = tier
    ? tier.gift
    : STONE_GONGFANG.compose_gifts[STONE_GONGFANG.compose_gifts.length - 1].gift;
  return {
    code: 0,
    message: "OK",
    ttl: 1,
    data: { gift_info: { ...gift } },
  };
}

/** 计算槽位总值（页面展示用） */
export function slotTotal(slots: SlotState): number {
  return Object.values(slots).reduce((sum, v) => sum + (Number(v) || 0), 0);
}
