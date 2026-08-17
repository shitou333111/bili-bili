/**
 * Tauri 客户端 - 统计类数据获取
 * 在 Tauri 环境下，直接调用 B站 API 获取统计数据，并从本地数据文件读取/写入
 *
 * 逻辑与以下服务器 route 对应，但运行在客户端（自包含实现，不依赖 Node fs/crypto）：
 *  - src/app/api/stats/synthesis/route.ts
 *  - src/app/api/stats/certification/route.ts
 *  - src/app/api/stats/other/route.ts
 *  - src/app/api/stats/blind-box/route.ts
 *
 * 每个导出函数的返回结构 { code, message, data } 与对应服务器 route 完全一致。
 */

import type { Platform } from "./platform/types";
import type { AuthSession } from "./auth/session";
import type { RawGiftRecord } from "./revenue";
import { ensureGiftCatalogLoaded, getGiftImg as getCatalogGiftImg, getGiftName as getCatalogGiftName, getGiftPrice as getCatalogGiftPrice } from "./gift-catalog-client";
import {
  BLIND_BOX_CONFIG,
  BLIND_BOX_API,
  SYNTHESIS_CONFIG,
  TIANXUAN_CONFIG,
  RED_POCKET_CONFIG,
  type SynthesisActivityConfig,
} from "./config";

// ==================== 通用类型 ====================

type ClientResponse<T> = {
  code: number;
  message: string;
  data: T;
};

type JsonObject = Record<string, unknown>;

// ==================== 会话/请求辅助 ====================

/** 构建 B站 Cookie */
export function buildCookie(session: AuthSession): string {
  return session.biliCookies?.length
    ? session.biliCookies.join("; ")
    : `SESSDATA=${session.biliSessdata}`;
}

/** 从平台会话状态中解析当前会话；无会话时返回 null */
export async function resolveSession(platform: Platform): Promise<AuthSession | null> {
  const state = await platform.getSessionState();
  const sid = state.currentSid;
  if (!sid) return null;
  return state.sessions.find((s) => s.sid === sid) ?? null;
}

// ==================== 文件 I/O 辅助（平台层） ====================

async function readJson<T>(platform: Platform, filePath: string): Promise<T | null> {
  try {
    if (!(await platform.exists(filePath))) return null;
    const raw = await platform.readFile(filePath);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function findFileByPrefix(
  platform: Platform,
  dir: string,
  prefix: string,
  suffix: string,
): Promise<string | null> {
  try {
    const files = await platform.readdir(dir);
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(suffix));
    return match ? `${dir}/${match}` : null;
  } catch {
    return null;
  }
}

/** 用户数据目录：dataDir/uid_<mid> */
async function userDataDir(platform: Platform, mid: number): Promise<string> {
  return `${await platform.getDataDir()}/uid_${mid}`;
}

/** 获取北京时间字符串 (UTC+8) */
function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

/** 清理文件名中的非法字符 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

// ==================== 消费记录 ====================

async function readPayRecords(platform: Platform, mid: number, uname: string): Promise<RawGiftRecord[]> {
  const dir = await userDataDir(platform, mid);
  const parsed = await readJson<unknown>(platform, `${dir}/pay-records.json`);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed as RawGiftRecord[];
  return (parsed as { records?: RawGiftRecord[] }).records ?? [];
}

// ==================== 合成活动记录（按用户，uid_<mid>/synthesis-*） ====================

async function saveSynthesisRecords(
  platform: Platform,
  mid: number,
  uname: string,
  activityId: string,
  records: unknown[],
  activityName?: string,
): Promise<void> {
  const dir = await userDataDir(platform, mid);
  const safeName = activityName ? sanitizeFileName(activityName) : "";
  const fileName = safeName
    ? `synthesis-${activityId}-${safeName}-records.json`
    : `synthesis-${activityId}-records.json`;
  const filePath = `${dir}/${fileName}`;

  if (safeName) {
    try {
      const files = await platform.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`synthesis-${activityId}`) && f.endsWith("-records.json") && f !== fileName) {
          await platform.unlink(`${dir}/${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = { exportedAt: getBeijingTime(), totalRecords: records.length, records };
  await platform.mkdir(dir);
  await platform.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readSynthesisRecords(
  platform: Platform,
  mid: number,
  uname: string,
  activityId: string,
): Promise<unknown[]> {
  const dir = await userDataDir(platform, mid);
  const filePath = await findFileByPrefix(platform, dir, `synthesis-${activityId}`, "-records.json");
  if (!filePath) return [];
  const parsed = await readJson<unknown>(platform, filePath);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  return (parsed as { records?: unknown[] }).records ?? [];
}

// ==================== 合成活动信息缓存（共享 activity_info/） ====================

async function activityInfoDir(platform: Platform): Promise<string> {
  return `${await platform.getDataDir()}/activity_info`;
}

async function getSynthesisActivityInfo(platform: Platform, activityId: string): Promise<JsonObject | null> {
  const dir = await activityInfoDir(platform);
  const filePath = await findFileByPrefix(platform, dir, activityId, ".json");
  if (!filePath) return null;
  return readJson<JsonObject>(platform, filePath);
}

async function saveSynthesisActivityInfo(platform: Platform, activityId: string, info: JsonObject): Promise<void> {
  const dir = await activityInfoDir(platform);
  const activityName = info?.name ? sanitizeFileName(String(info.name)) : "";
  const fileName = activityName ? `${activityId}-${activityName}.json` : `${activityId}.json`;
  const filePath = `${dir}/${fileName}`;

  if (activityName) {
    try {
      const files = await platform.readdir(dir);
      for (const f of files) {
        if (f.startsWith(activityId) && f.endsWith(".json") && f !== fileName) {
          await platform.unlink(`${dir}/${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = { ...info, updated_at: getBeijingTime() };
  await platform.mkdir(dir);
  await platform.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ==================== 天选/红包礼物 ID 累积（按用户本地存储，不再共享） ====================

type SpecialGiftDb = {
  tianxuan_gift_ids?: number[];
  red_pocket_gift_ids?: number[];
};

async function specialGiftDbPath(platform: Platform, mid: number): Promise<string> {
  return `${await platform.getDataDir()}/uid_${mid}/special-gift-ids.json`;
}

async function readSpecialGiftDb(platform: Platform, mid: number): Promise<SpecialGiftDb> {
  return (await readJson<SpecialGiftDb>(platform, await specialGiftDbPath(platform, mid))) ?? {};
}

async function writeSpecialGiftDb(platform: Platform, mid: number, db: SpecialGiftDb): Promise<void> {
  const filePath = await specialGiftDbPath(platform, mid);
  await platform.mkdir(`${await platform.getDataDir()}/uid_${mid}`);
  await platform.writeFile(filePath, JSON.stringify(db, null, 2));
}

/**
 * 统一上传：收集当前账号本地的所有数据文件（用户私有 uid_<mid>/ 下全部文件 +
 * 全局盲盒信息 blindbox_info/*），打包成一次 uploadUserData 上传。
 * uploadUserData 按文件内容哈希判断：仅发送内容与上次上传不同的文件；
 * 若全部未变则直接跳过（不发请求），从而避免频繁刷新时重复上传旧数据。
 * 仅本机登录账号（source !== "server"）上传；服务器账号无 B站 凭证仅查看，不上传。
 * 说明：礼物图标/目录改由各客户端直连 B站 giftConfig API 获取，不再上传共享 gift-db。
 */
export async function uploadAllUserData(platform: Platform): Promise<void> {
  try {
    const state = await platform.getSessionState();
    const session = state.sessions.find((s) => s.sid === state.currentSid);
    if (!session || session.source === "server") return;
    const files: Record<string, string> = {};
    // 1) 用户私有数据：uid_<mid>/ 下所有文件（跳过内部文件）
    const userDir = await userDataDir(platform, session.mid);
    try {
      const names = await platform.readdir(userDir);
      for (const name of names) {
        if (name.startsWith("_")) continue;
        try { files[name] = await platform.readFile(`${userDir}/${name}`); } catch { /* 单个文件读取失败则跳过 */ }
      }
    } catch { /* 目录不存在 */ }
    // 2) 全局盲盒信息
    Object.assign(files, await collectBlindBoxInfoUploads(platform));
    await platform.uploadUserData(session.mid, session.uname, files);
  } catch (e) {
    console.warn("[Upload] 统一上传失败:", e instanceof Error ? e.message : String(e));
  }
}

async function getAccumulatedTianxuanGiftIds(platform: Platform, mid: number, currentIds: number[]): Promise<number[]> {
  const db = await readSpecialGiftDb(platform, mid);
  const historicalIds = db.tianxuan_gift_ids || [];
  const merged = [...new Set([...historicalIds, ...currentIds])];
  if (currentIds.length > 0) {
    db.tianxuan_gift_ids = merged;
    await writeSpecialGiftDb(platform, mid, db);
  }
  return merged;
}

async function getAccumulatedRedPocketGiftIds(platform: Platform, mid: number, currentIds: number[]): Promise<number[]> {
  const db = await readSpecialGiftDb(platform, mid);
  const historicalIds = db.red_pocket_gift_ids || [];
  const merged = [...new Set([...historicalIds, ...currentIds])];
  if (currentIds.length > 0) {
    db.red_pocket_gift_ids = merged;
    await writeSpecialGiftDb(platform, mid, db);
  }
  return merged;
}

// 礼物图标统一由 gift-catalog-client 从 B站 giftConfig API 获取（无需登录、12h 缓存），
// 不再维护本地 gift-db.json。此处不再导出 readGiftDb/saveGiftsToDb/getGiftImg。

// ==================== 翻牌礼物图片缓存（activity_info/activity-3-*.json 的 gift_image_cache） ====================

async function readCardFlipGiftImageCache(platform: Platform): Promise<Record<string, string>> {
  try {
    const dir = await activityInfoDir(platform);
    const files = await platform.readdir(dir);
    const target = files.find((f) => f.startsWith("activity-3") && f.endsWith(".json"));
    if (!target) return {};
    const data = await readJson<JsonObject>(platform, `${dir}/${target}`);
    return (data?.gift_image_cache as Record<string, string>) || {};
  } catch {
    return {};
  }
}

async function writeCardFlipGiftImageCache(platform: Platform, cache: Record<string, string>): Promise<void> {
  try {
    const dir = await activityInfoDir(platform);
    const files = await platform.readdir(dir);
    const target = files.find((f) => f.startsWith("activity-3") && f.endsWith(".json"));
    let data: JsonObject = {};
    if (target) {
      const raw = await readJson<JsonObject>(platform, `${dir}/${target}`);
      data = raw ?? {};
    }
    data.gift_image_cache = cache;
    const fileName = target || "activity-3-仲夏卡牌.json";
    await platform.mkdir(dir);
    await platform.writeFile(`${dir}/${fileName}`, JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

async function getCardFlipGiftImage(
  platform: Platform,
  giftName: string,
  mid: number,
  uname: string,
): Promise<string> {
  const cache = await readCardFlipGiftImageCache(platform);
  if (cache[giftName]) return cache[giftName];
  const records = await readPayRecords(platform, mid, uname);
  const matched = records.find((r) => r.gift_name === giftName && r.gift_img);
  if (matched) {
    cache[giftName] = matched.gift_img;
    await writeCardFlipGiftImageCache(platform, cache);
    return matched.gift_img;
  }
  return "";
}

async function getCardFlipGiftImages(platform: Platform): Promise<Record<string, string>> {
  return readCardFlipGiftImageCache(platform);
}

async function saveCardFlipGiftImage(platform: Platform, giftName: string, giftImg: string): Promise<void> {
  const cache = await readCardFlipGiftImageCache(platform);
  cache[giftName] = giftImg;
  await writeCardFlipGiftImageCache(platform, cache);
}

// ==================== 盲盒信息（共享 blindbox_info/） ====================

type BlindBoxGift = {
  gift_id: number;
  price: number;
  gift_name: string;
  gift_img: string;
  is_win_gift: number;
  chance: string;
};

type BlindBoxInfo = {
  blind_box_id: number;
  blind_box_name: string;
  blind_box_img: string;
  blind_price: number;
  gifts: BlindBoxGift[];
  updated_at: string;
};

async function blindBoxInfoDir(platform: Platform): Promise<string> {
  return `${await platform.getDataDir()}/blindbox_info`;
}

async function getBlindBoxInfo(
  platform: Platform,
  _mid: number,
  _uname: string,
  blindBoxId: number,
): Promise<BlindBoxInfo | null> {
  const dir = await blindBoxInfoDir(platform);
  return readJson<BlindBoxInfo>(platform, `${dir}/${blindBoxId}.json`);
}

/** 读取本地所有盲盒信息（对应服务器 getAllBlindBoxInfo） */
async function getAllBlindBoxInfo(platform: Platform): Promise<Record<number, BlindBoxInfo>> {
  const dir = await blindBoxInfoDir(platform);
  const result: Record<number, BlindBoxInfo> = {};
  try {
    const files = await platform.readdir(dir);
    for (const file of files) {
      const match = file.match(/^(\d+)\.json$/);
      if (!match) continue;
      const blindBoxId = Number(match[1]);
      const info = await readJson<BlindBoxInfo>(platform, `${dir}/${file}`);
      if (info) result[blindBoxId] = info;
    }
  } catch {
    // 目录不存在则返回空
  }
  return result;
}

async function saveBlindBoxInfo(
  platform: Platform,
  _mid: number,
  _uname: string,
  blindBoxId: number,
  apiData: {
    gift_name: string;
    gift_img: string;
    price: number;
    gifts: BlindBoxGift[];
  },
): Promise<void> {
  const dir = await blindBoxInfoDir(platform);
  const info: BlindBoxInfo = {
    blind_box_id: blindBoxId,
    blind_box_name: apiData.gift_name,
    blind_box_img: apiData.gift_img,
    blind_price: apiData.price,
    gifts: apiData.gifts,
    updated_at: getBeijingTime(),
  };
  await platform.mkdir(dir);
  await platform.writeFile(`${dir}/${blindBoxId}.json`, JSON.stringify(info, null, 2));
}

/**
 * 收集本地盲盒信息为上传文件映射（key = "blindbox_info/<id>.json"）。
 * 盲盒信息是公开数据、人人相同，随用户数据一并上传；服务器端仅在全局文件缺失时写入，
 * 已存在则丢弃，因此不会因不同用户重复上传产生覆盖问题。
 */
async function collectBlindBoxInfoUploads(platform: Platform): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const dir = await blindBoxInfoDir(platform);
  try {
    const files = await platform.readdir(dir);
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      const info = await readJson<BlindBoxInfo>(platform, `${dir}/${file}`);
      if (info) result[`blindbox_info/${file}`] = JSON.stringify(info);
    }
  } catch {
    // 目录不存在则返回空
  }
  return result;
}

export { getBlindBoxInfo, getAllBlindBoxInfo, saveBlindBoxInfo, blindBoxInfoDir, collectBlindBoxInfoUploads, type BlindBoxInfo, type BlindBoxGift };

// ==================== 盲盒抽取记录（按用户，uid_<mid>/blind-box-*） ====================

type BlindBoxDrawRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  original_gift_id: number;
  original_gift_name: string;
  gift_img: string;
  timestamp: string;
  ruid: number;
  rname: string;
};

async function readBlindBoxRecords(
  platform: Platform,
  mid: number,
  uname: string,
  blindBoxId: number,
): Promise<BlindBoxDrawRecord[]> {
  const dir = await userDataDir(platform, mid);
  const filePath = await findFileByPrefix(platform, dir, `blind-box-${blindBoxId}`, "-records.json");
  if (!filePath) return [];
  const parsed = await readJson<unknown>(platform, filePath);
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed as BlindBoxDrawRecord[];
  return (parsed as { records?: BlindBoxDrawRecord[] }).records ?? [];
}

async function saveBlindBoxRecords(
  platform: Platform,
  mid: number,
  uname: string,
  blindBoxId: number,
  records: BlindBoxDrawRecord[],
  blindBoxName?: string,
): Promise<void> {
  const dir = await userDataDir(platform, mid);
  const safeName = blindBoxName ? sanitizeFileName(blindBoxName) : "";
  const fileName = safeName
    ? `blind-box-${blindBoxId}-${safeName}-records.json`
    : `blind-box-${blindBoxId}-records.json`;
  const filePath = `${dir}/${fileName}`;

  if (safeName) {
    try {
      const files = await platform.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`blind-box-${blindBoxId}`) && f.endsWith("-records.json") && f !== fileName) {
          await platform.unlink(`${dir}/${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = { exportedAt: getBeijingTime(), records };
  await platform.mkdir(dir);
  await platform.writeFile(filePath, JSON.stringify(data, null, 2));
}

// ==================== 用户昵称解析（与 gift-api.getUserNameByUid 对应） ====================

const userNameCache = new Map<number, string>();

async function fetchUserNameByUid(platform: Platform, mid: number): Promise<string | null> {
  try {
    const url = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
    const response = await platform.fetchBilibiliJson<{
      code: number;
      data?: { card?: { name: string } } | null;
    }>({ url });
    if (response.code === 0 && response.data?.card?.name) {
      return response.data.card.name;
    }
    return null;
  } catch {
    return null;
  }
}

async function getCachedName(
  platform: Platform,
  userMid: number,
  uname: string,
  ruid: number,
): Promise<string | null> {
  const dir = await userDataDir(platform, userMid);
  const obj = await readJson<Record<string, { name: string; face: string }>>(
    platform,
    `${dir}/send-fans-list.json`,
  );
  return obj?.[String(ruid)]?.name || null;
}

async function setCachedAnchorInfo(
  platform: Platform,
  userMid: number,
  uname: string,
  ruid: number,
  name: string,
  face: string,
): Promise<void> {
  const dir = await userDataDir(platform, userMid);
  const filePath = `${dir}/received-anchors-list.json`;
  const obj = (await readJson<Record<string, { name: string; face: string }>>(platform, filePath)) ?? {};
  const existing = obj[String(ruid)] || { name: "", face: "" };
  obj[String(ruid)] = { name: name || existing.name, face: face || existing.face };
  await platform.mkdir(dir);
  await platform.writeFile(filePath, JSON.stringify(obj, null, 2));
}

async function getUserNameByUid(
  platform: Platform,
  mid: number,
  requesterMid?: number,
  requesterUname?: string,
): Promise<string> {
  if (userNameCache.has(mid)) {
    return userNameCache.get(mid)!;
  }
  if (requesterMid) {
    const cached = await getCachedName(platform, requesterMid, requesterUname || "", mid);
    if (cached) {
      userNameCache.set(mid, cached);
      return cached;
    }
  }
  const name = await fetchUserNameByUid(platform, mid);
  if (name) {
    userNameCache.set(mid, name);
    if (requesterMid) {
      await setCachedAnchorInfo(platform, requesterMid, requesterUname || "", mid, name, "");
    }
    return name;
  }
  return `主播${mid}`;
}

export { getUserNameByUid };

// ==================== 配置解析（与 config-override 对应，基于远程 admin-config） ====================

type EffectiveBlindBoxConfig = {
  xindong: number;
  current_activity_blind_box_ids: number[];
  current_activity_blind_box_id: number | null;
  icons: Record<number, string>;
};

export type { EffectiveBlindBoxConfig };

async function getEffectiveSynthesisConfig(platform: Platform) {
  const adminConfig = (await platform.fetchRemoteConfig()) as JsonObject | null;
  if (!adminConfig || !Array.isArray(adminConfig.synthesis_activities)) {
    return SYNTHESIS_CONFIG;
  }
  return {
    current_activity: (adminConfig.synthesis_activities as SynthesisActivityConfig[]).filter(
      (a) => a.active !== false,
    ),
  };
}

export async function getEffectiveBlindBoxConfig(platform: Platform): Promise<EffectiveBlindBoxConfig> {
  const adminConfig = (await platform.fetchRemoteConfig()) as JsonObject & {
    blind_boxes?: Array<{ id: number; icon: string }>;
    current_activity_blind_box_ids?: number[];
  } | null;

  if (!adminConfig || !Array.isArray(adminConfig.blind_boxes)) {
    const ids: number[] = [];
    if (BLIND_BOX_CONFIG.current_activity_blind_box_id) ids.push(BLIND_BOX_CONFIG.current_activity_blind_box_id);
    if (!ids.includes(BLIND_BOX_CONFIG.xindong)) ids.unshift(BLIND_BOX_CONFIG.xindong);
    const xi = ids.indexOf(BLIND_BOX_CONFIG.xindong);
    if (!ids.includes(BLIND_BOX_CONFIG.lucky)) ids.splice(xi + 1, 0, BLIND_BOX_CONFIG.lucky);
    return {
      xindong: BLIND_BOX_CONFIG.xindong,
      current_activity_blind_box_ids: ids,
      current_activity_blind_box_id: ids.length > 0 ? ids[0] : null,
      icons: BLIND_BOX_CONFIG.icons,
    };
  }

  const icons: Record<number, string> = { ...BLIND_BOX_CONFIG.icons };
  const validBoxIds = new Set<number>();
  validBoxIds.add(BLIND_BOX_CONFIG.xindong);
  validBoxIds.add(BLIND_BOX_CONFIG.lucky);
  for (const box of adminConfig.blind_boxes) {
    if (box.id > 0) {
      icons[box.id] = box.icon;
      validBoxIds.add(box.id);
    }
  }
  const checkedIds = new Set((adminConfig.current_activity_blind_box_ids ?? []).filter((id) => validBoxIds.has(id)));
  const filteredIds: number[] = [];
  for (const box of adminConfig.blind_boxes) {
    if (box.id > 0 && checkedIds.has(box.id)) filteredIds.push(box.id);
  }
  if (!filteredIds.includes(BLIND_BOX_CONFIG.xindong)) filteredIds.unshift(BLIND_BOX_CONFIG.xindong);
  const xindongIdx = filteredIds.indexOf(BLIND_BOX_CONFIG.xindong);
  const luckyIdx = filteredIds.indexOf(BLIND_BOX_CONFIG.lucky);
  if (luckyIdx < 0) {
    filteredIds.splice(xindongIdx + 1, 0, BLIND_BOX_CONFIG.lucky);
  } else if (luckyIdx !== xindongIdx + 1) {
    filteredIds.splice(luckyIdx, 1);
    filteredIds.splice(xindongIdx + 1, 0, BLIND_BOX_CONFIG.lucky);
  }
  return {
    xindong: BLIND_BOX_CONFIG.xindong,
    current_activity_blind_box_ids: filteredIds,
    current_activity_blind_box_id: filteredIds.length > 0 ? filteredIds[0] : null,
    icons,
  };
}

// ==================== B站 API 请求（平台层） ====================

async function fetchTianxuanGiftList(platform: Platform, cookie: string): Promise<Array<{ id: number; name: string }>> {
  try {
    const response = await platform.fetchBilibiliJson<{
      code: number;
      data?: { list?: Array<{ id: number; name: string }> } | null;
    }>({ url: TIANXUAN_CONFIG.url, cookie });
    if (response.code === 0 && response.data?.list) {
      return response.data.list.map((g) => ({ id: g.id, name: g.name }));
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchRedPocketGiftList(platform: Platform, cookie: string): Promise<Array<{ id: number; name: string }>> {
  try {
    const url = `${RED_POCKET_CONFIG.url}?room_id=23915535&ruid=488750234&platform=pc&rp_type=1`;
    const response = await platform.fetchBilibiliJson<{
      code: number;
      data?: {
        item?: Array<{ award_info?: Array<{ award_id: number; award_name: string }> }>;
      } | null;
    }>({ url, cookie });
    if (response.code === 0 && response.data?.item) {
      const giftMap = new Map<number, string>();
      for (const item of response.data.item) {
        if (item.award_info) {
          for (const award of item.award_info) {
            if (award.award_id && !giftMap.has(award.award_id)) {
              giftMap.set(award.award_id, award.award_name);
            }
          }
        }
      }
      return Array.from(giftMap.entries()).map(([id, name]) => ({ id, name }));
    }
    return [];
  } catch {
    return [];
  }
}

// ---- 合成活动信息 ----

type SynthesisActivityInfo = {
  name: string;
  icon?: string;
  resource?: Record<string, unknown>;
  rewards?: Record<string, unknown>[];
  gift_info?: Array<{
    gift_id: number;
    gift_name: string;
    gift_img: string;
    gift_price: number;
  }>;
  gift_image_cache?: Record<string, string>;
};

async function fetchSynthesisActivityInfo(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<SynthesisActivityInfo | null> {
  try {
    if (activity.type === "slot_draw") return fetchSlotDrawInfo(platform, cookie, activity);
    if (activity.type === "material_package") return fetchMaterialPackageInfo(platform, cookie, activity);
    if (activity.type === "card_flip") return { name: "仲夏卡牌" };
    return { name: activity.id };
  } catch {
    return { name: activity.id };
  }
}

async function fetchSlotDrawInfo(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<SynthesisActivityInfo> {
  const response = await platform.fetchBilibiliJson<{
    code: number;
    data?: { activity_name?: string; activity_img?: string; gift_info?: SynthesisActivityInfo["gift_info"] } | null;
  }>({ url: activity.info_url, cookie });
  if (response.code === 0 && response.data) {
    const result: SynthesisActivityInfo = {
      name: response.data.activity_name || activity.id,
      icon: response.data.activity_img,
    };
    if (response.data.gift_info) result.gift_info = response.data.gift_info;
    return result;
  }
  return { name: activity.id };
}

async function fetchMaterialPackageInfo(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<SynthesisActivityInfo> {
  const response = await platform.fetchBilibiliJson<{
    code: number;
    data?: {
      act_name?: string;
      resource?: Record<string, unknown>;
      rewards?: Record<string, unknown>[];
    } | null;
  }>({ url: activity.info_url, cookie });
  if (response.code === 0 && response.data) {
    const result: SynthesisActivityInfo = {
      name: response.data.act_name || activity.id,
      icon: (response.data.resource?.gift_1 as string) || undefined,
    };
    if (response.data.resource) result.resource = response.data.resource;
    if (response.data.rewards) result.rewards = response.data.rewards;
    return result;
  }
  return { name: activity.id };
}

// ---- 合成活动记录 ----

type SlotDrawRawRecord = {
  goods_num: number;
  pay_price: number;
  refund_price: number;
  record_type: number;
  status: number;
  mtime: string;
  gift_info: {
    gift_id: number;
    gift_name: string;
    gift_img: string;
    gift_price: number;
  } | null;
  ruid: number;
};

type MaterialPackageRawRecord = {
  ruid: number;
  synthetic_time: number;
  synthetic_result: number;
  gift_name: string;
  gift_price: number;
  materials: Array<{ name: string; num: number }>;
  materials_price: number;
};

type CardFlipRawRecord = {
  reward_name: string;
  reward_value: number;
  card_idx: number[];
  ruid: number;
  settle_time?: number;
  [key: string]: unknown;
};

type SynthesisActivityRawRecord = SlotDrawRawRecord | MaterialPackageRawRecord | CardFlipRawRecord;

async function fetchSynthesisActivityRecords(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<SynthesisActivityRawRecord[]> {
  // 注意：此处不要吞掉错误。一旦这里把异常吞掉并返回空数组，
  // 上层 fetchSynthesisStats 会把空数组当作“有效空数据”保存，覆盖本地缓存，
  // 导致活动卡片数据丢失。让异常向上传播，由上层回退到本地缓存。
  if (activity.type === "slot_draw") return fetchSlotDrawRecords(platform, cookie, activity);
  if (activity.type === "material_package") return fetchMaterialPackageRecords(platform, cookie, activity);
  if (activity.type === "card_flip") return fetchCardFlipRecords(platform, cookie, activity);
  return [];
}

/**
 * 带重试的 B站 JSON 请求。
 * 网络瞬时失败（连接/TLS 抖动）时指数退避重试，避免单次失败中断整段翻页。
 */
async function fetchSynthesisJsonWithRetry<T>(
  platform: Platform,
  url: string,
  cookie: string,
): Promise<T | null> {
  const MAX_RETRIES = 3;
  const BACKOFF_MS = 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await platform.fetchBilibiliJson<T>({ url, cookie });
    } catch (err: any) {
      lastErr = err;
      const isRateLimit = err?.message?.includes("412");
      const delay = isRateLimit ? 30_000 : BACKOFF_MS * Math.pow(2, attempt);
      if (attempt < MAX_RETRIES) {
        console.warn(`[SynthesisStats] 请求失败，等待${delay}ms后重试 ${attempt + 1}/${MAX_RETRIES}: ${err?.message || err}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function fetchSlotDrawRecords(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<SlotDrawRawRecord[]> {
  const allRecords: SlotDrawRawRecord[] = [];
  let offset = 0;
  while (true) {
    const url = `${activity.record_url}&offset=${offset}`;
    const response = await fetchSynthesisJsonWithRetry<{
      code: number;
      data?: { record_info?: Array<SlotDrawRawRecord>; next_offset: number } | null;
    }>(platform, url, cookie);
    if (!response || response.code !== 0 || !response.data) break;
    const records = response.data.record_info ?? [];
    allRecords.push(...records);
    if (response.data.next_offset === -1 || records.length === 0) break;
    offset = response.data.next_offset;
  }
  return allRecords;
}

async function fetchMaterialPackageRecords(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<MaterialPackageRawRecord[]> {
  const allRecords: MaterialPackageRawRecord[] = [];
  let page = 1;
  while (true) {
    const url = `${activity.record_url}&page=${page}&page_size=10`;
    const response = await fetchSynthesisJsonWithRetry<{
      code: number;
      data?: { items?: MaterialPackageRawRecord[]; has_more?: boolean } | null;
    }>(platform, url, cookie);
    if (!response || response.code !== 0 || !response.data) break;
    const items = response.data.items ?? [];
    allRecords.push(...items);
    if (!response.data.has_more || items.length === 0) break;
    page++;
  }
  return allRecords;
}

async function fetchCardFlipRecords(
  platform: Platform,
  cookie: string,
  activity: SynthesisActivityConfig,
): Promise<CardFlipRawRecord[]> {
  const allRecords: CardFlipRawRecord[] = [];
  let page = 1;
  while (true) {
    const url = `${activity.record_url}&page=${page}&page_size=10`;
    const response = await fetchSynthesisJsonWithRetry<{
      code: number;
      data?: { items?: CardFlipRawRecord[]; has_more?: boolean } | null;
    }>(platform, url, cookie);
    if (!response || response.code !== 0 || !response.data) break;
    const items = response.data.items ?? [];
    allRecords.push(...items);
    if (!response.data.has_more || items.length === 0) break;
    page++;
  }
  return allRecords;
}

// ---- 盲盒 ----

type BlindBoxCheckResult = {
  isBlindBox: boolean;
  blindPrice: number;
  blindGiftName: string;
  gifts: BlindBoxGift[];
};

export async function checkBlindBox(platform: Platform, giftId: number, cookie: string): Promise<BlindBoxCheckResult | null> {
  try {
    const url = `${BLIND_BOX_API.blindFirstWin}?gift_id=${giftId}`;
    // 该接口位于 api.live.bilibili.com，必须使用 live 请求头（Referer: live.bilibili.com）
    // 才能返回盲盒名称 blind_gift_name 与爆出礼物信息；用 WEB 请求头（Referer: www.bilibili.com）
    // 会导致拿不到名称/单价，显示"盲盒_<id>"、单价0。
    const response = await platform.fetchBilibiliJson<{
      code: number;
      data?: {
        blind_price: number;
        blind_gift_name: string;
        gifts: Array<{
          gift_id: number;
          price: number;
          gift_name: string;
          gift_img: string;
          is_win_gift: number;
          chance: string;
        }>;
      } | null;
    }>({ url, cookie, live: true });
    if (response.code === 0 && response.data?.gifts && response.data.gifts.length > 0) {
      return {
        isBlindBox: true,
        blindPrice: Math.round(response.data.blind_price / 100),
        blindGiftName: response.data.blind_gift_name,
        gifts: response.data.gifts.map((g) => ({
          gift_id: g.gift_id,
          price: Math.round(g.price / 100),
          gift_name: g.gift_name,
          gift_img: g.gift_img,
          is_win_gift: g.is_win_gift,
          chance: g.chance,
        })),
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchBlindBoxDrawStream(
  platform: Platform,
  giftId: number,
  cookie: string,
  latestTimestamp?: string,
): Promise<BlindBoxDrawRecord[]> {
  const allRecords: BlindBoxDrawRecord[] = [];
  let page = 1;
  const MAX_PAGES = 100;
  let nextParams: Record<string, unknown> | undefined;

  try {
    while (page <= MAX_PAGES) {
      let url = `${BLIND_BOX_API.drawStream}?gift_id=${giftId}&page_size=50`;
      if (nextParams) {
        for (const [key, value] of Object.entries(nextParams)) {
          if (key === "have_more") continue;
          if (value !== undefined) {
            url += `&${key}=${encodeURIComponent(String(value))}`;
          }
        }
      }

      const response = await platform.fetchBilibiliJson<{
        code: number;
        data?: {
          list?: Array<BlindBoxDrawRecord>;
          params?: Record<string, unknown> & { have_more?: boolean };
          isMore?: string | number;
          has_more?: number;
        } | null;
      }>({ url, cookie });

      if (response.code !== 0 || !response.data?.list) break;
      const list = response.data.list;
      if (list.length === 0) break;

      let hasOverlap = false;
      for (const item of list) {
        if (latestTimestamp && item.timestamp <= latestTimestamp) {
          hasOverlap = true;
          break;
        }
        allRecords.push({
          gift_id: item.gift_id,
          gift_name: item.gift_name,
          gift_num: item.gift_num,
          original_gift_id: item.original_gift_id,
          original_gift_name: item.original_gift_name,
          gift_img: item.gift_img,
          timestamp: item.timestamp,
          ruid: item.ruid,
          rname: item.rname,
        });
      }

      if (hasOverlap) break;

      nextParams = response.data.params as Record<string, unknown> | undefined;
      const params = response.data.params;
      const isMore = response.data.isMore;
      let haveMore = false;
      if (params?.have_more !== undefined) haveMore = params.have_more;
      else if (isMore !== undefined) haveMore = isMore === "1" || isMore === 1;
      else if (response.data.has_more !== undefined) haveMore = response.data.has_more === 1;

      if (!haveMore) break;
      page++;
    }
    return allRecords;
  } catch {
    return allRecords;
  }
}

// ==================== 合成活动盈亏计算器（与 gift-db 对应） ====================

type SynthesisGiftInfo = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  gift_price: number;
  count: number;
};

type SynthesisAnchorInfo = {
  ruid: number;
  rname: string;
  totalSpent: number;
  totalEarned: number;
};

type SynthesisDetailedRecord = {
  ruid: number;
  rname: string;
  gift_name: string;
  gift_price: number;
  gift_img: string;
  spent: number;
  profit: number;
  synthetic_result: number;
  date: string;
  synthetic_time: number;
  coin_type?: string;
  gift_id?: number;
};

type SynthesisActivityProfitResult = {
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  replaceCount: number;
  synthesisCount: number;
  successCount: number;
  giftList: SynthesisGiftInfo[];
  anchors: SynthesisAnchorInfo[];
  detailedRecords: SynthesisDetailedRecord[];
};

type SynthesisCertification = {
  type: "lucky" | "unlucky" | "rich";
  ruid: number;
  rname: string;
  gift_name: string;
  gift_price: number;
  gift_img: string;
  spent: number;
  profit: number;
  date: string;
  count?: number;
};

type SynthesisActivityStats = {
  id: string;
  type: string;
  name: string;
  icon?: string;
  profit: SynthesisActivityProfitResult;
  certifications: SynthesisCertification[];
};

interface SynthesisProfitCalculator {
  calculate(records: unknown[], activityInfo?: JsonObject | null): SynthesisActivityProfitResult;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}.${month}.${day} ${hours}:${minutes}`;
}

class SlotDrawCalculator implements SynthesisProfitCalculator {
  calculate(records: unknown[], activityInfo?: JsonObject | null): SynthesisActivityProfitResult {
    const recs = records as SlotDrawRawRecord[];
    let totalSpent = 0;
    let totalEarned = 0;
    let drawCount = 0;
    let replaceCount = 0;
    let synthesisCount = 0;
    const giftMap = new Map<number, SynthesisGiftInfo>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageMap = new Map<string, string>();
    const giftInfo = activityInfo?.gift_info as Array<{
      gift_name: string;
      gift_img: string;
    }> | undefined;
    if (giftInfo) {
      for (const gift of giftInfo) giftImageMap.set(gift.gift_name, gift.gift_img);
    }

    const anchorCurrentGift = new Map<number, { name: string; price: number; img: string } | null>();

    const synthesizedAnchors = new Set<number>();
    for (const record of recs) {
      if (record.status === 1 && record.record_type === 4 && record.gift_info) {
        synthesizedAnchors.add(record.ruid);
      }
    }

    for (const record of recs) {
      if (record.status !== 1) continue;

      const anchor = anchorMap.get(record.ruid) || { ruid: record.ruid, rname: "", totalSpent: 0, totalEarned: 0 };
      const timestamp = Math.floor(new Date(record.mtime.replace(/-/g, "/")).getTime() / 1000);
      const dateStr = record.mtime.replace(/-/g, ".");

      if (record.record_type === 4 && record.gift_info) {
        const price = record.gift_info.gift_price / 100;
        totalEarned += price;
        anchor.totalEarned += price;
        synthesisCount++;

        const existing = giftMap.get(record.gift_info.gift_id);
        if (existing) {
          existing.count++;
        } else {
          const giftImg = giftImageMap.get(record.gift_info.gift_name) || record.gift_info.gift_img;
          giftMap.set(record.gift_info.gift_id, {
            gift_id: record.gift_info.gift_id,
            gift_name: record.gift_info.gift_name,
            gift_img: giftImg,
            gift_price: price,
            count: 1,
          });
        }

        const giftImg = giftImageMap.get(record.gift_info.gift_name) || record.gift_info.gift_img;
        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_info.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent: 0,
          profit: price,
          synthetic_result: 1,
          date: dateStr,
          synthetic_time: timestamp,
        });

        anchorCurrentGift.set(record.ruid, { name: record.gift_info.gift_name, price, img: giftImg });
      } else if (record.record_type === 1 || record.record_type === 3) {
        if (!synthesizedAnchors.has(record.ruid)) continue;
        const spent = record.pay_price / 100;
        totalSpent += spent;
        anchor.totalSpent += spent;
        if (record.record_type === 1) drawCount++;
        else replaceCount++;

        const currentGift = anchorCurrentGift.get(record.ruid);
        const giftName = currentGift?.name || "未合成";
        const giftImg = currentGift?.img || "";
        const giftPrice = currentGift?.price || 0;
        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: giftName,
          gift_price: giftPrice,
          gift_img: giftImg,
          spent,
          profit: -spent,
          synthetic_result: 0,
          date: dateStr,
          synthetic_time: timestamp,
        });
      }

      anchorMap.set(record.ruid, anchor);
    }

    const giftList = Array.from(giftMap.values()).sort((a, b) => b.gift_price - a.gift_price);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
      totalSpent,
      totalEarned,
      profit: totalEarned - totalSpent,
      drawCount,
      replaceCount,
      synthesisCount,
      successCount: synthesisCount,
      giftList,
      anchors,
      detailedRecords,
    };
  }
}

class MaterialPackageCalculator implements SynthesisProfitCalculator {
  calculate(records: unknown[], activityInfo?: JsonObject | null): SynthesisActivityProfitResult {
    const recs = records as MaterialPackageRawRecord[];
    let totalSpent = 0;
    let totalEarned = 0;
    let synthesisCount = 0;
    let successCount = 0;
    const giftMap = new Map<string, SynthesisGiftInfo & { gift_key: string }>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageMap = new Map<string, string>();
    if (activityInfo?.resource) {
      for (const [key, value] of Object.entries(activityInfo.resource)) {
        if (key.startsWith("gift_") && typeof value === "string") giftImageMap.set(key, value);
      }
    }
    const giftPriceMap = new Map<number, string>();
    for (const [key, img] of giftImageMap.entries()) {
      const idx = parseInt(key.split("_")[1]);
      giftPriceMap.set(idx, img);
    }

    for (const record of recs) {
      const isFull = record.synthetic_result === 2;
      const spent = isFull ? 0 : record.materials_price / 100;
      totalSpent += spent;
      synthesisCount++;

      const anchor = anchorMap.get(record.ruid) || { ruid: record.ruid, rname: "", totalSpent: 0, totalEarned: 0 };
      anchor.totalSpent += spent;

      const price = record.gift_price / 100;
      let giftImg = "";
      const img1 = giftPriceMap.get(1);
      const img2 = giftPriceMap.get(2);
      const img3 = giftPriceMap.get(3);
      const img4 = giftPriceMap.get(4);
      if (price >= 8000 && img3) giftImg = img3;
      else if (price >= 2000 && img2) giftImg = img2;
      else if (price >= 350 && img1) giftImg = img1;
      else if (img4) giftImg = img4;

      if (record.synthetic_result !== 0) {
        totalEarned += price;
        successCount++;
        anchor.totalEarned += price;

        const key = record.gift_name;
        const existing = giftMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          giftMap.set(key, {
            gift_id: 0,
            gift_name: record.gift_name,
            gift_img: giftImg,
            gift_price: price,
            count: 1,
            gift_key: key,
          });
        }

        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent,
          profit: price - spent,
          synthetic_result: record.synthetic_result,
          date: formatTimestamp(record.synthetic_time),
          synthetic_time: record.synthetic_time,
        });
      } else {
        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent,
          profit: -spent,
          synthetic_result: 0,
          date: formatTimestamp(record.synthetic_time),
          synthetic_time: record.synthetic_time,
        });
      }

      anchorMap.set(record.ruid, anchor);
    }

    const giftList = Array.from(giftMap.values())
      .sort((a, b) => b.gift_price - a.gift_price)
      .map(({ gift_key, ...rest }) => rest);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
      totalSpent,
      totalEarned,
      profit: totalEarned - totalSpent,
      drawCount: 0,
      replaceCount: 0,
      synthesisCount,
      successCount,
      giftList,
      anchors,
      detailedRecords,
    };
  }
}

class CardFlipCalculator implements SynthesisProfitCalculator {
  private static readonly FLIP_COSTS = [50, 112, 172, 316, 620, 1025, 2033];

  calculate(records: unknown[], activityInfo?: JsonObject | null): SynthesisActivityProfitResult {
    const recs = records as CardFlipRawRecord[];
    let totalSpent = 0;
    let totalEarned = 0;
    let synthesisCount = 0;
    let successCount = 0;
    const giftMap = new Map<string, SynthesisGiftInfo>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageCache: Record<string, string> = (activityInfo?.gift_image_cache as Record<string, string>) || {};

    for (const record of recs) {
      synthesisCount++;

      let roundCost = 0;
      let goodCount = 0;
      let totalFlips = 0;
      let badCardCount = 0;
      let endedByBadCard = false;

      for (const idx of record.card_idx) {
        if (idx === -1) continue;
        roundCost += CardFlipCalculator.FLIP_COSTS[goodCount] || 0;
        totalFlips++;
        if (idx >= 1 && idx <= 7) goodCount++;
        else if (idx >= 8 && idx <= 9) {
          badCardCount++;
          endedByBadCard = true;
        }
      }

      const reward = record.reward_value / 100;
      totalSpent += roundCost;
      totalEarned += reward;
      if (goodCount > 0) successCount++;

      const anchor = anchorMap.get(record.ruid) || { ruid: record.ruid, rname: "", totalSpent: 0, totalEarned: 0 };
      anchor.totalSpent += roundCost;
      anchor.totalEarned += reward;
      anchorMap.set(record.ruid, anchor);

      const giftImg = giftImageCache[record.reward_name] || "";
      if (record.reward_value > 0 && record.reward_name) {
        const existing = giftMap.get(record.reward_name);
        if (existing) {
          existing.count++;
        } else {
          giftMap.set(record.reward_name, {
            gift_id: 0,
            gift_name: record.reward_name,
            gift_img: giftImg,
            gift_price: reward,
            count: 1,
          });
        }
      }

      const settleTime = record.settle_time as number | undefined;
      const dateStr = settleTime ? formatTimestamp(settleTime) : "";

      detailedRecords.push({
        ruid: record.ruid,
        rname: "",
        gift_name: record.reward_name,
        gift_price: reward,
        gift_img: giftImg,
        spent: roundCost,
        profit: reward - roundCost,
        synthetic_result: goodCount > 0 ? 1 : 0,
        date: dateStr,
        synthetic_time: settleTime || 0,
      });
    }

    const giftList = Array.from(giftMap.values()).sort((a, b) => b.gift_price - a.gift_price);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
      totalSpent,
      totalEarned,
      profit: totalEarned - totalSpent,
      drawCount: 0,
      replaceCount: 0,
      synthesisCount,
      successCount,
      giftList,
      anchors,
      detailedRecords,
    };
  }
}

const calculators: Record<string, SynthesisProfitCalculator> = {
  slot_draw: new SlotDrawCalculator(),
  material_package: new MaterialPackageCalculator(),
  card_flip: new CardFlipCalculator(),
};

function getSynthesisCalculator(type: string): SynthesisProfitCalculator | null {
  return calculators[type] || null;
}

// ==================== 合成活动认证计算（与 gift-db 对应） ====================

function calculateCardFlipCertifications(
  rawRecords: unknown[],
  detailedRecords: SynthesisDetailedRecord[],
  maxGiftPrice?: number,
): SynthesisCertification[] {
  const certifications: SynthesisCertification[] = [];
  if (!maxGiftPrice || maxGiftPrice <= 0 || rawRecords.length === 0) return certifications;

  const recs = rawRecords as CardFlipRawRecord[];
  const dailyMap = new Map<string, { records: CardFlipRawRecord[]; ruid: number }>();
  for (const record of recs) {
    const settleTime = record.settle_time as number | undefined;
    if (!settleTime) continue;
    const dateStr = new Date(settleTime * 1000).toISOString().slice(0, 10).replace(/-/g, ".");
    const key = `${dateStr}_${record.ruid}`;
    if (!dailyMap.has(key)) dailyMap.set(key, { records: [], ruid: record.ruid });
    dailyMap.get(key)!.records.push(record);
  }

  for (const [key, { records: dayRecords, ruid }] of dailyMap) {
    const dateStr = key.split("_")[0];
    let totalFlips = 0;
    let totalBadCards = 0;
    let totalCost = 0;
    let totalReward = 0;
    let maxGoodCount = 0;
    let roundsWithMaxGift = 0;
    const costs = [50, 112, 172, 316, 620, 1025, 2033];

    for (const record of dayRecords) {
      let goodCount = 0;
      let badCount = 0;
      let roundFlips = 0;
      let roundCost = 0;
      for (const idx of record.card_idx) {
        if (idx === -1) continue;
        roundCost += costs[goodCount] || 0;
        roundFlips++;
        if (idx >= 1 && idx <= 7) goodCount++;
        else if (idx >= 8 && idx <= 9) badCount++;
      }
      totalFlips += roundFlips;
      totalBadCards += badCount;
      totalCost += roundCost;
      totalReward += record.reward_value / 100;
      if (goodCount > maxGoodCount) maxGoodCount = goodCount;
      if (record.reward_value / 100 >= maxGiftPrice) roundsWithMaxGift++;
    }

    if (dayRecords.length === 1 && maxGoodCount === 7 && roundsWithMaxGift >= 1) {
      const settleTime = dayRecords[0].settle_time as number;
      const giftImg = detailedRecords.find((r) => r.ruid === ruid && r.gift_price >= maxGiftPrice)?.gift_img || "";
      certifications.push({
        type: "lucky",
        ruid,
        rname: "",
        gift_name: dayRecords[0].reward_name,
        gift_price: dayRecords[0].reward_value / 100,
        gift_img: giftImg,
        spent: totalCost,
        profit: totalReward - totalCost,
        date: formatTimestamp(settleTime),
      });
    }

    if (totalFlips > 100 && totalBadCards > totalFlips / 2) {
      const settleTime = dayRecords[0].settle_time as number;
      certifications.push({
        type: "unlucky",
        ruid,
        rname: "",
        gift_name: `${totalFlips}次翻牌`,
        gift_price: 0,
        gift_img: "",
        spent: totalCost,
        profit: totalReward - totalCost,
        date: formatTimestamp(settleTime),
        count: totalBadCards,
      });
    }
  }

  return certifications;
}

function calculateSynthesisCertifications(
  detailedRecords: SynthesisDetailedRecord[],
  maxGiftPriceFromInfo?: number,
): SynthesisCertification[] {
  const certifications: SynthesisCertification[] = [];
  if (detailedRecords.length === 0) return certifications;
  if (!maxGiftPriceFromInfo || maxGiftPriceFromInfo <= 0) return certifications;
  const maxGiftPrice = maxGiftPriceFromInfo;

  const maxPriceRecords = detailedRecords.filter((r) => r.gift_price === maxGiftPrice);
  if (maxPriceRecords.length === 0) return certifications;

  const accumulatedMap = new Map<number, number>();
  const successRecords: Array<{
    ruid: number;
    rname: string;
    gift_name: string;
    gift_price: number;
    gift_img: string;
    totalSpent: number;
    profit: number;
    date: string;
    isFull: boolean;
  }> = [];

  for (let i = maxPriceRecords.length - 1; i >= 0; i--) {
    const record = maxPriceRecords[i];
    const accumulated = accumulatedMap.get(record.ruid) || 0;
    const newAccumulated = accumulated + record.spent;
    if (record.synthetic_result !== 0) {
      successRecords.push({
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        totalSpent: newAccumulated,
        profit: record.gift_price - newAccumulated,
        date: record.date,
        isFull: record.synthetic_result === 2,
      });
      accumulatedMap.set(record.ruid, 0);
    } else {
      accumulatedMap.set(record.ruid, newAccumulated);
    }
  }

  successRecords.reverse();

  for (const record of successRecords) {
    if (record.isFull) {
      certifications.push({
        type: "unlucky",
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        spent: record.totalSpent,
        profit: record.profit,
        date: record.date,
      });
    } else if (record.totalSpent < record.gift_price * 0.1) {
      certifications.push({
        type: "lucky",
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        spent: record.totalSpent,
        profit: record.profit,
        date: record.date,
      });
    }
  }

  const dailyMaxGiftCounts = new Map<string, number>();
  for (const record of successRecords) {
    const dateKey = `${record.date.split(" ")[0]}_${record.ruid}`;
    dailyMaxGiftCounts.set(dateKey, (dailyMaxGiftCounts.get(dateKey) || 0) + 1);
  }
  for (const [dateKey, count] of dailyMaxGiftCounts) {
    if (count >= 6) {
      const [date, ruidStr] = dateKey.split("_");
      const ruid = parseInt(ruidStr);
      const firstRecord = successRecords.find((r) => r.date.startsWith(date) && r.ruid === ruid);
      if (firstRecord) {
        certifications.push({
          type: "rich",
          ruid: firstRecord.ruid,
          rname: firstRecord.rname,
          gift_name: firstRecord.gift_name,
          gift_price: firstRecord.gift_price,
          gift_img: firstRecord.gift_img,
          spent: 0,
          profit: 0,
          date,
          count,
        });
      }
    }
  }

  return certifications;
}

// ==================== 历史合成盈亏（与 gift-db.calcHistoricalSynthesisProfit 对应） ====================

type SynthesisAnchorProfitInfo = {
  ruid: number;
  rname: string;
  count: number;
  value: number;
  spent: number;
  profit: number;
};

type SynthesisProfitResult = {
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  replaceCount: number;
  synthesisCount: number;
  successCount: number;
  giftList?: SynthesisGiftInfo[];
  detailedRecords?: SynthesisDetailedRecord[];
  anchorStats?: SynthesisAnchorProfitInfo[];
};

function calcHistoricalSynthesisProfit(
  records: RawGiftRecord[],
  tianxuanGiftIds: number[] = [],
  redPocketGiftIds: number[] = [],
): SynthesisProfitResult {
  const excludedGiftIds = new Set([...tianxuanGiftIds, ...redPocketGiftIds]);

  let totalSpent = 0;
  let totalEarned = 0;
  let drawCount = 0;
  let synthesisCount = 0;

  const spentRecords: RawGiftRecord[] = [];
  const earnedRecords: RawGiftRecord[] = [];

  for (const record of records) {
    const coins = Number((record.pay_coin || record.coin || "0").replace(/,/g, ""));
    if (record.status_msg === "已退回") continue;
    if (record.gift_id === 1 && record.gift_name === "礼物天选") continue;
    if (record.gift_id === 1) {
      totalSpent += coins;
      drawCount += record.gift_num;
      spentRecords.push(record);
    } else if (record.bag_desc === "包裹道具" && !excludedGiftIds.has(record.gift_id)) {
      totalEarned += coins;
      synthesisCount += record.gift_num;
      earnedRecords.push(record);
    }
  }

  const giftMap = new Map<number, SynthesisGiftInfo>();
  const detailedRecords: SynthesisDetailedRecord[] = [];

  for (const r of earnedRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    const price = r.gift_num > 0 ? Math.round(coins / r.gift_num) : coins;
    const existing = giftMap.get(r.gift_id);
    if (existing) {
      existing.count += r.gift_num;
    } else {
      giftMap.set(r.gift_id, {
        gift_id: r.gift_id,
        gift_name: r.gift_name,
        gift_img: r.gift_img || "",
        gift_price: price,
        count: r.gift_num,
      });
    }
    detailedRecords.push({
      ruid: r.ruid,
      rname: r.r_uname || "",
      gift_name: r.gift_name,
      gift_price: price,
      gift_img: r.gift_img || "",
      spent: 0,
      profit: coins,
      synthetic_result: 1,
      date: r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "",
      synthetic_time: r.timestamp || 0,
      coin_type: r.coin_type,
      gift_id: r.gift_id,
    });
  }

  for (const r of spentRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    detailedRecords.push({
      ruid: r.ruid,
      rname: r.r_uname || "",
      gift_name: r.gift_name,
      gift_price: coins,
      gift_img: r.gift_img || "",
      spent: coins,
      profit: -coins,
      synthetic_result: 0,
      date: r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "",
      synthetic_time: r.timestamp || 0,
      coin_type: r.coin_type,
      gift_id: r.gift_id,
    });
  }

  const anchorMap = new Map<number, SynthesisAnchorProfitInfo>();
  for (const r of spentRecords) {
    const cur = anchorMap.get(r.ruid) || {
      ruid: r.ruid,
      rname: r.r_uname || "",
      count: 0,
      value: 0,
      spent: 0,
      profit: 0,
    };
    cur.spent += Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    if (r.r_uname) cur.rname = cur.rname || r.r_uname;
    anchorMap.set(r.ruid, cur);
  }
  for (const r of earnedRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    const cur = anchorMap.get(r.ruid) || {
      ruid: r.ruid,
      rname: r.r_uname || "",
      count: 0,
      value: 0,
      spent: 0,
      profit: 0,
    };
    cur.value += coins;
    cur.count += r.gift_num;
    if (r.r_uname) cur.rname = cur.rname || r.r_uname;
    anchorMap.set(r.ruid, cur);
  }
  for (const info of anchorMap.values()) info.profit = info.value - info.spent;
  const anchorStats = Array.from(anchorMap.values()).sort((a, b) => b.value - a.value);

  const giftList = Array.from(giftMap.values());

  return {
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    replaceCount: 0,
    synthesisCount,
    successCount: synthesisCount,
    giftList,
    detailedRecords,
    anchorStats,
  };
}

// ==================== 主导出：合成统计 ====================

export type SynthesisStatsResponse = {
  historical: SynthesisProfitResult;
  activities: SynthesisActivityStats[];
  tianxuanGifts?: { id: number; name: string }[];
  redPocketGifts?: { id: number; name: string }[];
};

export async function fetchSynthesisStats(
  platform: Platform,
): Promise<ClientResponse<SynthesisStatsResponse | null>> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }
  const cookie = buildCookie(session);

  try {
    await ensureGiftCatalogLoaded(platform);
    let tianxuanGiftIds: number[] = [];
    let tianxuanGiftList: { id: number; name: string }[] = [];
    try {
      const tianxuanGifts = await fetchTianxuanGiftList(platform, cookie);
      const currentIds = tianxuanGifts.map((g) => g.id);
      tianxuanGiftList = tianxuanGifts.map((g) => ({ id: g.id, name: g.name }));
      tianxuanGiftIds = await getAccumulatedTianxuanGiftIds(platform, session.mid, currentIds);
    } catch (err) {
      console.error("[SynthesisStats] 获取天选礼物列表失败:", err);
    }

    let redPocketGiftIds: number[] = [];
    let redPocketGiftList: { id: number; name: string }[] = [];
    try {
      const redPocketGifts = await fetchRedPocketGiftList(platform, cookie);
      const currentRedPocketIds = redPocketGifts.map((g) => g.id);
      redPocketGiftList = redPocketGifts.map((g) => ({ id: g.id, name: g.name }));
      redPocketGiftIds = await getAccumulatedRedPocketGiftIds(platform, session.mid, currentRedPocketIds);
    } catch (err) {
      console.error("[SynthesisStats] 获取红包礼物列表失败:", err);
    }

    let historical: SynthesisProfitResult;
    const records = await readPayRecords(platform, session.mid, session.uname || "");
    const activities: SynthesisActivityStats[] = [];
    const effectiveSynthConfig = await getEffectiveSynthesisConfig(platform);

    for (const activity of effectiveSynthConfig.current_activity) {
      try {
        const calculator = getSynthesisCalculator(activity.type);
        if (!calculator) continue;

        let info: SynthesisActivityInfo | null = null;
        try {
          const cached = await getSynthesisActivityInfo(platform, activity.id);
          if (cached && cached.name && (activity.type !== "material_package" || cached.resource)) {
            info = cached as SynthesisActivityInfo;
          } else {
            info = await fetchSynthesisActivityInfo(platform, cookie, activity);
            if (info && info.name) {
              await saveSynthesisActivityInfo(platform, activity.id, info as unknown as JsonObject);
            }
          }
        } catch (infoErr) {
          console.warn(`[SynthesisStats] 获取活动信息失败（活动可能已结束）:`, infoErr);
        }

        let rawRecords: unknown[] = [];
        try {
          rawRecords = await fetchSynthesisActivityRecords(platform, cookie, activity);
          await saveSynthesisRecords(
            platform,
            session.mid,
            session.uname || "",
            activity.id,
            rawRecords,
            info?.name,
          );
        } catch (recordErr) {
          // 拉取失败时回退到本地已保存记录，避免活动卡片数据被清空
          console.warn(`[SynthesisStats] 获取活动记录失败，回退到本地缓存:`, recordErr);
          try {
            rawRecords = await readSynthesisRecords(platform, session.mid, session.uname || "", activity.id);
          } catch {
            rawRecords = [];
          }
        }

        if (activity.type === "card_flip" && info) {
          const giftImageCache = await getCardFlipGiftImages(platform);
          (info as unknown as JsonObject).gift_image_cache = giftImageCache;
        }

        const profit = calculator.calculate(rawRecords, info as unknown as JsonObject | null);

        if (activity.type === "card_flip") {
          for (const gift of profit.giftList) {
            if (!gift.gift_img) {
              const img = await getCardFlipGiftImage(platform, gift.gift_name, session.mid, session.uname || "");
              if (img) {
                gift.gift_img = img;
                await saveCardFlipGiftImage(platform, gift.gift_name, img);
              }
            }
          }
        }

        const uniqueRuids = new Set<number>();
        for (const anchor of profit.anchors) uniqueRuids.add(anchor.ruid);
        for (const record of profit.detailedRecords) uniqueRuids.add(record.ruid);

        const payRecordNameMap = new Map<number, string>();
        for (const payRecord of records) {
          if (payRecord.r_uname && !payRecordNameMap.has(payRecord.ruid)) {
            payRecordNameMap.set(payRecord.ruid, payRecord.r_uname);
          }
        }

        const namePromises = Array.from(uniqueRuids).map(async (ruid) => {
          const name = await getUserNameByUid(platform, ruid, session.mid, session.uname || "").catch(() => "");
          return { ruid, name };
        });
        const nameResults = await Promise.all(namePromises);
        const nameMap = new Map<number, string>();
        for (const { ruid, name } of nameResults) nameMap.set(ruid, name);

        for (const anchor of profit.anchors) {
          const nameMapVal = nameMap.get(anchor.ruid);
          const payName = payRecordNameMap.get(anchor.ruid);
          const validNameMapVal = nameMapVal && !nameMapVal.startsWith("主播") ? nameMapVal : undefined;
          anchor.rname = payName || validNameMapVal || nameMapVal || `主播${anchor.ruid}`;
        }
        for (const record of profit.detailedRecords) {
          const nameMapVal = nameMap.get(record.ruid);
          const payName = payRecordNameMap.get(record.ruid);
          const validNameMapVal = nameMapVal && !nameMapVal.startsWith("主播") ? nameMapVal : undefined;
          record.rname = payName || validNameMapVal || nameMapVal || `主播${record.ruid}`;
        }

        let maxGiftPrice: number | undefined;
        let maxGiftImg: string | undefined;
        if (info?.gift_info && info.gift_info.length > 0) {
          const maxGift = info.gift_info.reduce((a, b) =>
            a.gift_price > b.gift_price ? a : b,
          );
          maxGiftPrice = maxGift.gift_price;
          maxGiftImg = maxGift.gift_img;
        }

        let certifications: SynthesisCertification[];
        if (activity.type === "card_flip") {
          const maxGiftPriceForCert = profit.giftList.length > 0
            ? Math.max(...profit.giftList.map((g) => g.gift_price))
            : undefined;
          certifications = calculateCardFlipCertifications(rawRecords, profit.detailedRecords, maxGiftPriceForCert);
        } else {
          certifications = calculateSynthesisCertifications(profit.detailedRecords, maxGiftPrice);
        }

        for (const cert of certifications) {
          cert.rname = nameMap.get(cert.ruid) || `主播${cert.ruid}`;
        }

        const activityIcon =
          info?.icon ||
          maxGiftImg ||
          (profit.giftList.length > 0
            ? profit.giftList.reduce((a, b) => (a.gift_price > b.gift_price ? a : b)).gift_img
            : undefined);

        activities.push({
          id: activity.id,
          type: activity.type,
          name: info?.name || activity.id,
          icon: activityIcon,
          profit,
          certifications,
        });
      } catch (err) {
        console.error(`[SynthesisStats] 获取活动 ${activity.id} 失败:`, err);
        activities.push({
          id: activity.id,
          type: activity.type,
          name: activity.id,
          icon: undefined,
          profit: {
            totalSpent: 0,
            totalEarned: 0,
            profit: 0,
            drawCount: 0,
            replaceCount: 0,
            synthesisCount: 0,
            successCount: 0,
            giftList: [],
            anchors: [],
            detailedRecords: [],
          },
          certifications: [],
        });
      }
    }

    historical = calcHistoricalSynthesisProfit(records, tianxuanGiftIds, redPocketGiftIds);

    if (historical.anchorStats) {
      const payRecordNameMap = new Map<number, string>();
      for (const payRecord of records) {
        if (payRecord.r_uname && !payRecordNameMap.has(payRecord.ruid)) {
          payRecordNameMap.set(payRecord.ruid, payRecord.r_uname);
        }
      }
      const anchorRuids = Array.from(new Set(historical.anchorStats.map((a) => a.ruid)));
      const nameResults = await Promise.all(
        anchorRuids.map(async (ruid) => {
          const name = await getUserNameByUid(platform, ruid, session.mid, session.uname || "").catch(() => "");
          return { ruid, name };
        }),
      );
      const nameMap = new Map<number, string>();
      for (const { ruid, name } of nameResults) nameMap.set(ruid, name);
      for (const info of historical.anchorStats) {
        if (info.rname) continue;
        const nameMapVal = nameMap.get(info.ruid);
        const payName = payRecordNameMap.get(info.ruid);
        const validNameMapVal = nameMapVal && !nameMapVal.startsWith("主播") ? nameMapVal : undefined;
        info.rname = payName || validNameMapVal || nameMapVal || `主播${info.ruid}`;
      }
    }

    const data: SynthesisStatsResponse = {
      historical,
      activities,
      tianxuanGifts: tianxuanGiftList,
      redPocketGifts: redPocketGiftList,
    };
    return { code: 0, message: "ok", data };
  } catch (err) {
    console.error("[SynthesisStats] 统计失败:", err);
    return { code: 500, message: "统计失败", data: null };
  }
}

// ==================== 主导出：认证统计 ====================

const XINDONG_ID = 32251;
const CASTLE_ID = 32132;
const XINDONG_PRICE = 150;

export type Certification = {
  date: string;
  type: "lucky" | "unlucky" | "rich";
  drawCount: number;
  castleCount: number;
  profit: number;
  spent: number;
  earned: number;
  userName: string;
  blindBoxName: string;
  blindBoxImg: string;
  castleName: string;
  castleImg: string;
};

export type CertificationResponse = {
  certifications: Certification[];
  hasCertification: boolean;
};

export async function fetchCertificationStats(
  platform: Platform,
): Promise<ClientResponse<CertificationResponse | null>> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }

  try {
    await ensureGiftCatalogLoaded(platform);
    const records = await readBlindBoxRecords(platform, session.mid, session.uname, XINDONG_ID);

    if (records.length === 0) {
      return { code: 0, message: "ok", data: { certifications: [], hasCertification: false } };
    }

    const dailyMap = new Map<string, { drawCount: number; castleCount: number; earned: number }>();
    for (const record of records) {
      const date = record.timestamp.split(" ")[0];
      let daily = dailyMap.get(date);
      if (!daily) {
        daily = { drawCount: 0, castleCount: 0, earned: 0 };
        dailyMap.set(date, daily);
      }
      daily.drawCount += record.gift_num;
      if (record.gift_id === CASTLE_ID) daily.castleCount += record.gift_num;
      const price = getCatalogGiftPrice(record.gift_id);
      daily.earned += price * record.gift_num;
    }

    const certifications: Certification[] = [];
    const blindBoxImg = getCatalogGiftImg(XINDONG_ID);
    const castleImg = getCatalogGiftImg(CASTLE_ID);
    const castleName = getCatalogGiftName(CASTLE_ID) || "浪漫城堡";

    for (const [date, daily] of dailyMap) {
      const spent = daily.drawCount * XINDONG_PRICE;
      const profit = daily.earned - spent;

      if (daily.castleCount >= 1 && daily.drawCount / daily.castleCount < 100) {
        certifications.push({
          date,
          type: "lucky",
          drawCount: daily.drawCount,
          castleCount: daily.castleCount,
          profit,
          spent,
          earned: daily.earned,
          userName: session.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }

      if (daily.drawCount > 1000 && daily.castleCount === 0) {
        certifications.push({
          date,
          type: "unlucky",
          drawCount: daily.drawCount,
          castleCount: 0,
          profit,
          spent,
          earned: daily.earned,
          userName: session.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }

      if (daily.castleCount >= 6) {
        certifications.push({
          date,
          type: "rich",
          drawCount: daily.drawCount,
          castleCount: daily.castleCount,
          profit,
          spent,
          earned: daily.earned,
          userName: session.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }
    }

    certifications.sort((a, b) => b.date.localeCompare(a.date));

    return {
      code: 0,
      message: "ok",
      data: { certifications, hasCertification: certifications.length > 0 },
    };
  } catch (err) {
    console.error("[Certification] 获取认证数据失败:", err);
    return { code: 500, message: "获取认证数据失败", data: null };
  }
}

// ==================== 主导出：其他统计 ====================

const CRYSTAL_BALL_PRICE = 1000;

type GiftEntry = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  totalNum: number;
  totalValue: number;
  unitPrice: number;
};

type GiftStats = {
  gifts: GiftEntry[];
  totalCount: number;
  totalValue: number;
  hasLuckyTitle: boolean;
};

type DayStats = {
  totalDays: number;
  maxConsecutiveDays: number;
  maxConsecutiveStart: string;
  maxConsecutiveEnd: string;
  maxDaysInYear: number;
  maxDaysInYearRange: { start: string; end: string };
};

type RoomStat = {
  ruid: number;
  rname: string;
  totalDays: number;
  maxConsecutiveDays: number;
  maxConsecutiveStart: string;
  maxConsecutiveEnd: string;
  maxDaysInYear: number;
  maxDaysInYearRange: { start: string; end: string };
};

type OtherStatsResponse = {
  giftStats: GiftStats;
  dayStats: DayStats;
  roomStats: RoomStat[];
  dateRange: { start: string; end: string } | null;
};

function calcMaxConsecutive(sortedDates: string[]): { max: number; start: string; end: string } {
  if (sortedDates.length === 0) return { max: 0, start: "", end: "" };
  let maxLen = 1;
  let maxStart = sortedDates[0];
  let maxEnd = sortedDates[0];
  let curLen = 1;
  let curStart = sortedDates[0];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]);
    const cur = new Date(sortedDates[i]);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      curLen++;
    } else {
      if (curLen > maxLen) {
        maxLen = curLen;
        maxStart = curStart;
        maxEnd = sortedDates[i - 1];
      }
      curLen = 1;
      curStart = sortedDates[i];
    }
  }
  if (curLen > maxLen) {
    maxLen = curLen;
    maxStart = curStart;
    maxEnd = sortedDates[sortedDates.length - 1];
  }
  return { max: maxLen, start: maxStart, end: maxEnd };
}

function calcMaxDaysInYear(sortedDates: string[]): { max: number; start: string; end: string } {
  if (sortedDates.length === 0) return { max: 0, start: "", end: "" };
  let maxCount = 1;
  let maxStart = sortedDates[0];
  let maxEnd = sortedDates[0];
  let left = 0;
  for (let right = 0; right < sortedDates.length; right++) {
    const leftDate = new Date(sortedDates[left]);
    const rightDate = new Date(sortedDates[right]);
    const diffDays = Math.round((rightDate.getTime() - leftDate.getTime()) / 86400000);
    while (diffDays > 365) {
      left++;
      const newLeftDate = new Date(sortedDates[left]);
      const newDiff = Math.round((rightDate.getTime() - newLeftDate.getTime()) / 86400000);
      if (newDiff <= 365) break;
    }
    const count = right - left + 1;
    if (count > maxCount) {
      maxCount = count;
      maxStart = sortedDates[left];
      maxEnd = sortedDates[right];
    }
  }
  return { max: maxCount, start: maxStart, end: maxEnd };
}

function getDateStr(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function fetchOtherStats(
  platform: Platform,
): Promise<ClientResponse<OtherStatsResponse | null>> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }
  const cookie = buildCookie(session);

  try {
    await ensureGiftCatalogLoaded(platform);
    let tianxuanGiftIds: number[] = [];
    const tianxuanGifts = await fetchTianxuanGiftList(platform, cookie).catch(() => []);
    tianxuanGiftIds = await getAccumulatedTianxuanGiftIds(platform, session.mid, tianxuanGifts.map((g) => g.id));

    let redPocketGiftIds: number[] = [];
    const redPocketGifts = await fetchRedPocketGiftList(platform, cookie).catch(() => []);
    redPocketGiftIds = await getAccumulatedRedPocketGiftIds(platform, session.mid, redPocketGifts.map((g) => g.id));

    const records = await readPayRecords(platform, session.mid, session.uname || "");

    if (records.length === 0) {
      const empty: OtherStatsResponse = {
        giftStats: { gifts: [], totalCount: 0, totalValue: 0, hasLuckyTitle: false },
        dayStats: {
          totalDays: 0,
          maxConsecutiveDays: 0,
          maxConsecutiveStart: "",
          maxConsecutiveEnd: "",
          maxDaysInYear: 0,
          maxDaysInYearRange: { start: "", end: "" },
        },
        roomStats: [],
        dateRange: null,
      };
      return { code: 0, message: "empty", data: empty };
    }

    const luckyGiftIds = new Set([...tianxuanGiftIds, ...redPocketGiftIds]);

    const giftMap = new Map<
      number,
      { gift_id: number; gift_name: string; gift_img: string; totalNum: number; totalValue: number; unitPrice: number }
    >();
    for (const r of records) {
      if (r.status_msg === "已退回") continue;
      if (!luckyGiftIds.has(r.gift_id)) continue;
      const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, "")) || 0;
      const existing = giftMap.get(r.gift_id);
      if (existing) {
        existing.totalNum += r.gift_num;
        existing.totalValue += coins;
      } else {
        const unitPrice = r.gift_num > 0 ? Math.round(coins / r.gift_num) : coins;
        giftMap.set(r.gift_id, {
          gift_id: r.gift_id,
          gift_name: r.gift_name,
          gift_img: r.gift_img || "",
          totalNum: r.gift_num,
          totalValue: coins,
          unitPrice,
        });
      }
    }

    const gifts = Array.from(giftMap.values()).sort((a, b) => b.totalValue - a.totalValue);
    const totalCount = gifts.reduce((sum, g) => sum + g.totalNum, 0);
    const totalValue = gifts.reduce((sum, g) => sum + g.totalValue, 0);
    const hasLuckyTitle = gifts.some((g) => g.unitPrice >= CRYSTAL_BALL_PRICE);

    const allDateSet = new Set<string>();
    const allRecords = records.filter((r) => r.status_msg !== "已退回" && r.timestamp);
    for (const r of allRecords) allDateSet.add(getDateStr(r.timestamp));
    const allSortedDates = Array.from(allDateSet).sort();
    const allConsecutive = calcMaxConsecutive(allSortedDates);
    const allYearMax = calcMaxDaysInYear(allSortedDates);

    const dayStats: DayStats = {
      totalDays: allSortedDates.length,
      maxConsecutiveDays: allConsecutive.max,
      maxConsecutiveStart: allConsecutive.start,
      maxConsecutiveEnd: allConsecutive.end,
      maxDaysInYear: allYearMax.max,
      maxDaysInYearRange: { start: allYearMax.start, end: allYearMax.end },
    };

    const roomMap = new Map<number, { rname: string; dateSet: Set<string>; allTianxuan: boolean }>();
    for (const r of allRecords) {
      const isTianxuan = tianxuanGiftIds.includes(r.gift_id) || (r.ruid === 0 && !r.r_uname);
      const ruid = r.ruid === 0 && !r.r_uname ? session.mid : r.ruid;
      const existing = roomMap.get(ruid);
      if (existing) {
        if (!existing.rname && r.r_uname) existing.rname = r.r_uname;
        if (!isTianxuan) existing.allTianxuan = false;
        existing.dateSet.add(getDateStr(r.timestamp));
      } else {
        roomMap.set(ruid, {
          rname: r.r_uname,
          dateSet: new Set([getDateStr(r.timestamp)]),
          allTianxuan: isTianxuan,
        });
      }
    }

    const roomStats: RoomStat[] = [];
    for (const [ruid, { rname, dateSet, allTianxuan }] of roomMap) {
      const sortedDates = Array.from(dateSet).sort();
      const consecutive = calcMaxConsecutive(sortedDates);
      const yearMax = calcMaxDaysInYear(sortedDates);
      const resolvedName = rname || (allTianxuan ? "自己发天选" : `主播${ruid}`);
      roomStats.push({
        ruid,
        rname: resolvedName,
        totalDays: sortedDates.length,
        maxConsecutiveDays: consecutive.max,
        maxConsecutiveStart: consecutive.start,
        maxConsecutiveEnd: consecutive.end,
        maxDaysInYear: yearMax.max,
        maxDaysInYearRange: { start: yearMax.start, end: yearMax.end },
      });
    }
    roomStats.sort((a, b) => b.totalDays - a.totalDays);

    const dateRange = allSortedDates.length > 0
      ? { start: allSortedDates[0], end: allSortedDates[allSortedDates.length - 1] }
      : null;

    const data: OtherStatsResponse = {
      giftStats: { gifts, totalCount, totalValue, hasLuckyTitle },
      dayStats,
      roomStats,
      dateRange,
    };
    return { code: 0, message: "ok", data };
  } catch (err) {
    console.error("[OtherStats] 统计失败:", err);
    return { code: 500, message: "统计失败", data: null };
  }
}

// ==================== 主导出：盲盒统计 ====================

type CastleStat = {
  ruid: number;
  rname: string;
  totalCount: number;
  dates: Array<{ date: string; count: number }>;
};

type BlindBoxProfitResult = {
  blindBoxId: number;
  blindBoxName: string;
  blindBoxImg: string;
  blindPrice: number;
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  recordCount: number;
  dateRange: { start: string; end: string } | null;
  anchors: Array<{ ruid: number; rname: string; count: number }>;
  filter: { ruid: number | null; dateRange: string };
  gifts: Array<{
    gift_id: number;
    gift_name: string;
    gift_img: string;
    unitPrice: number;
    count: number;
    totalValue: number;
  }>;
  castleStats: CastleStat[];
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
};

function calculateCastleStats(
  drawRecords: BlindBoxDrawRecord[],
): { castleStats: CastleStat[]; castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null } {
  const castleRecords = drawRecords.filter((r) => r.gift_id === CASTLE_ID);
  if (castleRecords.length === 0) {
    return { castleStats: [], castleGift: null };
  }

  const anchorMap = new Map<number, { rname: string; totalCount: number; dates: Map<string, number> }>();
  for (const record of castleRecords) {
    const date = record.timestamp.split(" ")[0];
    let anchor = anchorMap.get(record.ruid);
    if (!anchor) {
      anchor = { rname: record.rname, totalCount: 0, dates: new Map() };
      anchorMap.set(record.ruid, anchor);
    }
    anchor.totalCount += record.gift_num;
    anchor.dates.set(date, (anchor.dates.get(date) ?? 0) + record.gift_num);
  }

  const castleStats: CastleStat[] = Array.from(anchorMap.entries()).map(([ruid, anchor]) => ({
    ruid,
    rname: anchor.rname,
    totalCount: anchor.totalCount,
    dates: Array.from(anchor.dates.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  }));
  castleStats.sort((a, b) => b.totalCount - a.totalCount);

  return {
    castleStats,
    castleGift: { gift_id: CASTLE_ID, gift_name: getCatalogGiftName(CASTLE_ID), gift_img: getCatalogGiftImg(CASTLE_ID), price: getCatalogGiftPrice(CASTLE_ID) },
  };
}

function getLatestTimestamp(records: BlindBoxDrawRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  let latest = records[0].timestamp;
  for (const r of records) if (r.timestamp > latest) latest = r.timestamp;
  return latest;
}

function getDateRangeFilter(type: string): { start: Date; end: Date } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (type) {
    case "today": {
      const end = new Date(today);
      end.setDate(end.getDate() + 1);
      return { start: today, end };
    }
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayEnd = new Date(today);
      return { start: yesterday, end: yesterdayEnd };
    }
    case "thisWeek": {
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }
    case "thisMonth": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { start, end };
    }
    default:
      return null;
  }
}

function filterRecords(
  records: BlindBoxDrawRecord[],
  ruid: number | null,
  dateRange: string,
): BlindBoxDrawRecord[] {
  let filtered = records;
  if (ruid !== null) filtered = filtered.filter((r) => r.ruid === ruid);
  const range = getDateRangeFilter(dateRange);
  if (range) {
    filtered = filtered.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= range.start.getTime() && t < range.end.getTime();
    });
  }
  return filtered;
}

function buildAnchorList(records: BlindBoxDrawRecord[]): Array<{ ruid: number; rname: string; count: number }> {
  const map = new Map<number, { rname: string; count: number }>();
  for (const r of records) {
    const existing = map.get(r.ruid) ?? { rname: r.rname, count: 0 };
    existing.count += r.gift_num;
    map.set(r.ruid, existing);
  }
  return Array.from(map.entries())
    .map(([ruid, v]) => ({ ruid, rname: v.rname, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

function getDateRange(records: BlindBoxDrawRecord[]): { start: string; end: string } | null {
  if (records.length === 0) return null;
  let earliest = records[0].timestamp;
  let latest = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp < earliest) earliest = r.timestamp;
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return { start: earliest, end: latest };
}

async function calculateProfit(
  _platform: Platform,
  blindBoxId: number,
  drawRecords: BlindBoxDrawRecord[],
): Promise<BlindBoxProfitResult> {
  const blindPrice = getCatalogGiftPrice(blindBoxId);
  const blindBoxName = getCatalogGiftName(blindBoxId) || `盲盒_${blindBoxId}`;
  const blindBoxImg = getCatalogGiftImg(blindBoxId) || "";

  const giftStats = new Map<number, { gift_name: string; count: number; totalValue: number }>();
  for (const record of drawRecords) {
    const existing = giftStats.get(record.gift_id) ?? { gift_name: record.gift_name, count: 0, totalValue: 0 };
    existing.count += record.gift_num;
    const giftPrice = getCatalogGiftPrice(record.gift_id);
    existing.totalValue += giftPrice * record.gift_num;
    giftStats.set(record.gift_id, existing);
  }

  let totalEarned = 0;
  for (const record of drawRecords) {
    totalEarned += getCatalogGiftPrice(record.gift_id) * record.gift_num;
  }

  const drawCount = drawRecords.reduce((sum, r) => sum + r.gift_num, 0);
  const totalSpent = drawCount * blindPrice;

  const gifts = Array.from(giftStats.entries()).map(([gift_id, stats]) => {
    return {
      gift_id,
      gift_name: stats.gift_name,
      gift_img: getCatalogGiftImg(gift_id),
      unitPrice: getCatalogGiftPrice(gift_id),
      count: stats.count,
      totalValue: stats.totalValue,
    };
  });

  return {
    blindBoxId,
    blindBoxName,
    blindBoxImg,
    blindPrice,
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    recordCount: drawRecords.length,
    dateRange: { start: "", end: "" },
    anchors: [],
    filter: { ruid: null, dateRange: "all" },
    gifts,
    castleStats: [],
    castleGift: null,
  };
}

export type BlindBoxFilter = {
  ruid?: number | null;
  dateRange?: string;
};

export async function fetchBlindBoxStats(
  platform: Platform,
  filters?: Record<number, BlindBoxFilter>,
): Promise<ClientResponse<BlindBoxProfitResult[] | { blindBoxes: never[]; totalProfit: number; hasActivityBlindBox: boolean } | null>> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }
  const cookie = buildCookie(session);

  try {
    await ensureGiftCatalogLoaded(platform);
    const effectiveBlindBoxConfig = await getEffectiveBlindBoxConfig(platform);
    const currentIds = effectiveBlindBoxConfig.current_activity_blind_box_ids ?? [];

    const blindBoxIds = currentIds.filter((id) => id > 0);
    if (blindBoxIds.length === 0) {
      return { code: 0, message: "ok", data: { blindBoxes: [], totalProfit: 0, hasActivityBlindBox: false } };
    }

    const results: BlindBoxProfitResult[] = [];

    for (const blindBoxId of blindBoxIds) {
      try {
        const filter = filters?.[blindBoxId] ?? {};
        const ruid = filter.ruid === undefined ? null : filter.ruid;
        const filterDateRange = filter.dateRange ?? "all";

        const existingRecords = await readBlindBoxRecords(platform, session.mid, session.uname, blindBoxId);
        const latestTimestamp = getLatestTimestamp(existingRecords);

        // 纯服务器收集账号（source=server）无 B站 Cookie，无法拉取盲盒抽取增量，
        // 直接基于已从自建服务器拉取到本地的盲盒记录计算统计。
        const newRecords =
          session.source === "server"
            ? []
            : await fetchBlindBoxDrawStream(platform, blindBoxId, cookie, latestTimestamp);

        const mergedRecords = newRecords.length > 0 ? [...newRecords, ...existingRecords] : existingRecords;

        // 盲盒名称直接从礼物目录获取（用于文件名）
        const blindBoxNameForFile = getCatalogGiftName(blindBoxId) || undefined;

        if (newRecords.length > 0) {
          await saveBlindBoxRecords(
            platform,
            session.mid,
            session.uname,
            blindBoxId,
            mergedRecords,
            blindBoxNameForFile,
          );
        }

        const dateRange = getDateRange(mergedRecords);
        const anchors = buildAnchorList(mergedRecords);
        const filteredRecords = filterRecords(mergedRecords, ruid, filterDateRange);

        // 计算盈亏（名称/图标/价格全部从礼物目录获取，无需调用 blindFirstWin API）
        const profit = await calculateProfit(platform, blindBoxId, filteredRecords);
        // 补充 admin-config 中的 icon 作为图标 fallback
        if (!profit.blindBoxImg) {
          profit.blindBoxImg = effectiveBlindBoxConfig.icons[blindBoxId] ?? "";
        }

        profit.dateRange = dateRange;
        profit.anchors = anchors;
        profit.filter = { ruid, dateRange: filterDateRange };

        if (blindBoxId === 32251) {
          const { castleStats, castleGift } = calculateCastleStats(mergedRecords);
          profit.castleStats = castleStats;
          profit.castleGift = castleGift;
        }

        results.push(profit);
      } catch (err) {
        console.error(`[BlindBoxStats] 处理盲盒 ${blindBoxId} 失败:`, err);
      }
    }

    return { code: 0, message: "ok", data: results };
  } catch (err) {
    console.error("[BlindBoxStats] 统计失败:", err);
    return { code: 500, message: "统计失败", data: null };
  }
}
