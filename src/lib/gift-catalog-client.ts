/**
 * 礼物目录模块（Tauri 客户端）
 *
 * 直连 B站 giftConfig API（无需登录），提供按 gift_id 查询礼物图标（img_basic）。
 * 处理方式参照 gift_effects（客户端）：12 小时 localStorage 缓存。
 *
 * 注意：本模块【仅】使用图标信息，不使用 price 等字段——价格等参数仍由现有各统计模块
 * 各自处理（不同数据源记录方式不同，换用可能导致已有功能错误）。
 */

import type { Platform } from "./platform/types";

const GIFT_CONFIG_API =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=1844040969";
const CACHE_KEY = "bili_gift_catalog_cache";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

type GiftConfigItem = {
  id: number;
  name: string;
  img_basic?: string;
};

type GiftCatalogData = {
  gifts: Record<number, { name: string; img: string }>;
};

// 进程内内存缓存（避免同一会话内重复解析 localStorage）
let memCache: GiftCatalogData | null = null;

function getCached(): GiftCatalogData | null {
  if (memCache) return memCache;
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    memCache = data;
    return data;
  } catch {
    return null;
  }
}

function setCached(data: GiftCatalogData): void {
  memCache = data;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

async function fetchFromBili(platform: Platform): Promise<GiftCatalogData | null> {
  try {
    const resp = await platform.fetchBilibiliJson<{
      code: number;
      data?: { list?: GiftConfigItem[] } | null;
    }>({ url: GIFT_CONFIG_API, cookie: "" }); // 无需登录
    if (resp.code !== 0 || !resp.data?.list) return null;
    const gifts: Record<number, { name: string; img: string }> = {};
    for (const item of resp.data.list) {
      if (item.id && item.img_basic) {
        gifts[item.id] = { name: item.name, img: item.img_basic };
      }
    }
    const catalog = { gifts };
    setCached(catalog);
    return catalog;
  } catch (err) {
    console.error("[GiftCatalog] 从B站获取礼物目录失败:", err);
    return null;
  }
}

/**
 * 确保礼物目录已加载（缓存有效则直接用；否则从 B站 拉取）。
 * 网络失败时保留旧缓存，图标查找回退为空字符串。
 */
export async function ensureGiftCatalogLoaded(platform: Platform): Promise<void> {
  if (getCached()) return;
  await fetchFromBili(platform);
}

/** 根据 gift_id 获取礼物图片，没找到返回空字符串 */
export function getGiftImg(giftId: number): string {
  return getCached()?.gifts?.[giftId]?.img ?? "";
}
