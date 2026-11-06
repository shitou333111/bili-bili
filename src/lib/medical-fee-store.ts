/**
 * 「发医药费」服务端存储（不使用数据库）。
 *
 * 存储方案（与 1 万主播 / 每月百万级记录的量级匹配）：
 * - 微信群配置：.data/medical-fee/groups.json（群名 + 截图 URL，admin 维护）
 * - 主播所在群：.data/medical-fee/memberships.json（uid -> 群 id 列表，用户自行登记）
 * - 医药费发放记录：.data/medical-fee/pay/YYYY-MM/records.ndjson
 *   **追加写**的 NDJSON 事件日志，同一 pkId 以最后一条为准（天然支持覆盖上传）。
 *   优点：每次上传只 append 一行（O(1)），不会整月重写；读取时按月加载进内存去重。
 *   对比单个大 JSON：单文件方案每次保存都要读取+重写几十 MB，锁竞争严重；NDJSON 追加写无此问题。
 * - 排行榜聚合：.data/medical-fee/aggregates/shard-<0..31>.json
 *   按 uid 取模分 32 片，记录总/本月/本周收发金额与次数。上传时按「旧记录减、新记录加」更新增量，
 *   单个分片只有几百个主播，写入体积小；排行榜读取 32 个分片合并即可。
 *   对比 SQLite：SQLite 适合强查询/事务，但本项目没有数据库依赖，文件+进程内缓存已足够，
 *   且部署/备份就是拷贝 .data 目录；代价是只能单进程写入（通过写锁串行化，本项目单实例部署可接受）。
 */

import { promises as fs } from "fs";
import path from "path";
import {
  calcFeeSplit,
  FEE_VALID_HOURS,
  round1,
  type WeChatGroup,
} from "@/lib/medical-fee-calc";

const DATA_DIR = path.join(process.cwd(), ".data", "medical-fee");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const MEMBERSHIP_FILE = path.join(DATA_DIR, "memberships.json");
const PAY_DIR = path.join(DATA_DIR, "pay");
const AGG_DIR = path.join(DATA_DIR, "aggregates");
const AGG_SHARDS = 32;

export type MedicalFeeGroup = {
  id: string;
  name: string;
  /** 微信群截图 URL（由 admin 上传到素材接口后填入） */
  image: string;
  updatedAt: string;
};

type GroupsFile = { groups: MedicalFeeGroup[] };

type MembershipsFile = {
  byUid: Record<string, { uid: number; groups: string[]; updatedAt: string }>;
};

export type MedicalFeePayRecord = {
  pkId: number;
  pkStartAt: number;
  pkEndAt: number;
  /** 归属自然月（北京时间）：YYYY-MM（按 PK 开始时间） */
  month: string;
  payerUid: number;
  /** 医药费总额（元） */
  payerAmount: number;
  receiverUids: number[];
  /** 每位收款人金额 */
  perPerson: number;
  /** 用户修改后的分数 uid -> votes */
  scores: Record<string, number>;
  /** uid -> 昵称，供排行榜展示 */
  names: Record<string, string>;
  operatorUid: number;
  updatedAt: string;
};

type AggUser = {
  uid: number;
  uname: string;
  paid: number;
  received: number;
  paidCount: number;
  receivedCount: number;
  month: string;
  monthPaid: number;
  monthReceived: number;
  monthPaidCount: number;
  monthReceivedCount: number;
  week: string;
  weekPaid: number;
  weekReceived: number;
  weekPaidCount: number;
  weekReceivedCount: number;
  updatedAt: string;
};

type AggShardFile = { users: Record<string, AggUser> };

/** 全局写锁：所有写操作串行执行（单实例部署下的并发安全） */
let writeLock: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => {
    resolve = r;
  });
  return prev.then(fn).finally(() => resolve!());
}

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PAY_DIR, { recursive: true });
  await fs.mkdir(AGG_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, data: unknown) {
  await ensureDirs();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), "utf-8");
  await fs.rename(tmp, file);
}

/** 北京时间 */
function chinaParts(ms: number): { year: number; month: number; day: number } {
  const shifted = new Date(ms + 8 * 3600 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 自然月键（北京时间）：YYYY-MM */
export function feeMonthKey(tsSeconds: number): string {
  const p = chinaParts(tsSeconds * 1000);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/** 本周周一日期键（北京时间）：YYYY-MM-DD */
export function feeWeekKey(tsSeconds = Date.now() / 1000): string {
  const p = chinaParts(tsSeconds * 1000);
  const utc = Date.UTC(p.year, p.month - 1, p.day);
  const dow = new Date(utc).getUTCDay(); // 0=周日
  const offset = (dow + 6) % 7;
  const monday = new Date(utc - offset * 86400_000);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(
    monday.getUTCDate(),
  ).padStart(2, "0")}`;
}

// ===== 微信群配置 =====

export async function readGroups(): Promise<MedicalFeeGroup[]> {
  const file = await readJson<GroupsFile>(GROUPS_FILE, { groups: [] });
  return Array.isArray(file.groups)
    ? file.groups
        .filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
        .map((g) => ({
          id: g.id,
          name: String(g.name).slice(0, 40),
          image: typeof g.image === "string" ? g.image : "",
          updatedAt: typeof g.updatedAt === "string" ? g.updatedAt : "",
        }))
    : [];
}

/** 微信群数量上限 */
export const MAX_FEE_GROUPS = 50;

/** admin 保存微信群配置：新增项未带 id 时自动生成，最多 50 个群 */
export async function writeGroups(raw: unknown): Promise<MedicalFeeGroup[]> {
  const list = Array.isArray(raw) ? raw : [];
  const now = new Date().toISOString();
  const result: MedicalFeeGroup[] = [];
  for (const item of list.slice(0, MAX_FEE_GROUPS)) {
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? "").trim().slice(0, 40);
    if (!name) continue;
    const id = /^[A-Za-z0-9_-]{3,40}$/.test(String(r.id ?? ""))
      ? String(r.id)
      : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const image = String(r.image ?? "");
    result.push({ id, name, image: image.startsWith("http") || image.startsWith("/") ? image : "", updatedAt: now });
  }
  return withWriteLock(async () => {
    await writeJsonAtomic(GROUPS_FILE, { groups: result } satisfies GroupsFile);
    return result;
  });
}

// ===== 主播所在微信群 =====

async function readMemberships(): Promise<MembershipsFile> {
  const file = await readJson<MembershipsFile>(MEMBERSHIP_FILE, { byUid: {} });
  if (!file || typeof file !== "object" || !file.byUid) return { byUid: {} };
  return file;
}

export async function readMemberGroupIds(uid: number): Promise<string[]> {
  const file = await readMemberships();
  return file.byUid[String(uid)]?.groups ?? [];
}

/** 添加/移除自己所在的微信群；返回更新后的群 id 列表 */
export async function updateMembership(
  uid: number,
  groupId: string,
  action: "add" | "remove",
): Promise<string[]> {
  const groups = await readGroups();
  if (!groups.some((g) => g.id === groupId)) throw new Error("微信群不存在");
  return withWriteLock(async () => {
    const file = await readMemberships();
    const key = String(uid);
    const current = new Set(file.byUid[key]?.groups ?? []);
    if (action === "add") current.add(groupId);
    else current.delete(groupId);
    const valid = new Set(groups.map((g) => g.id));
    const next = [...current].filter((id) => valid.has(id));
    file.byUid[key] = { uid, groups: next, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(MEMBERSHIP_FILE, file);
    return next;
  });
}

/** 群 + 成员 uid 列表（用于页面计算发红包方案） */
export async function readGroupsWithMembers(): Promise<WeChatGroup[]> {
  const [groups, memberships] = await Promise.all([readGroups(), readMemberships()]);
  const membersByGroup = new Map<string, number[]>();
  for (const g of groups) membersByGroup.set(g.id, []);
  for (const entry of Object.values(memberships.byUid)) {
    for (const gid of entry.groups ?? []) {
      membersByGroup.get(gid)?.push(Number(entry.uid) || 0);
    }
  }
  return groups
    .map((g, i) => ({
      id: g.id,
      name: g.name,
      index: i + 1,
      image: g.image,
      members: membersByGroup.get(g.id) ?? [],
    }))
    .filter((g) => g.id);
}

// ===== 发放记录（追加写 NDJSON，按月分文件） =====

type MonthCache = { records: Map<number, MedicalFeePayRecord> };

const monthCache = new Map<string, MonthCache>();

function payFile(month: string): string {
  return path.join(PAY_DIR, month, "records.ndjson");
}

async function loadMonth(month: string): Promise<MonthCache> {
  const cached = monthCache.get(month);
  if (cached) return cached;
  const records = new Map<number, MedicalFeePayRecord>();
  try {
    const raw = await fs.readFile(payFile(month), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as MedicalFeePayRecord;
        if (rec && Number(rec.pkId) > 0) records.set(Number(rec.pkId), rec);
      } catch {
        /* 跳过损坏行 */
      }
    }
  } catch {
    /* 文件不存在 */
  }
  const entry = { records };
  monthCache.set(month, entry);
  return entry;
}

export async function readPayRecord(pkId: number, month: string): Promise<MedicalFeePayRecord | null> {
  const data = await loadMonth(month);
  return data.records.get(pkId) ?? null;
}

export async function readMonthPayRecords(month: string): Promise<MedicalFeePayRecord[]> {
  const data = await loadMonth(month);
  return [...data.records.values()];
}

export type UpsertPayInput = {
  operatorUid: number;
  pkId: number;
  pkStartAt: number;
  pkEndAt: number;
  payerUid: number;
  receiverUids: number[];
  scores: Record<string, number>;
  names: Record<string, string>;
};

/** 校验 + 计算 + 落库（只接受有效期内、正在进行的记录） */
export async function upsertPayRecord(input: UpsertPayInput): Promise<MedicalFeePayRecord> {
  const nowMs = Date.now();
  const startMs = Number(input.pkStartAt) * 1000;
  if (!input.pkId || !startMs) throw new Error("缺少 PK 信息");
  if (nowMs - startMs > FEE_VALID_HOURS * 3600 * 1000 || startMs > nowMs + 5 * 60 * 1000) {
    throw new Error(`该记录已超过 ${FEE_VALID_HOURS} 小时有效期`);
  }
  if (!input.payerUid) throw new Error("请先指定发医药费的主播");
  const receivers = [...new Set(input.receiverUids.filter((u) => u > 0 && u !== input.payerUid))];
  if (receivers.length === 0) throw new Error("请先指定收医药费的主播");

  const scores: Record<string, number> = {};
  for (const [uid, votes] of Object.entries(input.scores ?? {})) {
    const n = Number(uid);
    if (!n) continue;
    scores[String(n)] = Math.max(0, Math.round(Number(votes) || 0));
  }
  const names: Record<string, string> = {};
  for (const [uid, name] of Object.entries(input.names ?? {})) {
    const n = Number(uid);
    if (!n) continue;
    names[String(n)] = String(name ?? "").slice(0, 40);
  }

  const split = calcFeeSplit(
    Object.entries(scores).map(([uid, votes]) => ({ uid: Number(uid), votes })),
    { payerUid: input.payerUid, receiverUids: receivers },
  );
  const month = feeMonthKey(Number(input.pkStartAt));
  const record: MedicalFeePayRecord = {
    pkId: input.pkId,
    pkStartAt: Number(input.pkStartAt),
    pkEndAt: Number(input.pkEndAt) || 0,
    month,
    payerUid: input.payerUid,
    payerAmount: split.total,
    receiverUids: receivers,
    perPerson: split.perPerson,
    scores,
    names,
    operatorUid: input.operatorUid,
    updatedAt: new Date().toISOString(),
  };

  return withWriteLock(async () => {
    await ensureDirs();
    const previous = (await loadMonth(month)).records.get(record.pkId) ?? null;
    // 追加一行：读取时同 pkId 以最后一条为准，实现「覆盖上传」
    await fs.mkdir(path.dirname(payFile(month)), { recursive: true });
    await fs.appendFile(payFile(month), `${JSON.stringify(record)}\n`, "utf-8");
    (await loadMonth(month)).records.set(record.pkId, record);
    if (previous) await applyAggregateDelta(previous, record, -1);
    await applyAggregateDelta(record, record, 1);
    return record;
  });
}

// ===== 聚合 / 排行榜 =====

function shardPath(uid: number): string {
  return path.join(AGG_DIR, `shard-${Math.abs(uid) % AGG_SHARDS}.json`);
}

/** 进程内缓存：分片文件较小（约几百个主播），按需加载 */
const aggCache = new Map<number, AggShardFile>();

async function loadShard(shard: number): Promise<AggShardFile> {
  const cached = aggCache.get(shard);
  if (cached) return cached;
  const data = await readJson<AggShardFile>(shardPath(shard), { users: {} });
  if (!data.users || typeof data.users !== "object") data.users = {};
  aggCache.set(shard, data);
  return data;
}

/** 取（或重置）当前周期字段 */
function normalizePeriods(user: AggUser, month: string, week: string): AggUser {
  if (user.month !== month) {
    user.month = month;
    user.monthPaid = 0;
    user.monthReceived = 0;
    user.monthPaidCount = 0;
    user.monthReceivedCount = 0;
  }
  if (user.week !== week) {
    user.week = week;
    user.weekPaid = 0;
    user.weekReceived = 0;
    user.weekPaidCount = 0;
    user.weekReceivedCount = 0;
  }
  return user;
}

function blankAgg(uid: number, uname: string, month: string, week: string): AggUser {
  return {
    uid,
    uname,
    paid: 0,
    received: 0,
    paidCount: 0,
    receivedCount: 0,
    month,
    monthPaid: 0,
    monthReceived: 0,
    monthPaidCount: 0,
    monthReceivedCount: 0,
    week,
    weekPaid: 0,
    weekReceived: 0,
    weekPaidCount: 0,
    weekReceivedCount: 0,
    updatedAt: "",
  };
}

/** sign=-1 撤销旧记录，sign=1 计入新记录 */
async function applyAggregateDelta(
  source: MedicalFeePayRecord,
  target: MedicalFeePayRecord,
  sign: 1 | -1,
) {
  const month = target.month;
  const week = feeWeekKey(target.pkStartAt);
  const now = new Date().toISOString();
  const entries = new Map<number, { paid: number; received: number; paidCount: number; receivedCount: number; uname: string }>();

  const bump = (
    uid: number,
    uname: string,
    paid: number,
    received: number,
    paidCount: number,
    receivedCount: number,
  ) => {
    const cur = entries.get(uid) ?? { paid: 0, received: 0, paidCount: 0, receivedCount: 0, uname: "" };
    cur.paid += paid * sign;
    cur.received += received * sign;
    cur.paidCount += paidCount * sign;
    cur.receivedCount += receivedCount * sign;
    if (uname) cur.uname = uname;
    entries.set(uid, cur);
  };

  if (source.payerUid) {
    bump(source.payerUid, source.names[String(source.payerUid)] ?? "", source.payerAmount, 0, 1, 0);
  }
  for (const uid of source.receiverUids) {
    bump(uid, source.names[String(uid)] ?? "", 0, source.perPerson, 0, 1);
  }

  // 按分片分组写入，避免同一 uid 的增减被拆到两次写
  const byShard = new Map<number, Map<string, AggUser>>();
  for (const [uid, delta] of entries) {
    const shard = Math.abs(uid) % AGG_SHARDS;
    const shardFile = await loadShard(shard);
    const key = String(uid);
    const user = normalizePeriods(
      shardFile.users[key] ?? blankAgg(uid, delta.uname, month, week),
      month,
      week,
    );
    if (delta.uname) user.uname = delta.uname;
    user.paid = Math.max(0, user.paid + delta.paid);
    user.received = Math.max(0, user.received + delta.received);
    user.paidCount = Math.max(0, user.paidCount + delta.paidCount);
    user.receivedCount = Math.max(0, user.receivedCount + delta.receivedCount);
    user.monthPaid = Math.max(0, user.monthPaid + delta.paid);
    user.monthReceived = Math.max(0, user.monthReceived + delta.received);
    user.monthPaidCount = Math.max(0, user.monthPaidCount + delta.paidCount);
    user.monthReceivedCount = Math.max(0, user.monthReceivedCount + delta.receivedCount);
    user.weekPaid = Math.max(0, user.weekPaid + delta.paid);
    user.weekReceived = Math.max(0, user.weekReceived + delta.received);
    user.weekPaidCount = Math.max(0, user.weekPaidCount + delta.paidCount);
    user.weekReceivedCount = Math.max(0, user.weekReceivedCount + delta.receivedCount);
    user.updatedAt = now;
    shardFile.users[key] = user;
    if (!byShard.has(shard)) byShard.set(shard, new Map());
    byShard.get(shard)!.set(key, user);
  }

  for (const [shard, users] of byShard) {
    const shardFile = aggCache.get(shard);
    if (!shardFile) continue;
    for (const [key, user] of users) shardFile.users[key] = user;
    await writeJsonAtomic(shardPath(shard), shardFile);
  }
}

export type FeePeriod = "all" | "month" | "week";

export type LeaderboardRow = {
  uid: number;
  uname: string;
  paid: number;
  received: number;
  net: number;
  paidCount: number;
  receivedCount: number;
  value: number;
  rank: number;
};

export type MedicalFeeLeaderboards = {
  month: string;
  week: string;
  /** 雷锋榜：发医药费金额 */
  leiFeng: LeaderboardRow[];
  /** 爽吃榜：收医药费金额 */
  chiHuo: LeaderboardRow[];
  /** 净利榜：收 - 发（前一半） */
  jingLi: LeaderboardRow[];
  /** 净利榜最后几名（与 jingLi 中间用省略号隔开） */
  jingLiBottom: LeaderboardRow[];
  /** 净利榜总人数（用于计算倒数序号） */
  jingLiTotal: number;
  /** 我自己的排名信息（可能不在榜单中） */
  me: { uid: number; leiFeng: LeaderboardRow | null; chiHuo: LeaderboardRow | null; jingLi: LeaderboardRow | null } | null;
};

function periodValues(user: AggUser, period: FeePeriod) {
  if (period === "month") {
    return { paid: user.monthPaid, received: user.monthReceived, paidCount: user.monthPaidCount, receivedCount: user.monthReceivedCount };
  }
  if (period === "week") {
    return { paid: user.weekPaid, received: user.weekReceived, paidCount: user.weekPaidCount, receivedCount: user.weekReceivedCount };
  }
  return { paid: user.paid, received: user.received, paidCount: user.paidCount, receivedCount: user.receivedCount };
}

async function readAllAggUsers(month: string, week: string): Promise<AggUser[]> {
  const users: AggUser[] = [];
  for (let shard = 0; shard < AGG_SHARDS; shard += 1) {
    const file = await loadShard(shard);
    for (const user of Object.values(file.users)) {
      if (!user || !user.uid) continue;
      normalizePeriods(user, month, week);
      users.push(user);
    }
  }
  return users;
}

export async function buildLeaderboards(
  period: FeePeriod,
  uid: number,
  limit = 20,
): Promise<MedicalFeeLeaderboards> {
  const now = Date.now() / 1000;
  const month = feeMonthKey(now);
  const week = feeWeekKey(now);
  const users = await readAllAggUsers(month, week);

  const rows = users
    .map((user) => {
      const v = periodValues(user, period);
      return {
        uid: user.uid,
        uname: user.uname,
        paid: v.paid,
        received: v.received,
        net: round1(v.received - v.paid),
        paidCount: v.paidCount,
        receivedCount: v.receivedCount,
        value: 0,
        rank: 0,
      } satisfies LeaderboardRow;
    })
    .filter((r) => r.paid > 0 || r.received > 0);

  const build = (valueOf: (r: LeaderboardRow) => number, includeNonPositive = false) => {
    const sorted = rows
      .map((r) => ({ ...r, value: valueOf(r) }))
      .filter((r) => includeNonPositive || r.value > 0)
      .sort((a, b) => b.value - a.value || a.uid - b.uid);
    sorted.forEach((r, i) => {
      r.rank = i + 1;
    });
    return sorted;
  };

  const leiFeng = build((r) => r.paid);
  const chiHuo = build((r) => r.received);
  const jingLi = build((r) => r.net, true);

  const pick = (list: LeaderboardRow[]) => {
    const top = list.slice(0, limit);
    if (uid > 0 && !top.some((r) => r.uid === uid)) {
      const found = list.find((r) => r.uid === uid);
      if (found) top.push(found);
    }
    return top;
  };

  const meRow = (list: LeaderboardRow[]) => list.find((r) => r.uid === uid) ?? null;

  // 净吃榜：人数较多时只展示前一半 + 最后一半，中间用省略号隔开
  const topCount = Math.ceil(limit / 2);
  const bottomCount = limit - topCount;
  const jingLiTop =
    jingLi.length <= limit ? jingLi : jingLi.slice(0, topCount);
  const jingLiBottom =
    jingLi.length <= limit ? [] : jingLi.slice(-bottomCount);

  return {
    month,
    week,
    leiFeng: pick(leiFeng),
    chiHuo: pick(chiHuo),
    jingLi: jingLiTop,
    jingLiBottom,
    jingLiTotal: jingLi.length,
    me: uid > 0 ? { uid, leiFeng: meRow(leiFeng), chiHuo: meRow(chiHuo), jingLi: meRow(jingLi) } : null,
  };
}

/** 本月「已发 / 已吃」次数（用于 PK 记录卡片的筛选按钮） */
export async function readMonthlyCounts(uid: number): Promise<{ paidCount: number; receivedCount: number }> {
  if (!uid) return { paidCount: 0, receivedCount: 0 };
  const month = feeMonthKey(Date.now() / 1000);
  const week = feeWeekKey();
  const file = await loadShard(Math.abs(uid) % AGG_SHARDS);
  const user = file.users[String(uid)];
  if (!user) return { paidCount: 0, receivedCount: 0 };
  normalizePeriods(user, month, week);
  return {
    paidCount: Math.max(0, Math.round(user.monthPaidCount)),
    receivedCount: Math.max(0, Math.round(user.monthReceivedCount)),
  };
}

/** 清空某月的记录缓存与内存（测试/维护用） */
export function clearMonthCache(month: string) {
  monthCache.delete(month);
}
