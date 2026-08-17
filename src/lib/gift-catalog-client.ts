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
