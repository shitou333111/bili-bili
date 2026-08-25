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
import { ensureGiftCatalogLoaded, getGiftImg as getCatalogGiftImg, getGiftName as getCatalogGiftName, getGiftPrice as getCatalogGiftPrice, getGiftList as getCatalogGiftList } from "./gift-catalog-client";
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
 * 注意：上传是后台备份，不应阻塞刷新流程；调用方（如 finishRefresh）无需 await 它。
 */
let _uploadChain: Promise<void> = Promise.resolve();

export async function uploadAllUserData(platform: Platform): Promise<void> {
  // 串行排队：快速连续刷新时避免并发上传造成的 upload-state.json 读写竞争与重复上传
  const run = () => doUploadAllUserData(platform);
  _uploadChain = _uploadChain.then(run, run);
  return _uploadChain;
}

async function doUploadAllUserData(platform: Platform): Promise<void> {
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
  } catch {
    // 绝对静默：统一上传失败不打印任何日志，静默吞掉
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

// ---- 包裹礼物 ----

type BagGiftItem = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  is_locked: boolean;
  locked_text: string;
  /** 单价（元） */
  price: number;
  img: string;
};

async function fetchBagList(platform: Platform, cookie: string): Promise<BagGiftItem[]> {
  try {
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/gift/bag_list?room_id=23915535`;
    const response = await platform.fetchBilibiliJson<{
      code: number;
      data?: {
        list?: Array<{
          gift_id: number;
          gift_name: string;
          gift_num: number;
          is_locked: boolean;
          locked_text: string;
        }>;
        gift_config?: Array<{ id: number; name: string; price: number; img_basic: string }>;
      } | null;
    }>({ url, cookie, live: true });
    if (response.code !== 0 || !response.data?.list) return [];
    // gift_config 是数组，按 gift_id 建立索引后再匹配价格与图标
    const configMap = new Map<number, { name: string; price: number; img_basic: string }>();
    for (const c of response.data.gift_config ?? []) {
      configMap.set(c.id, c);
    }
    return response.data.list.map((item) => {
      const cfg = configMap.get(item.gift_id);
      return {
        gift_id: item.gift_id,
        gift_name: item.gift_name,
        gift_num: item.gift_num,
        is_locked: item.is_locked,
        locked_text: item.locked_text || "",
        // 礼物列表中的 price 是分（百分为 1 电池），除以 100 换算成电池单价
        price: cfg ? Math.round(cfg.price / 100) : 0,
        img: cfg?.img_basic || "",
      };
    });
  } catch {
    return [];
  }
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
  /** 合成产物记录的数量（包裹礼物补充时若大于1则为多条聚合数量） */
  gift_num?: number;
  /** 消费记录方式：素材记录关联的产物名（用于卡片按产物聚合花费） */
  product_name?: string;
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
  type?: string;
  name: string;
  icon?: string;
  start_time?: number;
  end_time?: number;
  profit: SynthesisActivityProfitResult;
  certifications: SynthesisCertification[];
};


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

/**
 * 按消费记录计算单个合成活动的盈亏（method = "payrecord"）
 * 逻辑与 gift-db.calcPayRecordActivityProfit 对应（自包含实现，不依赖 Node）。
 *
 * 起止时间可选，不填则对应方向无边界（范围 = 所有消费记录）；产物送出窗口为 [start, end + 49h]。
 * 层次填了素材单价则只计入单价一致的记录，未填则接受任意价格；逐记录累加 pay_coin。
 */
function calcPayRecordActivityProfit(
  records: RawGiftRecord[],
  config: SynthesisActivityConfig,
  excludedGiftIds: Set<number> = new Set(),
  bagGifts: BagGiftItem[] = [],
): SynthesisActivityProfitResult {
  const products = config.products || [];
  const materials = config.materials || [];
  const startTs = config.start_time;
  const endTs = config.end_time;
  const productEndTs = endTs === undefined ? Number.POSITIVE_INFINITY : endTs + 49 * 3600;
  const inMaterialWindow = (ts: number) =>
    (startTs === undefined || ts >= startTs) && (endTs === undefined || ts <= endTs);
  const inProductWindow = (ts: number) =>
    (startTs === undefined || ts >= startTs) && ts <= productEndTs;
  // 素材/产物直接按消费记录 gift_name 模糊匹配；无需把产物与素材一一对应，也无需素材单价区分
  const inMaterials = (giftName: string) => materials.some((m) => giftName.includes(m));
  const inProducts = (giftName: string) => products.some((p) => giftName.includes(p));

  let totalSpent = 0;
  let totalEarned = 0;
  let drawCount = 0;
  let synthesisCount = 0;
  const giftMap = new Map<number, SynthesisGiftInfo>();
  const anchorMap = new Map<number, SynthesisAnchorInfo>();
  const detailedRecords: SynthesisDetailedRecord[] = [];

  const coinsOf = (record: RawGiftRecord) => Number((record.pay_coin || record.coin || "0").replace(/,/g, ""));
  const dateStrOf = (ts: number) =>
    ts ? new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "";

  for (const record of records) {
    if (record.status_msg === "已退回") continue;
    if (record.gift_id === 1 && record.gift_name === "礼物天选") continue;

    const ts = record.timestamp || 0;
    const coins = coinsOf(record);

    // 素材：gift_name 匹配 materials 中任一名称，且时间在材料窗口内
    if (inMaterialWindow(ts) && coins > 0 && materials.length > 0 && inMaterials(record.gift_name)) {
      totalSpent += coins;
      drawCount += record.gift_num;

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: record.r_uname || "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalSpent += coins;
      if (record.r_uname) anchor.rname = anchor.rname || record.r_uname;
      anchorMap.set(record.ruid, anchor);

      detailedRecords.push({
        ruid: record.ruid,
        rname: record.r_uname || "",
        gift_name: record.gift_name,
        gift_price: record.gift_num > 0 ? coins / record.gift_num : coins,
        gift_img: record.gift_img || "",
        spent: coins,
        profit: -coins,
        synthetic_result: 0,
        date: dateStrOf(ts),
        synthetic_time: ts,
        coin_type: record.coin_type,
        gift_id: record.gift_id,
      });
      continue; // 一条记录只归入一个角色，避免同时被当作产物
    }

    // 产物：包裹道具 + gift_name 匹配 products 中任一名称 + 时间在产物窗口内
    if (
      record.bag_desc === "包裹道具" &&
      !excludedGiftIds.has(record.gift_id) &&
      inProductWindow(ts) &&
      products.length > 0 &&
      inProducts(record.gift_name)
    ) {
      totalEarned += coins;
      synthesisCount += record.gift_num;

      const price = record.gift_num > 0 ? Math.round(coins / record.gift_num) : coins;
      const existing = giftMap.get(record.gift_id);
      if (existing) {
        existing.count += record.gift_num;
      } else {
        giftMap.set(record.gift_id, {
          gift_id: record.gift_id,
          gift_name: record.gift_name,
          gift_img: record.gift_img || "",
          gift_price: price,
          count: record.gift_num,
        });
      }

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: record.r_uname || "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalEarned += coins;
      if (record.r_uname) anchor.rname = anchor.rname || record.r_uname;
      anchorMap.set(record.ruid, anchor);

      detailedRecords.push({
        ruid: record.ruid,
        rname: record.r_uname || "",
        gift_name: record.gift_name,
        gift_price: price,
        gift_img: record.gift_img || "",
        spent: 0,
        profit: coins,
        synthetic_result: 1,
        date: dateStrOf(ts),
        synthetic_time: ts,
        coin_type: record.coin_type,
        gift_id: record.gift_id,
      });
    }
  }

  // ===== 包裹礼物补充 =====
  // 合成产物礼物在未送出前不会出现在消费记录中，会暂存于包裹（bag_list）。
  // 用活动的产物礼物匹配包裹礼物，并区分其所属主播后补充计入产出。
  if (bagGifts.length > 0 && products.length > 0) {
    // 消费记录假定最新在前，取每条 r_uname 首次出现的 ruid（当前昵称 → 最新 UID 映射）
    const nameRuids = new Map<string, number>();
    for (const n of records) {
      if (n.r_uname && !nameRuids.has(n.r_uname)) nameRuids.set(n.r_uname, n.ruid);
    }
    // room_id → ruid 映射（未锁定的当前直播间礼物归属）
    const roomRuids = new Map<number, number>();
    for (const r of records) {
      if (!roomRuids.has(r.room_id)) roomRuids.set(r.room_id, r.ruid);
    }
    const anchorNameMatcher = /该礼物仅限([^的]+)的直播间使用/;

    for (const g of bagGifts) {
      if (!inProducts(g.gift_name)) continue;

      // 归属主播：未锁定 → 当前直播间（room_id=23915535）；锁定 → 从 locked_text 解析主播名再映射最新 ruid
      let ruid: number | undefined;
      if (!g.is_locked) {
        ruid = roomRuids.get(23915535);
      } else {
        const m = g.locked_text.match(anchorNameMatcher);
        const anchorName = m ? m[1] : "";
        ruid = nameRuids.get(anchorName);
      }
      if (ruid === undefined) continue; // 无法归属，保守跳过该礼物

      const earned = g.price * g.gift_num;
      totalEarned += earned;
      synthesisCount += g.gift_num;

      const anchor = anchorMap.get(ruid) || {
        ruid,
        rname: "",
        totalSpent: 0,
        totalEarned: 0,
      };
      if (!anchor.rname) {
        for (const r of records) {
          if (r.ruid === ruid && r.r_uname) {
            anchor.rname = r.r_uname;
            break;
          }
        }
      }
      anchor.totalEarned += earned;
      anchorMap.set(ruid, anchor);

      const existing = giftMap.get(g.gift_id);
      if (existing) {
        existing.count += g.gift_num;
      } else {
        giftMap.set(g.gift_id, {
          gift_id: g.gift_id,
          gift_name: g.gift_name,
          gift_img: g.img,
          gift_price: Math.round(g.price),
          count: g.gift_num,
        });
      }

      detailedRecords.push({
        ruid,
        rname: anchor.rname,
        gift_name: g.gift_name,
        gift_price: g.price,
        gift_img: g.img,
        spent: 0,
        profit: earned,
        synthetic_result: 1,
        date: "",
        synthetic_time: 0,
        gift_id: g.gift_id,
        gift_num: g.gift_num,
      });
    }
  }

  const giftList = Array.from(giftMap.values());
  const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

  return {
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    replaceCount: 0,
    synthesisCount,
    successCount: synthesisCount,
    giftList,
    anchors,
    detailedRecords,
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
    // 天选/红包礼物在消费记录方式下同样需要排除（产物可能与其重合）
    const excludedGiftIds = new Set<number>([...tianxuanGiftIds, ...redPocketGiftIds]);

    // 合成产物礼物在未送出前暂存于包裹（bag_list），不在消费记录中；在线时抓取用于补充产出
    let bagGifts: BagGiftItem[] = [];
    try {
      bagGifts = await fetchBagList(platform, cookie);
    } catch (err) {
      console.error("[SynthesisStats] 获取包裹礼物失败:", err);
    }

    for (const activity of effectiveSynthConfig.current_activity) {
      try {
        // 消费记录计算方式：直接从全量消费记录计算，无需抓取活动信息/记录
        const profit = calcPayRecordActivityProfit(records, activity, excludedGiftIds, bagGifts);
        // 活动图标：优先取配置中最后一个产物的图片；找不到时依次回退其他产物。
        // 图片来源依次：礼物目录（全局，最可靠）、包裹、活动产物列表。
        const products = activity.products || [];
        const findProductImg = (productName: string): string | undefined => {
          const bagGift = bagGifts.find((g) => g.img && g.gift_name.includes(productName));
          if (bagGift) return bagGift.img;
          const prodGift = profit.giftList.find((g) => g.gift_img && g.gift_name.includes(productName));
          if (prodGift) return prodGift.gift_img;
          const catGift = getCatalogGiftList().find((g) => g.name.includes(productName));
          return catGift ? (catGift.img_basic || catGift.webp || catGift.gif || "") : undefined;
        };
        let activityIcon: string | undefined = findProductImg(
          products.length > 0 ? products[products.length - 1] : "",
        );
        if (!activityIcon) {
          for (const p of products) {
            activityIcon = findProductImg(p);
            if (activityIcon) break;
          }
        }
        activities.push({
          id: activity.id,
          name: activity.name || activity.id,
          icon: activityIcon,
          start_time: activity.start_time,
          end_time: activity.end_time,
          profit,
          certifications: [],
        });
      } catch (err) {
        console.error(`[SynthesisStats] 获取活动 ${activity.id} 失败:`, err);
        activities.push({
          id: activity.id,
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
  antiKill: AntiKillStats;
};

/** 防氪记录统计：只追踪最近 30 天消费，提醒用户理性消费 */
type AntiKillStats = {
  totalBattery: number; // 近30天真实消费电池（不封顶）
  noSpendDays: number; // 30 天内未消费的天数
  over1000Days: number; // 30 天内单日消费超过 1000 电池的天数
  value: number; // 防氪值：10000 - 近30天累计封顶电池（单日超 1000 按 1000 计），最低为 0
};

/** 计算防氪记录（records 需为已剔除"已退回"的记录） */
function computeAntiKill(records: RawGiftRecord[]): AntiKillStats {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;
  const CAP_PER_DAY = 1000;
  const FULL_SCORE = 10000;
  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;

  const dayMap = new Map<string, number>();
  let totalBattery = 0;
  for (const r of records) {
    if (!r.timestamp) continue;
    if (r.timestamp * 1000 < cutoff) continue; // 不在最近 30 天内
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, "")) || 0;
    if (coins <= 0) continue;
    const date = getDateStr(r.timestamp);
    dayMap.set(date, (dayMap.get(date) || 0) + coins);
    totalBattery += coins;
  }

  let over1000Days = 0;
  let cappedSum = 0;
  for (const daily of dayMap.values()) {
    if (daily > CAP_PER_DAY) over1000Days++;
    cappedSum += Math.min(daily, CAP_PER_DAY);
  }

  return {
    totalBattery,
    noSpendDays: Math.max(0, WINDOW_DAYS - dayMap.size),
    over1000Days,
    value: Math.max(0, FULL_SCORE - cappedSum),
  };
}

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
        antiKill: computeAntiKill([]),
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
      antiKill: computeAntiKill(allRecords),
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
