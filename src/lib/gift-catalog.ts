/**
 * 礼物目录模块（服务端 / Next.js）
 *
 * 直连 B站 giftConfig API（无需登录），提供按 gift_id 查询礼物图标（img_basic）。
 * 处理方式参照 gift_effects（服务端 route）：12 小时内存缓存 + .data 文件持久化兜底。
 *
 * 注意：本模块【仅】使用图标信息，不使用 price 等字段——价格等参数仍由现有各统计模块
 * 各自处理（不同数据源记录方式不同，换用可能导致已有功能错误）。
 */

import { promises as fs, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const GIFT_CONFIG_API =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=1844040969";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const CACHE_FILE = path.join(process.cwd(), ".data", "gift-catalog.json");

type GiftConfigItem = {
  id: number;
  name: string;
  price?: number;
  coin_type?: string;
  bag_gift?: number;
  corner_mark?: string;
  corner_background?: string;
  effect_id?: number;
  img_basic?: string;
  img_dynamic?: string;
  webp?: string;
  gif?: string;
};

/**
 * 礼物目录数据：
 * - `gifts`：gift_id -> { name, img }（仅图标，历史消费者使用）
 * - `list`：完整礼物列表（含价格、角标、分类等全部字段），供模拟器等需要完整数据的场景使用
 */
export type GiftCatalogData = {
  gifts: Record<number, { name: string; img: string }>;
  list: GiftConfigItem[];
};

// 进程内内存缓存
let memCache: { data: GiftCatalogData; timestamp: number } | null = null;

function isCacheValid(): boolean {
  return memCache !== null && Date.now() - memCache.timestamp < CACHE_TTL_MS;
}

function buildCatalog(list: GiftConfigItem[]): GiftCatalogData {
  const gifts: Record<number, { name: string; img: string }> = {};
  for (const item of list) {
    if (!item.id) continue;
    // 兼容旧的"仅取图标"约定；完整字段整体保留在 list 中供模拟器使用
    if (item.img_basic) {
      gifts[item.id] = { name: item.name, img: item.img_basic };
    }
  }
  return { gifts, list };
}

async function fetchFromBili(): Promise<GiftCatalogData | null> {
  try {
    const response = await fetch(GIFT_CONFIG_API, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`[GiftCatalog] HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data.code !== 0 || !Array.isArray(data.data?.list)) {
      console.error(`[GiftCatalog] API错误 code=${data.code}`);
      return null;
    }
    const catalog = buildCatalog(data.data.list);
    memCache = { data: catalog, timestamp: Date.now() };
    // 持久化兜底（失败不影响内存缓存）
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(catalog, null, 2), "utf-8");
    } catch {}
    return catalog;
  } catch (err) {
    console.error("[GiftCatalog] 从B站获取礼物目录失败:", err);
    return null;
  }
}

/**
 * 确保礼物目录已加载。缓存有效直接用；否则从 B站 拉取；失败时回退到 .data 落盘文件。
 */
export async function ensureGiftCatalogLoaded(): Promise<void> {
  if (isCacheValid()) return;
  const catalog = await fetchFromBili();
  if (catalog) return;
  // 网络失败，回退到上次落盘的数据
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = readFileSync(CACHE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.gifts) {
        memCache = { data: parsed, timestamp: Date.now() };
      }
    }
  } catch {}
}

/** 根据 gift_id 获取礼物图片，没找到返回空字符串 */
export function getGiftImg(giftId: number): string {
  return memCache?.data.gifts?.[giftId]?.img ?? "";
}

/**
 * 返回完整礼物目录（gift_id -> { name, img }）。
 * 优先内存缓存；若为空则回退到 .data 落盘文件。
 */
export function getGiftCatalog(): Record<number, { name: string; img: string }> {
  if (memCache?.data.gifts) return memCache.data.gifts;
  try {
    if (existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (parsed?.gifts) return parsed.gifts;
    }
  } catch {}
  return {};
}

/**
 * 返回完整礼物列表（含价格、角标、分类等全部字段）。
 * 优先内存缓存；若为空则回退到 .data 落盘文件；旧缓存无 list 时返回空数组。
 */
export function getGiftList(): GiftConfigItem[] {
  if (memCache?.data.list) return memCache.data.list;
  try {
    if (existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (parsed?.list) return parsed.list;
    }
  } catch {}
  return [];
}
