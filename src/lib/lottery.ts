/**
 * 抽奖功能：服务器端数据存储与抽奖逻辑。
 *
 * - 每个用户（B站 mid）只能抽取一次，记录全局持久化到 .data/lottery-records.json。
 * - 中奖率由服务器配置控制（.data/lottery-config.json，admin 可改，格式 "1/n"），
 *   所有平台（新装/旧装）读取的都是服务器上的当前概率，改后立即生效。
 * - 每条记录保存抽奖当时的概率（odds），并记录奖品是否已发放（rewardGranted），
 *   由 admin 标记发放，避免重复发放。
 * - 抽奖记录由服务器统一维护，客户端可通过 /api/lottery/records 长期查看自己的结果，
 *   admin 页面通过 /api/admin/lottery 查看全部记录。
 */

import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".data");
const LOTTERY_FILE = path.join(STATE_DIR, "lottery-records.json");
const LOTTERY_CONFIG_FILE = path.join(STATE_DIR, "lottery-config.json");

/** 默认概率分母（未配置时）：1/20 */
export const DEFAULT_ODDS_DENOM = 20;
/** 奖品文案 */
export const LOTTERY_PRIZE = "一个月舰长";

export type LotteryRecord = {
  mid: number;
  uname: string;
  drawnAt: string; // ISO 时间
  won: boolean; // true = 中奖
  prize: string; // 奖品描述
  odds: string; // 抽奖时的概率，如 "1/20"
  rewardGranted: boolean; // 奖品是否已发放（admin 标记，避免重复发放）
};

/**
 * 抽奖状态三态（admin 按钮点击循环）：
 * - all：全部开放，抽奖可进行，帮助页入口可见；
 * - paused：已暂停，抽奖不可进行（页面可打开但不可抽奖）；
 * - anchor：仅主播，帮助页入口隐藏（不显示），只保留「主播」页入口，仍可正常抽奖。
 */
export type LotteryMode = "all" | "paused" | "anchor";

/** 三态取值顺序（与 admin 按钮点击循环顺序一致） */
export const LOTTERY_MODES: readonly LotteryMode[] = ["all", "paused", "anchor"];

/** 服务器端抽奖配置（概率分母 + 状态） */
export type LotteryConfig = {
  oddsDenom: number;
  /** 抽奖状态三态（可见范围 + 是否可抽） */
  mode: LotteryMode;
};

/** "1/n" 文案 */
export function oddsText(denom: number): string {
  return `1/${denom}`;
}

// 文件写入互斥锁，防止并发抽奖时写入互相覆盖
let writeLock: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

async function ensureDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

/** 归一化记录：兼容旧数据（无 odds/rewardGranted 字段） */
function normalizeRecord(r: Partial<LotteryRecord>): LotteryRecord {
  return {
    mid: Number(r.mid ?? 0),
    uname: String(r.uname ?? "未知用户"),
    drawnAt: String(r.drawnAt ?? ""),
    won: !!r.won,
    prize: String(r.prize ?? LOTTERY_PRIZE),
    odds: String(r.odds ?? oddsText(DEFAULT_ODDS_DENOM)),
    rewardGranted: !!r.rewardGranted,
  };
}

export async function readLotteryRecords(): Promise<LotteryRecord[]> {
  await ensureDir();
  try {
    const raw = await fs.readFile(LOTTERY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.records ?? []);
    return (list as Partial<LotteryRecord>[]).map(normalizeRecord);
  } catch {
    return [];
  }
}

async function writeLotteryRecords(records: LotteryRecord[]) {
  await ensureDir();
  // 先写临时文件再原子替换：避免 admin 并发读取时读到半截 JSON（解析失败会返回空列表）
  const tmp = `${LOTTERY_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), "utf-8");
  await fs.rename(tmp, LOTTERY_FILE);
}

/** 归一化抽奖状态：优先取合法 mode；否则兼容旧 enabled 布尔（false→paused，true→all）；默认 all */
function normalizeMode(mode: unknown, legacyEnabled: unknown): LotteryMode {
  if (mode === "all" || mode === "paused" || mode === "anchor") return mode;
  if (legacyEnabled === false) return "paused";
  return "all";
}

/** 读取服务器当前抽奖配置（无配置时默认：1/20、全部开放） */
export async function readLotteryConfig(): Promise<LotteryConfig> {
  await ensureDir();
  try {
    const raw = await fs.readFile(LOTTERY_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const denom = Number(parsed?.oddsDenom);
    if (Number.isInteger(denom) && denom >= 2) {
      return {
        oddsDenom: denom,
        mode: normalizeMode(parsed?.mode, parsed?.enabled),
      };
    }
  } catch {
    // 无配置或格式错误 → 默认
  }
  return { oddsDenom: DEFAULT_ODDS_DENOM, mode: "all" };
}

/**
 * 更新服务器抽奖配置（admin 调用）：
 * - oddsDenom：概率分母（格式 "1/n"，n≥2 整数），改后所有平台立即生效；
 * - mode：抽奖状态三态（all/paused/anchor）。
 */
export async function updateLotteryConfig(partial: { oddsDenom?: number; mode?: LotteryMode }): Promise<LotteryConfig> {
  const current = await readLotteryConfig();
  const next: LotteryConfig = { ...current };
  if (partial.oddsDenom !== undefined) {
    const denom = Math.floor(Number(partial.oddsDenom));
    if (!Number.isInteger(denom) || denom < 2) {
      throw new Error("概率分母必须是大于等于 2 的整数");
    }
    next.oddsDenom = denom;
  }
  if (partial.mode !== undefined) {
    if (!LOTTERY_MODES.includes(partial.mode)) {
      throw new Error("抽奖状态不合法");
    }
    next.mode = partial.mode;
  }
  await ensureDir();
  await fs.writeFile(LOTTERY_CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/** 获取某用户（mid）的抽奖记录，未抽过返回 null */
export async function getUserLotteryRecord(mid: number): Promise<LotteryRecord | null> {
  const records = await readLotteryRecords();
  return records.find((r) => r.mid === mid) ?? null;
}

/**
 * 执行抽奖：按服务器当前概率判定（1/n），奖品为一个月舰长。
 * 同一 mid 只能抽取一次，重复抽取直接返回已有记录。
 * 活动暂停（mode=paused）时抛错，前端展示"抽奖活动当前已暂停"。
 * 记录会保存抽奖当时的概率，供长期查看。
 */
export async function drawLottery(mid: number, uname: string): Promise<{ record: LotteryRecord; alreadyDrawn: boolean }> {
  return withWriteLock(async () => {
    const records = await readLotteryRecords();
    const existing = records.find((r) => r.mid === mid);
    if (existing) {
      return { record: existing, alreadyDrawn: true };
    }
    const cfg = await readLotteryConfig();
    if (cfg.mode === "paused") {
      throw new Error("抽奖活动当前已暂停");
    }
    const won = Math.floor(Math.random() * cfg.oddsDenom) === 0;
    const record: LotteryRecord = {
      mid,
      uname,
      drawnAt: new Date().toISOString(),
      won,
      prize: LOTTERY_PRIZE,
      odds: oddsText(cfg.oddsDenom),
      rewardGranted: false,
    };
    records.push(record);
    await writeLotteryRecords(records);
    return { record, alreadyDrawn: false };
  });
}

/** 标记某中奖用户的奖品已发放（admin 调用），避免重复发放；记录不存在返回 null */
export async function markRewardGranted(mid: number): Promise<LotteryRecord | null> {
  return withWriteLock(async () => {
    const records = await readLotteryRecords();
    const rec = records.find((r) => r.mid === mid);
    if (!rec) return null;
    rec.rewardGranted = true;
    await writeLotteryRecords(records);
    return rec;
  });
}
