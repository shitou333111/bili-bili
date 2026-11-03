/**
 * 「备用药」活动：多人接力 PK 落榜主播的安慰抽奖。
 *
 * - 抽奖资格完全由服务端根据 B站 getSeasonBattleRecord 重新计算，客户端只负责展示；
 * - 记录与抽奖结果持久化到 .data/micro-light-records.json（原子写入 + 互斥锁），
 *   确保「一局只有一人能抽（先到先得）」在并发请求下也不会被破防；
 * - 活动参数、10 个奖品（1 特别奖 + 1 安慰奖 + 8 普通奖）、微光天使由 admin 维护，
 *   存于 .data/micro-light-config.json。
 *
 * B站接口不需要登录凭证（已实测：无 Cookie 返回 code=0）。
 */

import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".data");
const CONFIG_FILE = path.join(STATE_DIR, "micro-light-config.json");
const RECORDS_FILE = path.join(STATE_DIR, "micro-light-records.json");

const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BILI_LIVE = "https://api.live.bilibili.com";

/** 计划 PK 时长下限：短于 30 分钟的场次不参与活动 */
const SHORT_PK_SECONDS = 30 * 60;

/** 中奖期望计算的票数上限：第二名票数超过 5.5 万时按 5.5 万计算 */
export const EXPECTATION_VOTES_CAP = 55_000;

/** 当前赛季号：2026-11 = 103，此后每自然月 +1（以北京时间计算自然月） */
export function seasonIdFor(now = new Date()): number {
  const parts = chinaParts(now.getTime());
  return 103 + (parts.year - 2026) * 12 + (parts.month - 11);
}

/** 自然月键（北京时间）：2026-11 */
export function monthKeyFor(tsSeconds: number): string {
  const p = chinaParts(tsSeconds * 1000);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/** 北京时间的年/月/日（避免服务器部署在 UTC 时把月初/月末算错） */
function chinaParts(ms: number): { year: number; month: number; day: number } {
  const shifted = new Date(ms + 8 * 3600 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export type PrizeKind = "special" | "consolation" | "normal";

export type MicroLightPrize = {
  /** 稳定 id（special / consolation / p1..p8），用于记录与后台更新 */
  id: string;
  kind: PrizeKind;
  /** B站礼物名称 */
  name: string;
  /** B站礼物 id（可为 0，仅做展示与后台检索） */
  giftId: number;
  /** 礼物图标 */
  img?: string;
  /** 电池价值（用于期望值计算） */
  battery: number;
  /** 固定概率（special / consolation 使用；normal 由算法动态计算） */
  prob: number;
  /** 中奖词 */
  text: string;
};

export type MicroLightSponsor = {
  uid: number;
  uname: string;
  face: string;
  note?: string;
};

export type MicroLightConfig = {
  enabled: boolean;
  /** true = 按当前自然月自动推算赛季号；false = 使用 seasonId 固定值 */
  seasonAuto: boolean;
  seasonId: number;
  /** 每条记录的有效期（小时），以 pk_start_time 起算 */
  drawWindowHours: number;
  /** 每自然月最多抽中多少次非安慰奖 */
  monthlyWinCap: number;
  /** 本月奖金上限（电池）：本月累计中奖礼物价值超过该值时活动自动暂停；0 = 不限制 */
  monthlyBatteryCap: number;
  /** 「流局」判定：第二名票数低于该值即流局（流局记录不在页面展示） */
  voidScoreThreshold: number;
  /**
   * 中奖期望分母：中奖期望（电池）= 第二名票数 / votesPerBattery（默认 50）。
   * 第二名票数超过 5.5 万时按 5.5 万计算。
   */
  votesPerBattery: number;
  prizes: MicroLightPrize[];
  sponsors: MicroLightSponsor[];
  updatedAt: string;
};

export type MicroLightDrawStatus = "miss" | "pending" | "granted" | "void";

export type MicroLightDraw = {
  /** `${pkId}-${uid}`，唯一 */
  id: string;
  pkId: number;
  uid: number;
  uname: string;
  face?: string;
  roomId: number;
  seasonId: number;
  /** 自然月：YYYY-MM（按 pk_end_time 归属） */
  month: string;
  pkEndTime: number;
  votes: number;
  rank: number;
  participants: number;
  secondVotes: number;
  /** 旧字段（历史记录可能仍有），新记录不再写入 */
  playedFull?: boolean;
  /** 抽中的奖品；未中奖时为空 */
  prizeId: string;
  prizeKind: PrizeKind | "none";
  prizeName: string;
  prizeText: string;
  prizeImg?: string;
  battery: number;
  drawnAt: string;
  status: MicroLightDrawStatus;
  /** admin 备注 */
  note?: string;
};

type MicroLightState = {
  draws: MicroLightDraw[];
  /** 一局只允许一人抽奖：pkId -> 抽奖人 */
  locks: Record<string, { uid: number; drawId: string; at: string }>;
};

/** PK 记录（B站 getSeasonBattleRecord 的字段子集） */
type BiliSeasonRecord = {
  pk_id: number;
  pk_start_time: number;
  pk_end_time: number;
  pk_votes: number;
  battle_type: number;
  sub_battle_type: number;
  pk_score: number;
  total_score: number;
  match_info?: { name?: string; pk_votes?: number; room_id?: number; uid?: number } | null;
  other_match_list?: Array<{ name?: string; pk_votes?: number; room_id?: number; uid?: number; group_id?: number }> | null;
};

/** 一局中的主播（按票数从高到低排序） */
export type MicroLightAnchor = {
  name: string;
  votes: number;
  roomId: number;
  uid: number;
  isSelf: boolean;
  rank: number;
  /** 已经完成抽奖（红色徽章） */
  drawn: boolean;
};

export type EntryState =
  | "drawable" // 未流局，局内任意主播都可抽
  | "void" // 流局（内部用于拦截抽奖，页面不展示）
  | "skipped" // 计划时长不足 30 分钟（页面不展示）
  | "drawn" // 本人已抽
  | "locked" // 已被其他主播先抽
  | "expired" // 超过有效期
  | "paused"; // 活动关闭

export type MicroLightEntry = {
  pkId: number;
  startAt: number;
  endAt: number;
  duration: number;
  participants: number;
  votes: number;
  rank: number;
  secondVotes: number;
  /** 该局全部主播（按票数从高到低） */
  anchors: MicroLightAnchor[];
  state: EntryState;
  reason: string;
  draw?: MicroLightDraw;
};

/** 默认奖品：1 特别奖 + 1 安慰奖 + 8 普通奖（管理员可在 admin 页替换） */
function defaultPrizes(): MicroLightPrize[] {
  const normalValues = [1, 2, 4, 8, 16, 32, 64, 128];
  return [
    {
      id: "special",
      kind: "special",
      name: "特别奖",
      giftId: 0,
      battery: 500,
      prob: 0.005,
      text: "欧气爆棚！特别奖属于你",
    },
    {
      id: "consolation",
      kind: "consolation",
      name: "安慰奖",
      giftId: 0,
      battery: 1,
      prob: 0.25,
      text: "摸摸头，下个月继续加油",
    },
    ...normalValues.map((battery, i) => ({
      id: `p${i + 1}`,
      kind: "normal" as PrizeKind,
      name: `普通奖 ${i + 1}`,
      giftId: 0,
      battery,
      prob: 0,
      text: "恭喜获得普通奖，好运继续",
    })),
  ];
}

export const DEFAULT_CONFIG: MicroLightConfig = {
  enabled: false,
  seasonAuto: true,
  seasonId: 103,
  drawWindowHours: 24,
  monthlyWinCap: 3,
  monthlyBatteryCap: 0,
  voidScoreThreshold: 1000,
  votesPerBattery: 50,
  prizes: defaultPrizes(),
  sponsors: [],
  updatedAt: "",
};

/** 归一化奖品：固定 10 个槽位（1 special + 1 consolation + 8 normal），顺序固定 */
export function normalizePrizes(raw: unknown): MicroLightPrize[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: MicroLightPrize[] = [];
  const kinds: PrizeKind[] = ["special", "consolation"];
  const defaults = defaultPrizes();
  // 先取 special / consolation（找不到就沿用默认）
  for (const kind of kinds) {
    const found = list.find((p) => (p as MicroLightPrize)?.kind === kind) as MicroLightPrize | undefined;
    const fallback = defaults.find((p) => p.kind === kind)!;
    const src = found ?? fallback;
    out.push({
      id: kind,
      kind,
      name: String(src.name ?? fallback.name).trim() || fallback.name,
      giftId: Number(src.giftId) || 0,
      img: src.img ? String(src.img) : undefined,
      battery: Math.max(0, Number(src.battery) || 0),
      prob: clampProb(src.prob, kind === "special" ? 0.005 : 0.25),
      text: String(src.text ?? fallback.text),
    });
  }
  // 再取 8 个普通奖：优先沿用传入顺序，不足补默认
  const normals = list.filter((p) => (p as MicroLightPrize)?.kind === "normal") as MicroLightPrize[];
  for (let i = 0; i < 8; i++) {
    const src = normals[i];
    const fallback = defaults[2 + i];
    out.push({
      id: `p${i + 1}`,
      kind: "normal",
      name: String(src?.name ?? fallback.name).trim() || fallback.name,
      giftId: Number(src?.giftId) || 0,
      img: src?.img ? String(src.img) : undefined,
      battery: Math.max(0, Number(src?.battery ?? fallback.battery) || 0),
      prob: 0,
      text: String(src?.text ?? fallback.text),
    });
  }
  return out;
}

function clampProb(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(0.99, n);
}

export function normalizeConfig(raw: unknown): MicroLightConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    seasonAuto: r.seasonAuto !== false,
    seasonId: Number(r.seasonId) > 0 ? Number(r.seasonId) : DEFAULT_CONFIG.seasonId,
    drawWindowHours: Math.min(168, Math.max(1, Number(r.drawWindowHours) || 24)),
    monthlyWinCap: Math.min(10, Math.max(1, Number(r.monthlyWinCap) || 3)),
    monthlyBatteryCap: Math.max(0, Number(r.monthlyBatteryCap) || 0),
    voidScoreThreshold: Math.max(0, Number(r.voidScoreThreshold) || 1000),
    votesPerBattery: Math.max(1, Number(r.votesPerBattery) || 50),
    prizes: normalizePrizes(r.prizes),
    sponsors: Array.isArray(r.sponsors)
      ? (r.sponsors as Record<string, unknown>[])
          .map((s) => ({
            uid: Number(s.uid) || 0,
            uname: String(s.uname ?? "").trim(),
            face: String(s.face ?? ""),
            note: s.note ? String(s.note) : undefined,
          }))
          .filter((s) => s.uname)
      : [],
    updatedAt: String(r.updatedAt ?? ""),
  };
}

async function ensureDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

// 与 .data 其它模块一致的写入互斥锁：抽奖/存档在并发下串行执行
let writeLock: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

export async function readConfig(): Promise<MicroLightConfig> {
  await ensureDir();
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig(DEFAULT_CONFIG);
  }
}

/** 写入配置（不加锁）：仅供已持有 writeLock 的内部流程调用 */
async function writeConfigUnlocked(config: MicroLightConfig): Promise<MicroLightConfig> {
  const normalized = normalizeConfig({ ...config, updatedAt: new Date().toISOString() });
  await ensureDir();
  const tmp = `${CONFIG_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), "utf-8");
  await fs.rename(tmp, CONFIG_FILE);
  return normalized;
}

/** 写入配置：与抽奖共用同一把写锁，避免 admin 保存与抽奖自动暂停互相覆盖 */
export async function writeConfig(config: MicroLightConfig): Promise<MicroLightConfig> {
  return withWriteLock(() => writeConfigUnlocked(config));
}

async function readState(): Promise<MicroLightState> {
  await ensureDir();
  try {
    const raw = await fs.readFile(RECORDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      draws: Array.isArray(parsed?.draws) ? parsed.draws : [],
      locks: parsed?.locks && typeof parsed.locks === "object" ? parsed.locks : {},
    };
  } catch {
    return { draws: [], locks: {} };
  }
}

async function writeState(state: MicroLightState) {
  await ensureDir();
  const tmp = `${RECORDS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmp, RECORDS_FILE);
}

export async function readDraws(): Promise<MicroLightDraw[]> {
  return (await readState()).draws;
}

/** 修改一条抽奖记录的状态（admin 用）；返回更新后的记录 */
export async function updateDrawStatus(
  id: string,
  status: MicroLightDrawStatus,
  note?: string,
): Promise<MicroLightDraw | null> {
  return withWriteLock(async () => {
    if (!["miss", "pending", "granted", "void"].includes(status)) return null;
    const state = await readState();
    const rec = state.draws.find((d) => d.id === id);
    if (!rec) return null;
    rec.status = status;
    if (note !== undefined) rec.note = note;
    await writeState(state);
    return rec;
  });
}

/**
 * 撤销一条抽奖记录（admin「重抽」用）：删除记录本身并释放该 PK 的锁定，
 * 使其回到未抽奖状态；不会影响其它 PK 局的抽奖记录。
 */
export async function resetDraw(id: string): Promise<{ id: string; pkId: number } | null> {
  return withWriteLock(async () => {
    const state = await readState();
    const rec = state.draws.find((d) => d.id === id);
    if (!rec) return null;
    state.draws = state.draws.filter((d) => d.id !== id);
    for (const [pkId, lock] of Object.entries(state.locks)) {
      if (lock?.drawId === id) delete state.locks[pkId];
    }
    await writeState(state);
    return { id: rec.id, pkId: rec.pkId };
  });
}

/** ---- B站接口（公开，无需登录） ---- */

type BiliResp<T> = { code?: number; data?: T } | null;

async function biliJson<T>(url: string): Promise<BiliResp<T>> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BILI_UA, Referer: "https://live.bilibili.com/" },
      cache: "no-store",
    });
    return (await res.json()) as BiliResp<T>;
  } catch {
    return null;
  }
}

/** uid -> room_id（getRoomInfoOld，公开） */
export async function resolveRoomId(uid: number): Promise<number> {
  const data = await biliJson<{ roomid?: number }>(`${BILI_LIVE}/room/v1/Room/getRoomInfoOld?mid=${uid}`);
  return Number(data?.data?.roomid) || 0;
}

/** uid + room_id -> 主播昵称/头像（get_anchor_in_room，公开） */
export async function fetchAnchorInfo(uid: number, roomId: number): Promise<{ uname: string; face: string }> {
  const data = await biliJson<{ info?: { uname?: string; face?: string } }>(
    `${BILI_LIVE}/live_user/v1/UserInfo/get_anchor_in_room?roomid=${roomId}`,
  );
  const info = data?.data?.info ?? {};
  return {
    uname: String(info.uname ?? "") || String(uid),
    face: String(info.face ?? ""),
  };
}

/**
 * 拉取某个自然月内（1 号 ~ 今天）的多人 PK 记录。
 * B站接口默认只返回当天，必须用 date=YYYY-MM-DD 逐日查询；实测无需登录。
 *
 * 缓存策略：历史日期（早于今天）的记录不会再变化，进程内永久缓存；
 * 今天的记录短缓存 60 秒。这样反复打开页面只会真正请求 B站一次/天，
 * 大幅降低对 B站接口的调用量与超时风险。
 */
export async function fetchMultiPkRecords(
  uid: number,
  roomId: number,
  seasonId: number,
  month = monthKeyFor(Math.floor(Date.now() / 1000)),
): Promise<BiliSeasonRecord[]> {
  const dates = monthDates(month);
  const today = monthDate(Date.now());
  const map = new Map<number, BiliSeasonRecord>();
  let index = 0;
  async function worker() {
    while (index < dates.length) {
      const date = dates[index++];
      const cached = dateRecordsCache.get(`${uid}:${roomId}:${seasonId}:${date}`);
      let list: BiliSeasonRecord[] | null = null;
      if (cached) {
        // 历史日期不可变，永久使用；今天的数据 60 秒后重新拉取
        const fresh = date !== today && cached.immutable ? true : Date.now() - cached.at < RECORDS_CACHE_TTL;
        if (fresh) list = cached.list;
      }
      if (!list) {
        const url =
          `${BILI_LIVE}/xlive/general-interface/v1/battle/getSeasonBattleRecord` +
          `?ruid=${uid}&room_id=${roomId}&season_id=${seasonId}&date=${date}`;
        const data = await biliJson<{ list?: BiliSeasonRecord[] }>(url);
        const raw = data?.code === 0 && Array.isArray(data?.data?.list) ? data!.data!.list! : [];
        list = raw.filter((r) => Number(r?.battle_type) === 8 && Number(r?.pk_id) > 0);
        // 仅当接口正常返回且不是今天时才标记为不可变，避免把一次失败当永久缓存
        dateRecordsCache.set(`${uid}:${roomId}:${seasonId}:${date}`, {
          at: Date.now(),
          immutable: data?.code === 0 && date !== today,
          list,
        });
      }
      for (const r of list) {
        const pkId = Number(r?.pk_id) || 0;
        if (pkId && !map.has(pkId)) map.set(pkId, r);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, dates.length) }, worker));

  return [...map.values()].sort((a, b) => (Number(b.pk_start_time) || 0) - (Number(a.pk_start_time) || 0));
}

/** 按日记录缓存：历史日期 immutable=true 后不再请求 B站 */
const dateRecordsCache = new Map<string, { at: number; immutable: boolean; list: BiliSeasonRecord[] }>();
const RECORDS_CACHE_TTL = 60_000;

/** 北京时间的 YYYY-MM-DD */
function monthDate(ms: number): string {
  const p = chinaParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** 自然月内需要查询的日期（未来的日期不查） */
function monthDates(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const now = chinaParts(Date.now());
  if (year > now.year || (year === now.year && mon > now.month)) return [];
  const total = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const last = year === now.year && mon === now.month ? now.day : total;
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

/** 排序用票数：自己 + 所有对手 */
function allVotes(rec: BiliSeasonRecord): { own: number; list: number[] } {
  const own = Number(rec.pk_votes) || 0;
  const others = Array.isArray(rec.other_match_list)
    ? rec.other_match_list.map((o) => Number(o?.pk_votes) || 0)
    : [];
  return { own, list: [own, ...others] };
}

/** 计算单条记录的状态（不含全局锁，由调用方合并） */
export function evaluateRecord(
  rec: BiliSeasonRecord,
  config: MicroLightConfig,
  nowMs = Date.now(),
): Omit<MicroLightEntry, "state" | "reason" | "draw" | "anchors"> & { baseState: EntryState; baseReason: string } {
  const startAt = Number(rec.pk_start_time) || 0;
  const endAt = Number(rec.pk_end_time) || 0;
  const duration = endAt - startAt;
  const { own, list } = allVotes(rec);
  const sorted = [...list].sort((a, b) => b - a);
  const secondVotes = sorted[1] ?? 0;
  const rank = 1 + list.filter((v) => v > own).length;
  const participants = list.length;
  const voidThreshold = config.voidScoreThreshold ?? 1000;

  const base = {
    pkId: Number(rec.pk_id) || 0,
    startAt,
    endAt,
    duration,
    participants,
    votes: own,
    rank,
    secondVotes,
  };

  // 计划时长（结束时间 - 开始时间）短于 30 分钟的直接排除（例如 10 分钟场次）
  if (duration > 0 && duration < SHORT_PK_SECONDS) {
    return { ...base, baseState: "skipped", baseReason: "计划时长不足 30 分钟，不参与活动" };
  }
  // 有效期：以 pk_start_time 起算（可配置）
  if (nowMs - startAt * 1000 > config.drawWindowHours * 3600 * 1000 || startAt * 1000 > nowMs + 60_000) {
    return { ...base, baseState: "expired", baseReason: `已超过 ${config.drawWindowHours} 小时有效期` };
  }
  // 流局：第二名票数低于阈值（此类记录不在页面展示）
  if (secondVotes < voidThreshold) {
    return { ...base, baseState: "void", baseReason: `流局：本局第二名票数未达到 ${voidThreshold}` };
  }
  // 不再按名次/人数判定资格：未流局的局内任意主播都可以抽
  return { ...base, baseState: "drawable", baseReason: "" };
}

/** 月度已抽中的非安慰奖次数（废弃 / 判为未中奖的记录不计） */
export function monthlyWinCount(draws: MicroLightDraw[], uid: number, month: string): number {
  return draws.filter(
    (d) =>
      d.uid === uid &&
      d.month === month &&
      d.status !== "void" &&
      d.status !== "miss" &&
      d.prizeKind !== "none" &&
      d.prizeKind !== "consolation",
  ).length;
}

/** 本月累计中奖礼物的总价值（电池）：排除未中奖与已作废记录 */
export function monthlyPrizeTotal(draws: MicroLightDraw[], month: string): number {
  return draws
    .filter((d) => d.month === month && d.status !== "void" && d.status !== "miss" && d.prizeKind !== "none")
    .reduce((sum, d) => sum + (Number(d.battery) || 0), 0);
}

/** 把一条记录组装成页面可展示的完整条目（合并锁 / 已抽 / 活动开关） */
export function buildEntry(
  rec: BiliSeasonRecord,
  config: MicroLightConfig,
  draws: MicroLightDraw[],
  locks: Record<string, { uid: number; drawId: string }>,
  uid: number,
  selfName: string,
  selfRoomId: number,
  _month: string,
  nowMs = Date.now(),
): MicroLightEntry {
  const base = evaluateRecord(rec, config, nowMs);
  const { baseState, baseReason, ...rest } = base;
  const pkId = rest.pkId;
  const existing = draws.find((d) => d.pkId === pkId);

  // 该局全部主播，按票数从高到低排序
  const others = Array.isArray(rec.other_match_list) ? rec.other_match_list : [];
  const anchors: MicroLightAnchor[] = [
    {
      name: selfName || String(uid),
      votes: rest.votes,
      roomId: selfRoomId,
      uid,
      isSelf: true,
      rank: 0,
      drawn: false,
    },
    ...others.map((o) => ({
      name: String(o?.name ?? ""),
      votes: Number(o?.pk_votes) || 0,
      roomId: Number(o?.room_id) || 0,
      uid: Number(o?.uid) || 0,
      isSelf: false,
      rank: 0,
      drawn: false,
    })),
  ].sort((a, b) => b.votes - a.votes);
  anchors.forEach((a, i) => {
    a.rank = i + 1;
  });
  if (existing) {
    const target = anchors.find(
      (a) =>
        (a.isSelf && existing.uid === uid) ||
        (a.roomId > 0 && a.roomId === existing.roomId) ||
        (a.name !== "" && a.name === existing.uname),
    );
    if (target) target.drawn = true;
  }

  // 计划时长不足 30 分钟的场次一律不展示（即使历史上已被抽过也不显示）
  if (baseState === "skipped") {
    return { ...rest, anchors, state: "skipped", reason: baseReason };
  }

  if (existing) {
    if (existing.uid === uid) {
      return { ...rest, anchors, state: "drawn", reason: "本局已抽奖", draw: existing };
    }
    // 一局只有一人能抽（先到先得）：即使锁记录丢失，也以已有抽奖记录为准
    return { ...rest, anchors, state: "locked", reason: "本局已被其他主播先抽走（先到先得）" };
  }
  // 流局 / 过期记录优先展示自身原因，不因活动开关而改变提示
  if (baseState === "void" || baseState === "expired") {
    return { ...rest, anchors, state: baseState, reason: baseReason };
  }
  const lock = locks[pkId];
  if (lock && lock.uid !== uid) {
    return { ...rest, anchors, state: "locked", reason: "本局已被其他主播先抽走（先到先得）" };
  }
  if (!config.enabled) {
    return { ...rest, anchors, state: "paused", reason: "活动暂未开放" };
  }
  return { ...rest, anchors, state: "drawable", reason: "" };
}

/** 抽奖结果（含每个奖品的最终概率，便于后台预览/排查） */
export type PrizeRoll = {
  prize: MicroLightPrize | null;
  probabilities: Array<{ id: string; name: string; prob: number; battery: number }>;
  /** 目标期望值（电池） */
  targetEv: number;
};

/**
 * 动态概率：
 * 1）特别奖 / 安慰奖使用 admin 配置的固定概率；
 * 2）剩余概率按「价值越高、概率越低」的指数倾斜（softmax）分配给 8 个普通奖，
 *    并用二分法求 β，使普通奖的期望值恰好补足「第二名票数 / votesPerBattery」这个总期望
 *    （第二名票数超过 5.5 万按 5.5 万计算，期望取整数）；
 * 3）期望超出可达区间时收敛到最便宜/最贵奖品，保证概率和为 1。
 * 这套「固定稀有奖 + 期望值反解权重」是主流抽奖（扭蛋/盲盒）的常见做法：
 * 玩家投入决定奖池期望，稀有奖靠固定低概率兜底。
 */
export function rollPrize(config: MicroLightConfig, votes: number, opts: { forceConsolation?: boolean } = {}): PrizeRoll {
  const special = config.prizes.find((p) => p.kind === "special") ?? null;
  const consolation = config.prizes.find((p) => p.kind === "consolation") ?? null;
  const normals = config.prizes.filter((p) => p.kind === "normal");
  const cappedVotes = Math.min(EXPECTATION_VOTES_CAP, Math.max(0, Number(votes) || 0));
  const targetEv = Math.round(cappedVotes / Math.max(1, config.votesPerBattery));

  if (opts.forceConsolation) {
    if (consolation) {
      return {
        prize: consolation,
        targetEv,
        probabilities: config.prizes.map((p) => ({
          id: p.id,
          name: p.name,
          prob: p.id === consolation.id ? 1 : 0,
          battery: p.battery,
        })),
      };
    }
    return { prize: null, targetEv, probabilities: [] };
  }

  const specialProb = special ? clampProb(special.prob, 0.005) : 0;
  const consolationProb = consolation ? clampProb(consolation.prob, 0.25) : 0;
  const mass = Math.max(0, 1 - specialProb - consolationProb);
  const values = normals.map((p) => Math.max(0, p.battery));

  // 普通奖的期望预算：总期望 - 稀有奖贡献；不足则全部压到最低价值奖品
  const rareEv =
    (special ? specialProb * special.battery : 0) + (consolation ? consolationProb * consolation.battery : 0);
  const normalEv = targetEv - rareEv;

  let normalProbs = new Array<number>(normals.length).fill(0);
  if (normals.length > 0 && mass > 0) {
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const target = Math.max(0, Math.min(normalEv, mass * maxV));
    if (maxV <= minV || target <= 0) {
      // 全部给最低价值奖品
      const idx = values.indexOf(minV);
      normalProbs[idx] = mass;
    } else if (target >= mass * maxV) {
      const idx = values.indexOf(maxV);
      normalProbs[idx] = mass;
    } else {
      // 归一化价值 u∈[0,1]，用指数倾斜 exp(-βu) 拟合目标期望
      const span = maxV - minV;
      const us = values.map((v) => (v - minV) / span);
      const targetU = target / mass - minV >= 0 ? (target / mass - minV) / span : 0;
      const expected = (beta: number) => {
        const ws = us.map((u) => Math.exp(-beta * u));
        const sum = ws.reduce((a, b) => a + b, 0);
        return ws.reduce((a, w, i) => a + (w / sum) * us[i], 0);
      };
      let lo = -60;
      let hi = 60;
      // expected(beta) 随 β 单调递减：expected(lo) ≈ 1，expected(hi) ≈ 0
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (expected(mid) > targetU) lo = mid;
        else hi = mid;
      }
      const beta = (lo + hi) / 2;
      const ws = us.map((u) => Math.exp(-beta * u));
      const sum = ws.reduce((a, b) => a + b, 0);
      normalProbs = ws.map((w) => (sum > 0 ? (mass * w) / sum : 0));
    }
  }

  const probs = config.prizes.map((p) => {
    if (p.kind === "special") return specialProb;
    if (p.kind === "consolation") return consolationProb;
    const idx = normals.findIndex((n) => n.id === p.id);
    return idx >= 0 ? normalProbs[idx] ?? 0 : 0;
  });
  const sum = probs.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (let i = 0; i < probs.length; i++) probs[i] /= sum;
  }

  // 加权随机
  let r = Math.random();
  let chosen: MicroLightPrize | null = null;
  for (let i = 0; i < config.prizes.length; i++) {
    r -= probs[i];
    if (r <= 0) {
      chosen = config.prizes[i];
      break;
    }
  }
  if (!chosen) chosen = config.prizes[config.prizes.length - 1] ?? null;

  return {
    prize: chosen,
    targetEv,
    probabilities: config.prizes.map((p, i) => ({ id: p.id, name: p.name, prob: probs[i], battery: p.battery })),
  };
}

/** 抽奖：重新拉取 B站记录并校验资格后落库；同一局仅允许一人抽中/未中奖 */
export async function drawForPk(args: {
  uid: number;
  pkId: number;
  roomId?: number;
}): Promise<{ draw: MicroLightDraw; entry: MicroLightEntry; config: MicroLightConfig }> {
  return withWriteLock(async () => {
    const config = await readConfig();
    if (!config.enabled) throw new Error("活动暂未开放");
    const roomId = args.roomId && args.roomId > 0 ? args.roomId : await resolveRoomId(args.uid);
    if (!roomId) throw new Error("未找到该 UID 的直播间");
    const seasonId = config.seasonAuto ? seasonIdFor() : config.seasonId;
    const currentMonth = monthKeyFor(Math.floor(Date.now() / 1000));
    const records = await fetchMultiPkRecords(args.uid, roomId, seasonId, currentMonth);
    const rec = records.find((r) => Number(r.pk_id) === args.pkId);
    if (!rec) throw new Error("未找到该 PK 记录，或记录已过期");

    const anchor = await fetchAnchorInfo(args.uid, roomId);
    const state = await readState();
    const month = monthKeyFor(Number(rec.pk_start_time) || 0);
    const entry = buildEntry(rec, config, state.draws, state.locks, args.uid, anchor.uname, roomId, month);
    if (entry.state === "drawn") {
      const existing = state.draws.find((d) => d.pkId === args.pkId && d.uid === args.uid)!;
      return { draw: existing, entry, config };
    }
    // 流局 / 已过期 / 已被抢抽 / 活动关闭不可抽；其余（未流局）局内任意主播都可以抽
    if (entry.state !== "drawable") {
      throw new Error(entry.reason || "该记录不可抽奖");
    }

    const wins = monthlyWinCount(state.draws, args.uid, month);
    const forceConsolation = wins >= config.monthlyWinCap;
    const roll = rollPrize(config, entry.secondVotes, { forceConsolation });
    const prize = roll.prize;
    const drawId = `${args.pkId}-${args.uid}`;
    const draw: MicroLightDraw = {
      id: drawId,
      pkId: args.pkId,
      uid: args.uid,
      uname: anchor.uname,
      face: anchor.face || undefined,
      roomId,
      seasonId,
      month,
      pkEndTime: Number(rec.pk_end_time) || 0,
      votes: Number(rec.pk_votes) || 0,
      rank: entry.rank,
      participants: entry.participants,
      secondVotes: entry.secondVotes,
      prizeId: prize?.id ?? "",
      prizeKind: prize ? prize.kind : "none",
      prizeName: prize?.name ?? "",
      prizeText: prize?.text ?? "",
      prizeImg: prize?.img,
      battery: prize?.battery ?? 0,
      drawnAt: new Date().toISOString(),
      status: prize ? "pending" : "miss",
    };
    state.draws.push(draw);
    state.locks[String(args.pkId)] = { uid: args.uid, drawId, at: draw.drawnAt };
    await writeState(state);

    // 每次中奖后检查本月累计奖金：超过上限则自动暂停活动（写入仍在同一把写锁内，避免并发覆盖）
    let effectiveConfig = config;
    if (draw.battery > 0 && config.monthlyBatteryCap > 0) {
      const total = monthlyPrizeTotal(state.draws, month);
      if (total > config.monthlyBatteryCap) {
        effectiveConfig = await writeConfigUnlocked({ ...config, enabled: false });
      }
    }
    return { draw, entry: { ...entry, state: "drawn", draw }, config: effectiveConfig };
  });
}
