import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");

/** 获取北京时间字符串 (UTC+8) */
export function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60; // UTC+8 in minutes
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

/** 清理文件名中的非法字符 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

/** Get user's data directory: .data/uid_MID_NICKNAME */
export function getUserDataDir(mid: number, uname: string): string {
  // Sanitize uname: remove special characters
  const safeName = uname.replace(/[\\/:*?"<>|]/g, "_");
  return path.join(DATA_DIR, `uid_${mid}_${safeName}`);
}

/** Ensure user data directory exists */
export async function ensureUserDataDir(mid: number, uname: string) {
  const dir = getUserDataDir(mid, uname);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Read user's pay records JSON file.
 * Records are stored in newest-first order (by id descending).
 */
export async function readPayRecords(mid: number, uname: string): Promise<RawGiftRecord[]> {
  const dir = await ensureUserDataDir(mid, uname);
  const filePath = path.join(dir, "pay-records.json");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    // 兼容旧格式（纯数组）和新格式（{ records: [...] }）
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

/** Save pay records (newest first) */
export async function savePayRecords(mid: number, uname: string, records: RawGiftRecord[]) {
  const dir = await ensureUserDataDir(mid, uname);
  const filePath = path.join(dir, "pay-records.json");
  const totalCoins = records.reduce((sum, r) => {
    const coins = Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0;
    return sum + coins;
  }, 0);
  const data = {
    exportedAt: getBeijingTime(),
    totalRecords: records.length,
    totalCoins,
    records,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/** Get the maximum id from existing records */
export function getMaxId(records: Array<{ id: number }>): number {
  if (records.length === 0) return 0;
  return Math.max(...records.map((r) => r.id));
}

/**
 * 保存合成活动记录
 * @param mid 用户ID
 * @param uname 用户名
 * @param activityId 活动ID
 * @param records 记录数组
 * @param activityName 活动名称（可选，用于文件名）
 */
export async function saveSynthesisRecords(
  mid: number,
  uname: string,
  activityId: string,
  records: any[],
  activityName?: string,
): Promise<void> {
  const dir = await ensureUserDataDir(mid, uname);
  const safeName = activityName ? sanitizeFileName(activityName) : "";
  const fileName = safeName
    ? `synthesis-${activityId}-${safeName}-records.json`
    : `synthesis-${activityId}-records.json`;
  const filePath = path.join(dir, fileName);

  // 删除旧文件（ID匹配但名称不同的文件）
  if (safeName) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`synthesis-${activityId}`) && f.endsWith("-records.json") && f !== fileName) {
          await fs.unlink(path.join(dir, f));
          console.log(`[SynthesisRecords] 删除旧文件: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = {
    exportedAt: getBeijingTime(),
    totalRecords: records.length,
    records,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[SynthesisRecords] 已保存 ${records.length} 条记录到 ${fileName}`);
}

/**
 * 读取合成活动记录
 * @param mid 用户ID
 * @param uname 用户名
 * @param activityId 活动ID
 */
export async function readSynthesisRecords(
  mid: number,
  uname: string,
  activityId: string,
): Promise<any[]> {
  const dir = await ensureUserDataDir(mid, uname);
  // 支持新旧两种文件名格式
  const filePath = await findFileByPrefix(dir, `synthesis-${activityId}`, "-records.json");
  if (!filePath) return [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

// ====== 文件名查找工具 ======

/**
 * 在目录中查找匹配前缀和后缀的文件（支持文件名中包含活动名称）
 */
async function findFileByPrefix(dir: string, prefix: string, suffix: string): Promise<string | null> {
  try {
    const files = await fs.readdir(dir);
    const match = files.find(f => f.startsWith(prefix) && f.endsWith(suffix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

// ====== 合成活动信息缓存（所有用户共享） ======

const ACTIVITY_INFO_DIR = path.join(DATA_DIR, "activity_info");

async function ensureActivityInfoDir() {
  try {
    await fs.mkdir(ACTIVITY_INFO_DIR, { recursive: true });
  } catch {
    // directory already exists
  }
}

/**
 * 获取合成活动信息（从缓存）
 * @param activityId 活动ID
 */
export async function getSynthesisActivityInfo(activityId: string): Promise<any | null> {
  await ensureActivityInfoDir();
  const filePath = await findFileByPrefix(ACTIVITY_INFO_DIR, activityId, ".json");
  if (!filePath) return null;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 保存合成活动信息（所有用户共享）
 * @param activityId 活动ID
 * @param info 活动信息
 */
export async function saveSynthesisActivityInfo(activityId: string, info: any): Promise<void> {
  await ensureActivityInfoDir();
  const activityName = info?.name ? sanitizeFileName(info.name) : "";
  const fileName = activityName
    ? `${activityId}-${activityName}.json`
    : `${activityId}.json`;
  const filePath = path.join(ACTIVITY_INFO_DIR, fileName);

  // 删除旧文件
  if (activityName) {
    try {
      const files = await fs.readdir(ACTIVITY_INFO_DIR);
      for (const f of files) {
        if (f.startsWith(activityId) && f.endsWith(".json") && f !== fileName) {
          await fs.unlink(path.join(ACTIVITY_INFO_DIR, f));
          console.log(`[SynthesisActivityInfo] 删除旧文件: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = {
    ...info,
    updated_at: getBeijingTime(),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`[SynthesisActivityInfo] 已保存活动信息到 ${fileName}`);
}

// Re-export RawGiftRecord type for convenience
import type { RawGiftRecord } from "@/lib/revenue";
export type { RawGiftRecord };

// ====== 主播昵称缓存（所有用户共享） ======

const ANCHOR_NAME_FILE = path.join(DATA_DIR, "anchor-names.json");

type AnchorNameCache = Record<string, string>;

export async function readAnchorNameCache(): Promise<AnchorNameCache> {
  try {
    const raw = await fs.readFile(ANCHOR_NAME_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveAnchorNameCache(cache: AnchorNameCache): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(ANCHOR_NAME_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

export async function getCachedAnchorName(ruid: number): Promise<string | null> {
  const cache = await readAnchorNameCache();
  return cache[String(ruid)] || null;
}

export async function setCachedAnchorName(ruid: number, name: string): Promise<void> {
  const cache = await readAnchorNameCache();
  cache[String(ruid)] = name;
  await saveAnchorNameCache(cache);
}

// ====== 天选礼物 ID 持久化存储 ======

const GIFT_DB_FILE = path.join(DATA_DIR, "gift-db.json");

interface GiftDB {
  tianxuan_gift_ids?: number[];
  last_tianxuan_update?: string;
  red_pocket_gift_ids?: number[];
  last_red_pocket_update?: string;
}

async function readGiftDB(): Promise<GiftDB> {
  try {
    const raw = await fs.readFile(GIFT_DB_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeGiftDB(db: GiftDB): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(GIFT_DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

/**
 * 获取所有天选礼物 ID（持久化累积 + 当前 API 返回的合并）
 * 这样可以确保历史天选礼物不会被遗漏
 */
export async function getAccumulatedTianxuanGiftIds(currentIds: number[]): Promise<number[]> {
  const db = await readGiftDB();
  const historicalIds = db.tianxuan_gift_ids || [];
  const merged = [...new Set([...historicalIds, ...currentIds])];
  
  // 如果有新 ID，更新持久化存储
  if (currentIds.length > 0) {
    db.tianxuan_gift_ids = merged;
    db.last_tianxuan_update = new Date().toISOString();
    await writeGiftDB(db);
  }
  
  console.log(`[getAccumulatedTianxuanGiftIds] 历史:${historicalIds.length} + 当前:${currentIds.length} = 合并:${merged.length}`);
  return merged;
}

/**
 * 获取所有红包礼物 ID（持久化累积 + 当前 API 返回的合并）
 */
export async function getAccumulatedRedPocketGiftIds(currentIds: number[]): Promise<number[]> {
  const db = await readGiftDB();
  const historicalIds = db.red_pocket_gift_ids || [];
  const merged = [...new Set([...historicalIds, ...currentIds])];

  if (currentIds.length > 0) {
    db.red_pocket_gift_ids = merged;
    db.last_red_pocket_update = new Date().toISOString();
    await writeGiftDB(db);
  }

  console.log(`[getAccumulatedRedPocketGiftIds] 历史:${historicalIds.length} + 当前:${currentIds.length} = 合并:${merged.length}`);
  return merged;
}

// ====== 翻牌礼物图片缓存（存储在活动信息文件中） ======

const ACTIVITY_INFO_DIR_PATH = path.join(DATA_DIR, "activity_info");

/**
 * 读取翻牌活动信息文件中的 gift_image_cache
 */
async function readCardFlipGiftImageCache(): Promise<Record<string, string>> {
  try {
    const files = await fs.readdir(ACTIVITY_INFO_DIR_PATH);
    const target = files.find(f => f.startsWith("activity-3") && f.endsWith(".json"));
    if (!target) return {};
    const raw = await fs.readFile(path.join(ACTIVITY_INFO_DIR_PATH, target), "utf8");
    const data = JSON.parse(raw);
    return data.gift_image_cache || {};
  } catch {
    return {};
  }
}

/**
 * 将礼物图片映射写回活动信息文件的 gift_image_cache 字段
 */
async function writeCardFlipGiftImageCache(cache: Record<string, string>): Promise<void> {
  try {
    await fs.mkdir(ACTIVITY_INFO_DIR_PATH, { recursive: true });
    const files = await fs.readdir(ACTIVITY_INFO_DIR_PATH);
    const target = files.find(f => f.startsWith("activity-3") && f.endsWith(".json"));
    let data: any = {};
    if (target) {
      const raw = await fs.readFile(path.join(ACTIVITY_INFO_DIR_PATH, target), "utf8");
      data = JSON.parse(raw);
    }
    data.gift_image_cache = cache;
    const fileName = target || "activity-3-仲夏卡牌.json";
    await fs.writeFile(path.join(ACTIVITY_INFO_DIR_PATH, fileName), JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

/**
 * 获取翻牌礼物图片（优先从缓存读取，缓存未命中则从付费记录中查找）
 * @param giftName 礼物名称
 * @param mid 用户ID（用于读取付费记录）
 * @param uname 用户名（用于读取付费记录）
 * @returns 礼物图片URL，未找到则返回空字符串
 */
export async function getCardFlipGiftImage(giftName: string, mid: number, uname: string): Promise<string> {
  const cache = await readCardFlipGiftImageCache();
  if (cache[giftName]) {
    return cache[giftName];
  }

  // 从用户的付费记录中查找匹配的礼物图片
  const records = await readPayRecords(mid, uname);
  const matched = records.find(r => r.gift_name === giftName && r.gift_img);
  if (matched) {
    cache[giftName] = matched.gift_img;
    await writeCardFlipGiftImageCache(cache);
    return matched.gift_img;
  }

  return "";
}

/**
 * 获取翻牌礼物图片缓存（完整缓存）
 * @returns 礼物名称 -> 图片URL的映射
 */
export async function getCardFlipGiftImages(): Promise<Record<string, string>> {
  return await readCardFlipGiftImageCache();
}

/**
 * 保存单个翻牌礼物图片映射到缓存
 * @param giftName 礼物名称
 * @param giftImg 礼物图片URL
 */
export async function saveCardFlipGiftImage(giftName: string, giftImg: string): Promise<void> {
  const cache = await readCardFlipGiftImageCache();
  cache[giftName] = giftImg;
  await writeCardFlipGiftImageCache(cache);
}