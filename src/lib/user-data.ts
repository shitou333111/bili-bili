import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");

// ====== 使用用户表 users-list.json ======

const USERS_LIST_FILE = path.join(DATA_DIR, "users-list.json");

export type UsersListEntry = { mid: number; uname: string; updatedAt: string };

/** 读取 users-list.json（每个用户一条：uid/昵称/最近更新时间） */
export async function readUsersList(): Promise<UsersListEntry[]> {
  try {
    const raw = await fs.readFile(USERS_LIST_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 写入 users-list.json */
export async function writeUsersList(list: UsersListEntry[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(USERS_LIST_FILE, JSON.stringify(list, null, 2), "utf8");
}

/** 更新用户在 users-list.json 中的记录（昵称用最新、更新时间=当前） */
export async function upsertUserInList(mid: number, uname: string): Promise<void> {
  const list = await readUsersList();
  const idx = list.findIndex((u) => u.mid === mid);
  const entry: UsersListEntry = { mid, uname, updatedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  await writeUsersList(list);
}

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

/** Get user's data directory: .data/uid_MID （只用 uid，昵称会变，文件夹名保持不变） */
export function getUserDataDir(mid: number, _uname?: string): string {
  return path.join(DATA_DIR, `uid_${mid}`);
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

// ====== 用户昵称/头像缓存（按用户隔离，存储在 uid_{mid}_{uname}/ 目录下） ======
//
// 每个用户有两个文件：
//   - received-anchors-list.json: 该用户送过礼的主播 { uid: { name, face } }
//   - send-fans-list.json: 给该用户送过礼的粉丝 { uid: { name, face } }

type UserInfoEntry = { name: string; face: string };

/** 获取用户的主播列表文件路径 */
function getReceivedAnchorsFile(userMid: number, uname: string): string {
  return path.join(getUserDataDir(userMid, uname), "received-anchors-list.json");
}

/** 获取用户的粉丝列表文件路径 */
function getSendFansFile(userMid: number, uname: string): string {
  return path.join(getUserDataDir(userMid, uname), "send-fans-list.json");
}

/** 按用户缓存 { uid → UserInfoEntry } */
async function loadUserListFile(filePath: string): Promise<Map<number, UserInfoEntry>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const obj = JSON.parse(raw) as Record<string, UserInfoEntry>;
    const map = new Map<number, UserInfoEntry>();
    for (const [k, v] of Object.entries(obj)) {
      map.set(Number(k), v);
    }
    return map;
  } catch {
    return new Map();
  }
}

async function saveUserListFile(filePath: string, map: Map<number, UserInfoEntry>): Promise<void> {
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const obj: Record<string, UserInfoEntry> = {};
    for (const [k, v] of map) {
      obj[String(k)] = v;
    }
    await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

/** 查询某用户的缓存昵称 */
export async function getCachedName(userMid: number, uname: string, ruid: number): Promise<string | null> {
  const filePath = getSendFansFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  return map.get(ruid)?.name || null;
}

/** 查询某用户的缓存头像 */
export async function getCachedFace(userMid: number, uname: string, ruid: number): Promise<string | null> {
  const filePath = getSendFansFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  return map.get(ruid)?.face || null;
}

/** 写入主播信息到 received-anchors-list.json */
export async function setCachedAnchorInfo(userMid: number, uname: string, ruid: number, name: string, face: string): Promise<void> {
  const filePath = getReceivedAnchorsFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  const existing = map.get(ruid) || { name: "", face: "" };
  map.set(ruid, {
    name: name || existing.name,
    face: face || existing.face,
  });
  await saveUserListFile(filePath, map);
}

/** 写入粉丝信息到 send-fans-list.json */
export async function setCachedFanInfo(userMid: number, uname: string, ruid: number, name: string, face: string): Promise<void> {
  const filePath = getSendFansFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  const existing = map.get(ruid) || { name: "", face: "" };
  map.set(ruid, {
    name: name || existing.name,
    face: face || existing.face,
  });
  await saveUserListFile(filePath, map);
}

/** 获取某用户的完整粉丝列表 { uid: { name, face } }（供前端 /api/faces 使用） */
export async function getSendFansList(userMid: number, uname: string): Promise<Record<string, UserInfoEntry>> {
  const filePath = getSendFansFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  const obj: Record<string, UserInfoEntry> = {};
  for (const [k, v] of map) {
    obj[String(k)] = v;
  }
  return obj;
}

/** 获取某用户的完整主播列表 { uid: { name, face } } */
export async function getReceivedAnchorsList(userMid: number, uname: string): Promise<Record<string, UserInfoEntry>> {
  const filePath = getReceivedAnchorsFile(userMid, uname);
  const map = await loadUserListFile(filePath);
  const obj: Record<string, UserInfoEntry> = {};
  for (const [k, v] of map) {
    obj[String(k)] = v;
  }
  return obj;
}

// ====== 用户个人信息（account-info.json） ======

type AccountInfo = { mid: number; uname: string; face: string };

/** 获取 account-info.json 路径 */
function getAccountInfoFile(userMid: number, uname: string): string {
  return path.join(getUserDataDir(userMid, uname), "account-info.json");
}

/** 保存用户个人信息（登录或信息更新时调用） */
export async function saveAccountInfo(userMid: number, uname: string, face: string): Promise<void> {
  const filePath = getAccountInfoFile(userMid, uname);
  const data: AccountInfo = { mid: userMid, uname, face };
  try {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // ignore
  }
}

/** 读取用户个人信息（admin 模式或需要最新信息时调用） */
export async function loadAccountInfo(userMid: number, uname: string): Promise<AccountInfo | null> {
  const filePath = getAccountInfoFile(userMid, uname);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as AccountInfo;
  } catch {
    return null;
  }
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