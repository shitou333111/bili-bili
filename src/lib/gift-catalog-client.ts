/**
 * 礼物目录模块（Tauri 客户端）—— 统一本地礼物数据仓的薄封装。
 *
 * 正式功能（收益统计、送礼名单等）通过本模块读取礼物图标/列表；
 * 数据由 gift-local-store 下载到本地文件（12h 自动刷新、支持强制刷新），全 APP 共用同一份，
 * 不再需要手动维护的静态快照。
 */

import type { Platform } from "./platform/types";
import {
  ensureGiftDataLoaded,
  getGiftImg as storeGetGiftImg,
  getGiftImgAnimated as storeGetGiftImgAnimated,
  getGiftImgByName as storeGetGiftImgByName,
  getGiftName as storeGetGiftName,
  getGiftPrice as storeGetGiftPrice,
  getGiftList as storeGetGiftList,
  getRoomGiftData as storeGetRoomGiftData,
  type GiftConfigItem,
  type RoomGiftListData,
} from "./gift-local-store";

export type { GiftConfigItem, RoomGiftListData };

/** 确保本地礼物数据已加载（TTL 12h；缺失或过期自动重新下载） */
export async function ensureGiftCatalogLoaded(platform: Platform): Promise<void> {
  await ensureGiftDataLoaded(platform);
}

/** 根据 gift_id 获取礼物图片，没找到返回空字符串 */
export function getGiftImg(giftId: number): string {
  return storeGetGiftImg(giftId);
}

/** 根据 gift_id 获取礼物动态图（优先 gif，没有 gif 退 img_basic），没找到返回空字符串。供礼物展示条使用 */
export function getGiftImgAnimated(giftId: number): string {
  return storeGetGiftImgAnimated(giftId);
}

/** 按名称获取礼物图片（gift_id 失效时回退用），没找到返回空字符串 */
export function getGiftImgByName(name: string): string {
  return storeGetGiftImgByName(name);
}

/** 根据 gift_id 获取礼物名称，没找到返回空字符串 */
export function getGiftName(giftId: number): string {
  return storeGetGiftName(giftId);
}

/** 根据 gift_id 获取礼物价格（元），gold 类型 /1000，silver 或未找到返回 0 */
export function getGiftPrice(giftId: number): number {
  return storeGetGiftPrice(giftId);
}

/** 返回完整礼物列表（含价格、角标等全部字段） */
export function getGiftList(): GiftConfigItem[] {
  return storeGetGiftList();
}

/** 直播间礼物面板数据（roomGiftList API，gold_list 原始顺序 + tab_list） */
export function getRoomGiftData(): RoomGiftListData {
  return storeGetRoomGiftData();
}

/**
 * 大航海「开通/续费」动画的礼物别名：真实操作名 → 礼物列表/特效列表中的名称。
 *
 * 在直播间开通舰长/提督/总督时，B站触发的动画并不挂在"舰长/提督/总督"这三个名称上，
 * 礼物列表与特效列表里对应的是相近的「舰长一号 / 提督一号 / 总督一号」（真实送礼与
 * 弹幕关键字两种情况都需要替换）。**仅这 3 种特殊名称需要替换**，其他名称一律原样返回，
 * 不影响既有流程。
 */
const GUARD_GIFT_ALIAS: Record<string, string> = {
  舰长: "舰长一号",
  提督: "提督一号",
  总督: "总督一号",
  // 弹幕触发用词：「舰长」二字是 B站屏蔽词，该弹幕根本不投递（连 raw DANMU_MSG 都没有），
  // 故关键字路线改用「上舰」；真实开通链路的 gift_name 仍是「舰长」，上面那条必须保留。
  上舰: "舰长一号",
};

/** 把大航海操作名换成礼物列表/特效列表中的对应名称（舰长→舰长一号…）；其他名称原样返回 */
export function resolveGiftAliasName(name: string): string {
  const n = (name ?? "").trim();
  return (n && GUARD_GIFT_ALIAS[n]) || n;
}

/**
 * 某名称在礼物列表中对应的全部 gift_id。同名可能有多个 id（例如"舰长一号"就有 4 个），
 * 按 id 升序返回，便于调用方逐个尝试、命中真正带特效的那个。
 */
export function giftIdsByName(name: string): number[] {
  const n = (name ?? "").trim();
  if (!n) return [];
  return getGiftList()
    .filter((g) => g.name === n && g.id)
    .map((g) => g.id)
    .sort((a, b) => a - b);
}
