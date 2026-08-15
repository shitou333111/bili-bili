/**
 * 本地礼物数据仓（Tauri）
 *
 * 将完整礼物列表（giftConfig）与特效绑定表（GetEffectConfListV2）下载到本地数据目录，
 * 供正式功能与模拟器共用同一份数据，实现本地化 + 离线可用。
 *
 * 更新规则：
 *  - TTL 12 小时：进入相关页面 / 各功能页加载时检查，过期自动重新下载
 *  - forceRefresh：手动强制重拉（全局"刷新数据"按钮、特效按需回源），跳过 TTL
 *
 * 文件（位于 getDataDir()，即 {appDataDir}/data）：
 *  - gift-list.json    完整礼物列表（含价格、角标等全部字段）
 *  - gift-effects.json 特效绑定表 gift_id -> { web_mp4, web_mp4_json }
 *  - gift-data-meta.json { updatedAt }（两个文件共用一份时间戳，同时更新）
 *
 * 注意：本模块仅 Tauri 使用；Web 模式浏览器无法可靠落盘大文件，继续走服务器代理。
 */

import type { Platform } from "./platform/types";

const TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const LIST_FILE = "gift-list.json";
const EFFECTS_FILE = "gift-effects.json";
const META_FILE = "gift-data-meta.json";

const GIFT_CONFIG_API =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig?platform=pc&room_id=1844040969";
const EFFECTS_API =
  "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2?platform=pc";

export type GiftConfigItem = {
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

export type GiftEffectBinding = { web_mp4: string; web_mp4_json: string };

// 内存解析缓存（避免每次读取都重新解析几 MB JSON）
let memList: GiftConfigItem[] | null = null;
let memImgMap: Map<number, string> | null = null;
let memEffects: Record<number, GiftEffectBinding> | null = null;

function filePath(dir: string, file: string): string {
  return `${dir}/${file}`;
}

async function readJson<T>(platform: Platform, file: string): Promise<T | null> {
  try {
    return JSON.parse(await platform.readFile(file)) as T;
  } catch {
    return null;
  }
}

function setMemList(list: GiftConfigItem[]): void {
  memList = list;
  memImgMap = new Map();
  for (const g of list) {
    if (g.id) memImgMap.set(g.id, g.img_basic || g.webp || g.gif || "");
  }
}

/** 尝试从本地文件加载到内存；两个文件都成功加载返回 true */
async function loadFromDisk(platform: Platform): Promise<boolean> {
  const dir = await platform.getDataDir();
  const [list, effects] = await Promise.all([
    readJson<GiftConfigItem[]>(platform, filePath(dir, LIST_FILE)),
    readJson<Record<number, GiftEffectBinding>>(platform, filePath(dir, EFFECTS_FILE)),
  ]);
  if (list && effects) {
    setMemList(list);
    memEffects = effects;
    return true;
  }
  return false;
}

async function isMetaFresh(platform: Platform): Promise<boolean> {
  const meta = await readJson<{ updatedAt?: number }>(
    platform,
    filePath(await platform.getDataDir(), META_FILE),
  );
  return !!meta && typeof meta.updatedAt === "number" && Date.now() - meta.updatedAt < TTL_MS;
}

async function fetchList(platform: Platform): Promise<GiftConfigItem[] | null> {
  try {
    const resp = await platform.fetchBilibiliJson<{
      code: number;
      data?: { list?: GiftConfigItem[] } | null;
    }>({ url: GIFT_CONFIG_API, cookie: "" }); // 无需登录
    if (resp.code !== 0 || !resp.data?.list) return null;
    return resp.data.list;
  } catch (err) {
    console.error("[GiftLocalStore] 从B站获取礼物列表失败:", err);
    return null;
  }
}

async function fetchEffects(platform: Platform): Promise<Record<number, GiftEffectBinding> | null> {
  try {
    const resp = await platform.fetchBilibiliJson<{
      code: number;
      data?: {
        full_sc_resource?: {
          conf_list?: { web_mp4: string; web_mp4_json: string; bind_gift_ids: number[] }[];
        };
      } | null;
    }>({ url: EFFECTS_API, cookie: "", live: true }); // 无需登录
    const confList = resp?.data?.full_sc_resource?.conf_list;
    if (resp.code !== 0 || !confList) return null;
    const map: Record<number, GiftEffectBinding> = {};
    for (const item of confList) {
      if (!item.web_mp4 || !item.web_mp4_json) continue;
      for (const gid of item.bind_gift_ids) {
        if (gid === 0) continue;
        map[gid] = { web_mp4: item.web_mp4, web_mp4_json: item.web_mp4_json };
      }
    }
    return map;
  } catch (err) {
    console.error("[GiftLocalStore] 从B站获取特效列表失败:", err);
    return null;
  }
}

async function persist(
  platform: Platform,
  list: GiftConfigItem[],
  effects: Record<number, GiftEffectBinding>,
): Promise<void> {
  try {
    const dir = await platform.getDataDir();
    await Promise.all([
      platform.writeFile(filePath(dir, LIST_FILE), JSON.stringify(list)),
      platform.writeFile(filePath(dir, EFFECTS_FILE), JSON.stringify(effects)),
      platform.writeFile(filePath(dir, META_FILE), JSON.stringify({ updatedAt: Date.now() })),
    ]);
  } catch (err) {
    console.warn("[GiftLocalStore] 写入本地礼物数据失败:", err);
  }
}

/**
 * 确保本地礼物数据已加载。
 * - 内存已加载且非强制刷新 → 直接返回
 * - 本地文件存在且未过期 → 读本地
 * - 缺失 / 过期 / 强制刷新 → 从 B站 下载完整 JSON 落盘
 * 下载失败时回退本地旧文件（有则用）。
 */
export async function ensureGiftDataLoaded(platform: Platform, forceRefresh = false): Promise<void> {
  if (!forceRefresh && memList && memEffects) return;
  if (!forceRefresh) {
    if ((await loadFromDisk(platform)) && (await isMetaFresh(platform))) return;
  }
  const [list, effects] = await Promise.all([fetchList(platform), fetchEffects(platform)]);
  if (list && effects) {
    setMemList(list);
    memEffects = effects;
    await persist(platform, list, effects);
  } else {
    // 下载失败：回退本地旧文件（有则用）
    await loadFromDisk(platform);
    console.warn("[GiftLocalStore] 礼物数据下载失败，使用本地缓存");
  }
}

/** 强制刷新本地礼物数据（跳过 TTL） */
export async function refreshGiftData(platform: Platform): Promise<void> {
  return ensureGiftDataLoaded(platform, true);
}

/** 完整礼物列表（含价格、角标等全部字段） */
export function getGiftList(): GiftConfigItem[] {
  return memList ?? [];
}

/** 根据 gift_id 获取礼物图标，没找到返回空字符串 */
export function getGiftImg(giftId: number): string {
  return memImgMap?.get(giftId) ?? "";
}

/** 特效绑定表 gift_id -> { web_mp4, web_mp4_json } */
export function getGiftEffectsMap(): Record<number, GiftEffectBinding> {
  return memEffects ?? {};
}
