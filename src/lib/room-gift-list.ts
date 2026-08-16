/**
 * 直播间礼物面板模块（服务端 / Next.js）
 *
 * 直连 B站 roomGiftList API（无需登录），返回固定直播间（23915535）的礼物面板数据：
 * `data.gift_data`（room_gift_list.gold_list 原始顺序 + tab_list 粉丝团/航海等）。
 * 所有直播间的该列表一致，故固定使用该直播间。
 *
 * 处理方式参照 gift-catalog：12 小时内存缓存 + .data 文件持久化兜底。
 * 供 Web 模式模拟器通过 /api/room-gift-list 获取（Tauri 模式由 gift-local-store 直连本地缓存）。
 */

import { promises as fs, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const ROOM_GIFT_LIST_API =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/roomGiftList?platform=pc&room_id=23915535";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const CACHE_FILE = path.join(process.cwd(), ".data", "room-gift-list.json");

export type RoomGiftListItem = {
  gift_id: number;
  position?: number;
  [key: string]: unknown;
};

export type RoomGiftListData = {
  room_gift_list?: { gold_list?: RoomGiftListItem[] };
  tab_list?: { tab_id: number; list?: RoomGiftListItem[] }[];
};

// 进程内内存缓存
let memCache: { data: RoomGiftListData; timestamp: number } | null = null;

function isCacheValid(): boolean {
  return memCache !== null && Date.now() - memCache.timestamp < CACHE_TTL_MS;
}

async function fetchFromBili(): Promise<RoomGiftListData | null> {
  try {
    const response = await fetch(ROOM_GIFT_LIST_API, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`[RoomGiftList] HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    const giftData = data?.data?.gift_data;
    if (data.code !== 0 || !giftData?.room_gift_list) {
      console.error(`[RoomGiftList] API错误 code=${data.code}`);
      return null;
    }
    memCache = { data: giftData, timestamp: Date.now() };
    // 持久化兜底（失败不影响内存缓存）
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(giftData, null, 2), "utf-8");
    } catch {}
    return giftData;
  } catch (err) {
    console.error("[RoomGiftList] 从B站获取直播间礼物面板失败:", err);
    return null;
  }
}

/**
 * 确保直播间礼物面板已加载。缓存有效直接用；否则从 B站 拉取；失败时回退到 .data 落盘文件。
 */
export async function ensureRoomGiftListLoaded(): Promise<void> {
  if (isCacheValid()) return;
  const data = await fetchFromBili();
  if (data) return;
  // 网络失败，回退到上次落盘的数据
  try {
    if (existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (parsed?.room_gift_list) {
        memCache = { data: parsed, timestamp: Date.now() };
      }
    }
  } catch {}
}

/** 返回直播间礼物面板数据（data.gift_data）；未加载时回退到 .data 落盘文件 */
export function getRoomGiftData(): RoomGiftListData | null {
  if (memCache?.data) return memCache.data;
  try {
    if (existsSync(CACHE_FILE)) {
      const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (parsed?.room_gift_list) return parsed;
    }
  } catch {}
  return null;
}
