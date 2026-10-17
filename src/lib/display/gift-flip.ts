/**
 * 礼物翻卡/礼物抽奖 —— 触发记录、排队调度与持久化。
 *
 * 记录文件：<dataDir>/uid_<mid>/gift-flip-records.json（按账号分开，用户私有、不上传）。
 *
 * 语义（对应主播侧需求）：
 *  - 每位粉丝**独立累计**触发礼物数量：某粉丝累计满 need 个即为**他**记 1 次触发（触发后清零再累计）。
 *  - `triggered`（历史累计触发次数）**只增不减**，无论实际翻不翻得过来都不丢、不错序。
 *  - `played` 记录已翻牌次数；`triggered - played` 即该粉丝的剩余翻牌次数。
 *  - 调度（pickNextFan）：只要有**从未翻过牌**（played===0）的粉丝，就先按首次入队时间给他翻；
 *    否则在剩余待翻的粉丝里按"最近一次翻牌时间最早者优先"轮流（round-robin）。
 *  - `results` 按翻牌顺序记录每次命中的选项，供面板追溯。
 */
import { getPlatform } from "@/lib/platform";
import type { Platform } from "@/lib/platform/types";

const RECORDS_NAME = "gift-flip-records.json";

/** 一次已完成的翻牌结果 */
export interface GiftFlipResult {
  /** 翻牌完成时间（ms） */
  ts: number;
  /** 命中的选项下标（0 起） */
  optionIndex: number;
}

/** 单个粉丝的翻卡记录 */
export interface GiftFlipFanRecord {
  uid: number;
  uname: string;
  face: string;
  /** 尚未凑满一次触发所需的礼物余额（0 ~ need-1） */
  pending: number;
  /** 历史累计触发次数（只增不减，是"记录"的核心） */
  triggered: number;
  /** 已翻牌次数（≤ triggered） */
  played: number;
  /** 已翻出的选项（按顺序） */
  results: GiftFlipResult[];
  /** 该粉丝首次触发的时间（ms），用于"未翻过牌者按时间顺序优先" */
  orderTs: number;
  /** 最近一次翻牌完成时间（ms），用于轮流调度；0 = 从未翻过 */
  lastPlayedTs: number;
}

export interface GiftFlipDb {
  /** uid（字符串）→ 记录 */
  fans: Record<string, GiftFlipFanRecord>;
}

async function dataDir(platform: Platform, mid: number): Promise<string> {
  return `${await platform.getDataDir()}/uid_${mid}`;
}

/** 规整单条记录：数值取整、非负，字段缺失回退。 */
function normalizeFan(raw: unknown): GiftFlipFanRecord | null {
  const f = (raw ?? {}) as Partial<GiftFlipFanRecord>;
  const uid = Number(f.uid);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  return {
    uid: Math.floor(uid),
    uname: typeof f.uname === "string" ? f.uname : "",
    face: typeof f.face === "string" ? f.face : "",
    pending: num(f.pending),
    triggered: num(f.triggered),
    played: num(f.played),
    results: Array.isArray(f.results)
      ? f.results
          .map((r) => ({
            ts: num((r as GiftFlipResult)?.ts),
            optionIndex: num((r as GiftFlipResult)?.optionIndex + 1) - 1, // 允许 0 下标
          }))
          .filter((r) => r.ts > 0)
      : [],
    orderTs: num(f.orderTs),
    lastPlayedTs: num(f.lastPlayedTs),
  };
}

/** 读取（内存缓存，避免频繁读盘；写入后同步更新）。 */
const cache = new Map<number, GiftFlipDb>();

export async function loadGiftFlipDb(mid: number): Promise<GiftFlipDb> {
  const hit = cache.get(mid);
  if (hit) return hit;
  const platform = await getPlatform();
  let db: GiftFlipDb = { fans: {} };
  try {
    const raw = JSON.parse(await platform.readFile(`${await dataDir(platform, mid)}/${RECORDS_NAME}`)) as GiftFlipDb;
    const fans: Record<string, GiftFlipFanRecord> = {};
    for (const [k, v] of Object.entries(raw?.fans ?? {})) {
      const rec = normalizeFan(v);
      if (rec) fans[String(rec.uid)] = rec;
    }
    db = { fans };
  } catch {
    /* 文件不存在/损坏 → 新建 */
  }
  cache.set(mid, db);
  return db;
}

async function persist(mid: number, db: GiftFlipDb): Promise<void> {
  cache.set(mid, db);
  try {
    const platform = await getPlatform();
    const dir = await dataDir(platform, mid);
    await platform.mkdir(dir);
    await platform.writeFile(`${dir}/${RECORDS_NAME}`, JSON.stringify(db, null, 2));
  } catch {
    /* 记录失败不影响直播展示 */
  }
}

/** 清空全部记录（面板「重置」按钮）：内存 + 落盘均为空。 */
export async function resetGiftFlipDb(mid: number): Promise<void> {
  await persist(mid, { fans: {} });
}

/**
 * 收到一个粉丝送出的触发礼物：累加其 pending，满 need 即记触发（可一次记多次）。
 * @returns 本次新增的触发次数与更新后的粉丝记录（粉丝不存在则新建）
 */
export async function accumulateGiftFlip(
  mid: number,
  need: number,
  fan: { uid: number; uname: string; face: string },
  num: number,
): Promise<{ db: GiftFlipDb; record: GiftFlipFanRecord | null; added: number }> {
  const db = await loadGiftFlipDb(mid);
  const uid = Math.floor(fan.uid);
  if (uid <= 0) return { db, record: null, added: 0 };
  const key = String(uid);
  const now = Date.now();
  const prev = db.fans[key];
  const rec: GiftFlipFanRecord =
    prev ?? {
      uid,
      uname: fan.uname || "",
      face: fan.face || "",
      pending: 0,
      triggered: 0,
      played: 0,
      results: [],
      orderTs: now,
      lastPlayedTs: 0,
    };
  // 昵称/头像以最新为准（可能有更新）
  if (fan.uname) rec.uname = fan.uname;
  if (fan.face) rec.face = fan.face;
  const needSafe = Math.max(1, Math.floor(need) || 1);
  rec.pending += Math.max(0, Math.floor(num) || 0);
  let added = 0;
  while (rec.pending >= needSafe) {
    rec.pending -= needSafe;
    rec.triggered += 1;
    added += 1;
  }
  if (added > 0 && rec.triggered === added) rec.orderTs = now; // 首次触发记录入队时间
  db.fans[key] = rec;
  // 仅在确有变化时落盘（避免无谓写盘）
  if (added > 0 || prev === undefined || fan.uname || fan.face) {
    await persist(mid, db);
  }
  return { db, record: rec, added };
}

/**
 * 「手动触发」（主播面板点击）：无视送礼规则，直接为该记录（key = 主播 uid）记一次触发，
 * 使其立即出现在「待翻队列」与记录列表中；实际播放优先级由主进程的内存队列保证（插队到下一次）。
 * @returns 更新后的记录（uid 非法则 null）
 */
export async function recordManualTrigger(
  mid: number,
  fan: { uid: number; uname: string; face: string },
): Promise<GiftFlipFanRecord | null> {
  const db = await loadGiftFlipDb(mid);
  const uid = Math.floor(fan.uid);
  if (uid <= 0) return null;
  const key = String(uid);
  const now = Date.now();
  const prev = db.fans[key];
  const rec: GiftFlipFanRecord =
    prev ?? {
      uid,
      uname: fan.uname || "主播手动抽卡",
      face: fan.face || "",
      pending: 0,
      triggered: 0,
      played: 0,
      results: [],
      orderTs: now,
      lastPlayedTs: 0,
    };
  if (fan.uname) rec.uname = fan.uname;
  if (fan.face) rec.face = fan.face;
  rec.triggered += 1;
  if (rec.triggered === 1) rec.orderTs = now; // 首次入队时间
  db.fans[key] = rec;
  await persist(mid, db);
  return rec;
}

/**
 * 调度下一个该翻牌的粉丝（不修改记录）：
 *  - 待翻队列 = triggered > played 的粉丝；
 *  - 队列为空 → null；
 *  - 存在 played===0（从未翻过）者 → 取 orderTs 最早的一个；
 *  - 否则取 lastPlayedTs 最早的一个（轮流）。
 */
export function pickNextFan(db: GiftFlipDb): GiftFlipFanRecord | null {
  const cands = Object.values(db.fans).filter((f) => f.triggered > f.played);
  if (cands.length === 0) return null;
  const never = cands.filter((f) => f.played === 0);
  const pool = never.length > 0 ? never : cands;
  pool.sort((a, b) => {
    const ka = a.played === 0 ? a.orderTs : a.lastPlayedTs;
    const kb = b.played === 0 ? b.orderTs : b.lastPlayedTs;
    if (ka !== kb) return ka - kb;
    return a.uid - b.uid;
  });
  return pool[0];
}

/** 记一次翻牌完成：played+1、追加结果、刷新 lastPlayedTs。 */
export async function markFlipPlayed(mid: number, uid: number, optionIndex: number): Promise<void> {
  const db = await loadGiftFlipDb(mid);
  const rec = db.fans[String(Math.floor(uid))];
  if (!rec) return;
  rec.played += 1;
  rec.results.push({ ts: Date.now(), optionIndex: Math.max(0, Math.floor(optionIndex) || 0) });
  rec.lastPlayedTs = Date.now();
  await persist(mid, db);
}

/** 面板展示用的有序记录列表（按首次触发时间升序）。 */
export function listFanRecords(db: GiftFlipDb): GiftFlipFanRecord[] {
  return Object.values(db.fans).sort((a, b) => {
    const ka = a.orderTs || Number.MAX_SAFE_INTEGER;
    const kb = b.orderTs || Number.MAX_SAFE_INTEGER;
    if (ka !== kb) return ka - kb;
    return a.uid - b.uid;
  });
}
