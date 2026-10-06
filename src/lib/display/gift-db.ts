/**
 * 展示模块 —— 礼物逐条记录 + 盲盒盈亏 · 弹幕查询。
 *
 * 目的解决"收入记录只能查到昨天/前天，没有今天（凌晨刚过 0 点连昨天也没有）"的缺陷：
 * 通过弹幕监听实时把礼物逐条记录到本地文件，供"今日 / 昨日（收入未更新时）"的盲盒盈亏计算，
 * 从而让观众发送查询弹幕即可得实时盈亏。礼物文件同时也作为"礼物展示"模块的数据来源。
 *
 * 盲盒盈亏口径与"盲盒"页面（stats-client calculateProfit）一致：
 *   - 抽数 = 爆出礼物记录抽数合计
 *   - 花费 = 抽数 × 盲盒单价（电池）
 *   - 爆出 = 爆出礼物价值合计（电池）
 *   - 盈亏 = 爆出 - 花费
 * 弹幕记录的花费/爆出价格即实际电池价，**不乘 50**；
 * 收入记录路径（computeFromIncome）的 hamster 是金仓鼠（主播收益）需折算电池：
 * 爆出 = Σhamster×2/100；花费 = 抽数×盲盒单价（电池），由金仓鼠口径
 * drawCount×blind_price×50 折算而来（×50×2/100 抵消）。
 * 所有金额单位均为电池。
 *
 * 数据来源按时间段优先级：
 *   - 今日：只用弹幕礼物记录（收入记录无当日）
 *   - 昨日：收入记录已有昨日（yesterdayAvailable）→ 用收入记录（最准）；否则回退弹幕记录
 *   - 本周 / 本月 / 历史：只用收入记录（本地已拉取缓存，最多近 3 年）
 */
import { getPlatform } from "@/lib/platform";
import type { Platform } from "@/lib/platform/types";
import {
  getEffectiveBlindBoxConfig,
  getAllBlindBoxInfo,
  type BlindBoxInfo,
  type EffectiveBlindBoxConfig,
} from "@/lib/stats-client";

import { getGiftImgAnimated } from "@/lib/gift-catalog-client";
import type { DisplayGiftItem } from "./types";

// ==================== 礼物逐条记录文件 ====================

export interface GiftLogEntry {
  /** 本地自然日 YYYY-MM-DD（该条正好属于哪天） */
  date: string;
  /** 事件 unix 秒时间戳（用于时间段过滤） */
  ts: number;
  uid: number;
  uname: string;
  /** 到账（爆出）礼物 id。对盲盒即爆出礼物 id（与 open-live 一致） */
  giftId: number;
  giftName: string;
  /** 单价，电池 */
  price: number;
  num: number;
  /** 礼物图标直链（来自送礼弹幕原始数据 img/gift_pic），避免展示时再查询礼物目录 */
  img?: string;
}

interface GiftDb {
  records: GiftLogEntry[];
}

/** 本地自然日 YYYY-MM-DD */
function localDayStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 昨天的本地自然日 YYYY-MM-DD */
function yesterdayDayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDayStr(d);
}

/** 允许保留的最早自然日 = 昨天（保留"今天 + 昨天"两天的逐条记录；历史查询都走收入记录，无需更长） */
function minKeepDayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDayStr(d);
}

const GIFT_DB_NAME = "display-gift-records.json";

async function loadGiftDb(platform: Platform, mid: number): Promise<GiftDb> {
  const dir = `${await platform.getDataDir()}/uid_${mid}`;
  const path = `${dir}/${GIFT_DB_NAME}`;
  try {
    const raw = JSON.parse(await platform.readFile(path)) as GiftDb;
    if (Array.isArray(raw?.records)) return raw;
  } catch {
    /* 文件不存在/损坏 → 新建 */
  }
  return { records: [] };
}

async function saveGiftDb(platform: Platform, mid: number, db: GiftDb): Promise<void> {
  const dir = `${await platform.getDataDir()}/uid_${mid}`;
  await platform.mkdir(dir);
  await platform.writeFile(`${dir}/${GIFT_DB_NAME}`, JSON.stringify(db, null, 2));
}

/** 串行写盘链，避免高频礼物并发写导致底层存储冲突 */
let writeChain: Promise<void> = Promise.resolve();

/**
 * 追加一条礼物记录并落盘；写入时顺手清掉超过"今天 + 昨天"的过期记录。
 * 供展示模块"礼物展示"与盲盒"今日/昨日"查询共用。
 */
export async function appendGiftRecord(mid: number, e: GiftLogEntry): Promise<void> {
  writeChain = writeChain.then(async () => {
    try {
      const platform = await getPlatform();
      const db = await loadGiftDb(platform, mid);
      db.records.push(e);
      const min = minKeepDayStr();
      // 仅保留最近两个自然天（今天 + 昨天）
      db.records = db.records.filter((r) => r.date >= min);
      await saveGiftDb(platform, mid, db);
    } catch {
      /* 记录失败不影响直播展示 */
    }
  });
  await writeChain;
}

/** 读取某自然日的礼物逐条记录（无 → 空数组）。注：只在 Tauri 环境有意义。 */
export async function loadGiftRecordsByDate(mid: number, date: string): Promise<GiftLogEntry[]> {
  const platform = await getPlatform();
  if (!platform.isNative) return [];
  try {
    const db = await loadGiftDb(platform, mid);
    return db.records.filter((r) => r.date === date);
  } catch {
    return [];
  }
}

/** 读取某时间段 [start, end) 内的礼物记录（供时间段查询；end 为空表示不设上界）。 */
export async function loadGiftRecordsByRange(
  mid: number,
  range: { start: Date; end: Date } | null,
): Promise<GiftLogEntry[]> {
  const platform = await getPlatform();
  if (!platform.isNative) return [];
  try {
    const db = await loadGiftDb(platform, mid);
    if (!range) return db.records;
    return db.records.filter((r) => r.ts >= range.start.getTime() / 1000 && r.ts < range.end.getTime() / 1000);
  } catch {
    return [];
  }
}

/**
 * 今日"达标礼物"清单（供"礼物展示"模块数据来源）：
 * 从礼物逐条记录聚合今日记录，仅保留单价 > threshold（0=全部）、且能配上图标者。
 * 每组按 giftId 汇总数量。空记录 → 空数组（画布清空）。
 */
export async function loadTodayQualifyingGifts(
  mid: number,
  threshold: number,
): Promise<DisplayGiftItem[]> {
  const today = localDayStr(new Date());
  const rows = await loadGiftRecordsByDate(mid, today);
  const map = new Map<number, { giftName: string; price: number; count: number; img: string }>();
  for (const r of rows) {
    const cur = map.get(r.giftId);
    // 图标：优先礼物列表的动态图（gif，无 gif 退 img_basic），目录查不到再回退弹幕直链图标
    const img = getGiftImgAnimated(r.giftId) || r.img || "";
    if (cur) {
      cur.count += r.num;
      if (!cur.img && img) cur.img = img;
    } else {
      map.set(r.giftId, { giftName: r.giftName, price: r.price, count: r.num, img });
    }
  }
  const out: DisplayGiftItem[] = [];
  for (const [giftId, v] of map.entries()) {
    if (v.count <= 0 || v.price <= threshold) continue;
    if (!v.img) continue;
    out.push({ giftId, giftName: v.giftName, price: v.price, count: v.count, img: v.img });
  }
  return out;
}

// ==================== 收入记录读取（anchor-gifts-records.json） ====================

/** B站礼物流水单条（与 anchor-gifts-client 中一致） */
interface IncomeGiftRecord {
  uid: number;
  uname: string;
  time: string;
  gift_id: number;
  name: string;
  num: number;
  hamster: number;
}

async function loadIncomeRecords(mid: number): Promise<IncomeGiftRecord[]> {
  const platform = await getPlatform();
  if (!platform.isNative) return [];
  try {
    const dir = `${await platform.getDataDir()}/uid_${mid}`;
    const raw = JSON.parse(await platform.readFile(`${dir}/anchor-gifts-records.json`));
    if (Array.isArray(raw)) return raw as IncomeGiftRecord[];
    if (Array.isArray(raw?.records)) return raw.records as IncomeGiftRecord[];
  } catch {
    /* 无收入记录 */
  }
  return [];
}

/** 收入记录里是否存在指定自然日的记录（判断该日数据是否已更新） */
export async function hasIncomeRecordOn(mid: number, date: string): Promise<boolean> {
  const records = await loadIncomeRecords(mid);
  return records.some((r) => r.time.startsWith(date));
}

// ==================== 盲盒盈亏计算 ====================

/** 盈亏结果（电池单位），与"盲盒"页面查询弹幕一致 */
export interface BlindBoxProfitResult {
  blindBoxId: number;
  /** 盲盒名称（如"心动盲盒"） */
  blindBoxName: string;
  /** 抽数 */
  drawCount: number;
  /** 爆出总价值（电池） */
  totalEarned: number;
  /** 花费（电池） */
  totalSpent: number;
  /** 盈亏（电池） */
  profit: number;
}

interface BoxCtx {
  config: EffectiveBlindBoxConfig;
  info: Record<number, BlindBoxInfo>;
  /** 爆出礼物 gift_id → 盲盒 id */
  giftIdToBoxId: Map<number, number>;
  /** 盲盒 id → 奖励礼物 gift_id 集合（成本 0，仅计价值） */
  rewardGiftIdsByBox: Map<number, Set<number>>;
}

/** 盲盒上下文短缓存（10 分钟）：查询弹幕每次触发都读取太频繁，活动盲盒/单价变化按此周期自动刷新 */
let boxCtxCache: { at: number; ctx: BoxCtx } | null = null;

/** 加载盲盒上下文：有效盲盒配置 + 所有盲盒信息 + 爆出礼物反向映射 */
async function loadBoxCtx(platform: Platform): Promise<BoxCtx> {
  if (boxCtxCache && Date.now() - boxCtxCache.at < 10 * 60 * 1000) {
    return boxCtxCache.ctx;
  }
  const config = await getEffectiveBlindBoxConfig(platform);
  const info = await getAllBlindBoxInfo(platform);
  const giftIdToBoxId = new Map<number, number>();
  for (const [boxIdStr, bi] of Object.entries(info)) {
    const boxId = Number(boxIdStr);
    if (bi?.gifts) {
      for (const g of bi.gifts) {
        if (g.gift_id) giftIdToBoxId.set(g.gift_id, boxId);
      }
    }
  }
  // 奖励礼物 id 集合（admin 配置，成本 0）
  const rewardGiftIdsByBox = new Map<number, Set<number>>();
  for (const [idStr, box] of Object.entries(config.boxes)) {
    if (box.rewardGiftIds.size > 0) rewardGiftIdsByBox.set(Number(idStr), box.rewardGiftIds);
  }
  boxCtxCache = { at: Date.now(), ctx: { config, info, giftIdToBoxId, rewardGiftIdsByBox } };
  return boxCtxCache.ctx;
}

/** 取 boxId 的盲盒名称（缺失回退 `盲盒_<id>`） */
function boxName(info: Record<number, BlindBoxInfo>, boxId: number): string {
  return info[boxId]?.blind_box_name || `盲盒_${boxId}`;
}

/** 按收入记录计算：给定时间段 + 用户 + 盲盒的盈亏（电池）。range=null 表示历史全量。
 *  与 anchor-gifts-client 的 blindBoxProfits 同源（hamster 为金仓鼠），但折算成电池：
 *    cost(电池)   = drawCount × blind_price × 50 × 2/100 = drawCount × blind_price
 *    earned(电池) = Σ hamster × 2/100；profit = earned - cost。 */
export async function computeFromIncome(
  mid: number,
  uid: number,
  boxId: number,
  range: { start: Date; end: Date } | null,
): Promise<BlindBoxProfitResult> {
  const platform = await getPlatform();
  const ctx = await loadBoxCtx(platform);
  const records = await loadIncomeRecords(mid);
  const blindPrice = ctx.config.boxes[boxId]?.blindPrice || ctx.info[boxId]?.blind_price || 0;
  const rewardGiftIds = ctx.rewardGiftIdsByBox.get(boxId);

  let drawCount = 0;
  let totalEarned = 0;
  for (const r of records) {
    if (uid > 0 && r.uid !== uid) continue;
    if (range) {
      const t = new Date(r.time).getTime();
      if (!t || t < range.start.getTime() || t >= range.end.getTime()) continue;
    }
    if (ctx.giftIdToBoxId.get(r.gift_id) !== boxId) continue;
    // 奖励礼物成本 0：只计价值，不计抽数/成本
    if (!rewardGiftIds?.has(r.gift_id)) drawCount += r.num;
    // 金仓鼠 → 电池：主播收益 ×2 = 礼物单价（金仓鼠），再 ÷100 转电池（与 GiftScreenshotPanel 一致）
    totalEarned += (r.hamster * 2) / 100;
  }
  // 电池：收入记录口径 drawCount×blind_price×50 得到的是金仓鼠，按 ×2/100 折算电池后
  // 恰好等于 drawCount × blind_price，与"盲盒"页面/弹幕路径的成本口径一致
  const cost = drawCount * blindPrice;
  return {
    blindBoxId: boxId,
    blindBoxName: boxName(ctx.info, boxId),
    drawCount,
    totalEarned,
    totalSpent: cost,
    profit: totalEarned - cost,
  };
}

/** 按弹幕礼物记录计算：给定时间段 + 用户 + 盲盒的盈亏（电池）。
 *  与"盲盒"页面（calculateProfit）口径一致：
 *   - 抽数 = 爆出礼物记录抽数合计
 *   - 花费 = 抽数 × 盲盒单价（盲盒 gift_id 的目录价格，电池）
 *   - 爆出 = Σ(爆出礼物单价 × 数量)；弹幕记录里已是实际电池价
 *  注意：弹幕记录本身就是花费价格，**不要**像收入记录那样再乘 50（见 computeFromIncome）。 */
export async function computeFromDanmu(
  mid: number,
  uid: number,
  boxId: number,
  range: { start: Date; end: Date } | null,
): Promise<BlindBoxProfitResult> {
  const platform = await getPlatform();
  const ctx = await loadBoxCtx(platform);
  const rows = await loadGiftRecordsByRange(mid, range);
  const blindPrice = ctx.config.boxes[boxId]?.blindPrice || ctx.info[boxId]?.blind_price || 0;
  const rewardGiftIds = ctx.rewardGiftIdsByBox.get(boxId);

  let drawCount = 0;
  let totalEarned = 0;
  for (const r of rows) {
    if (uid > 0 && r.uid !== uid) continue;
    if (ctx.giftIdToBoxId.get(r.giftId) !== boxId) continue;
    // 奖励礼物成本 0：只计价值，不计抽数/成本
    if (!rewardGiftIds?.has(r.giftId)) drawCount += r.num;
    totalEarned += r.price * r.num; // 爆出价值（电池）
  }
  const cost = drawCount * blindPrice; // 电池；弹幕已是实际花费，不乘 50
  return {
    blindBoxId: boxId,
    blindBoxName: boxName(ctx.info, boxId),
    drawCount,
    totalEarned,
    totalSpent: cost,
    profit: totalEarned - cost,
  };
}

// ==================== 查询弹幕识别与回复 ====================

export type BlindBoxPeriod = "today" | "yesterday" | "thisWeek" | "thisMonth" | "history";

const PERIOD_TEXT: Record<BlindBoxPeriod, string> = {
  today: "今日",
  yesterday: "昨日",
  thisWeek: "本周",
  thisMonth: "本月",
  history: "历史",
};

/**
 * 查询弹幕采用【完全匹配】：弹幕内容必须与某个"查询短语"一字不差。
 * - 时间段前缀：空 / 今日 / 昨日 / 本周 / 本月 / 历史
 * - 盲盒名：admin"盲盒盈亏配置"指定的每个盲盒真实名称（心动盲盒 / 幸运盲盒 / 活动盲盒等）
 * - 快捷语："盲盒"＝不带名称，查询全部可查询盲盒的总和统计
 * 例如："今日盲盒""今日心动盲盒""今日幸运盲盒""历史中秋盲盒"均有效；
 * 而"今日盲盒快来""盲盒多少钱"这类带额外文本的普通弹幕一律不触发。
 * 完全匹配同时天然避免了自动回复弹幕（内容带"[吃瓜]××盈亏"）被再次识别为查询 → 消除回复自己死循环。
 */
const PERIOD_PREFIXES: Array<{ label: string; period: BlindBoxPeriod }> = [
  { label: "", period: "today" },
  { label: "今日", period: "today" },
  { label: "昨日", period: "yesterday" },
  { label: "本周", period: "thisWeek" },
  { label: "本月", period: "thisMonth" },
  { label: "历史", period: "history" },
];

/** 精确匹配一条弹幕是否为合法查询短语；命中返回盲盒 id 列表 + 时间段，否则 null。
 *  boxIds 为空数组表示"全部盲盒"（查询所有可查询盲盒的总和统计）。 */
function matchQueryPhrase(
  ctx: BoxCtx,
  text: string,
): { boxIds: number[]; period: BlindBoxPeriod } | null {
  // 可查询盲盒范围 = admin 配置的指定盲盒（profitIds），每个盲盒可用其名称精确查询
  const profitIds = ctx.config.profitIds ?? [];
  // 盲盒名称关键词 → 该盲盒 id（顺序无关，最终按短语逐条精确比对）
  const boxWords: Array<[string, number[]]> = [];
  for (const id of profitIds) {
    const n = boxName(ctx.info, id);
    if (n) boxWords.push([n, [id]]);
  }
  // 快捷语"盲盒" → 全部可查询盲盒的总和统计（不再默认映射到心动盲盒）
  boxWords.push(["盲盒", []]);

  for (const [word, boxIds] of boxWords) {
    for (const { label, period } of PERIOD_PREFIXES) {
      if (label === "") {
        if (text === word) return { boxIds, period: "today" };
      } else if (text === label + word) {
        return { boxIds, period };
      }
    }
  }
  return null;
}

/** 回复弹幕最小发送间隔（毫秒），防止触发 B站"发送频率过快" */
// 盲盒查询回复最小发送间隔：B站 文档/社区实测直播弹幕最短间隔为 5s，留 1s 余量防抖动，避免自身超频。
const REPLY_COOLDOWN_MS = 6000;
let lastReplyAt = 0;

/** 时间段起始边界（北京时间/本地时区）；返回 null 表示历史全量 */
export function periodRange(period: BlindBoxPeriod): { start: Date; end: Date } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period) {
    case "today":
      return { start: today, end: new Date(today.getTime() + 86400000) };
    case "yesterday":
      return { start: new Date(today.getTime() - 86400000), end: today };
    case "thisWeek": {
      const dow = today.getDay();
      const mon = new Date(today);
      mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
      return { start: mon, end: new Date(mon.getTime() + 7 * 86400000) };
    }
    case "thisMonth":
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      };
    default:
      return null;
  }
}

/**
 * 合并多个同盲盒的盈亏结果（不同数据源相加）：抽数、爆出、花费累加，盈亏重算。
 * 用于"本周/本月/历史"把收入记录与弹幕礼物记录两者加起来。
 */
function mergeProfit(base: BlindBoxProfitResult, ...parts: BlindBoxProfitResult[]): BlindBoxProfitResult {
  let drawCount = base.drawCount;
  let totalEarned = base.totalEarned;
  let totalSpent = base.totalSpent;
  for (const p of parts) {
    drawCount += p.drawCount;
    totalEarned += p.totalEarned;
    totalSpent += p.totalSpent;
  }
  return {
    blindBoxId: base.blindBoxId,
    blindBoxName: base.blindBoxName,
    drawCount,
    totalEarned,
    totalSpent,
    profit: totalEarned - totalSpent,
  };
}

/** 跨多个盲盒聚合盈亏（抽数/爆出/花费累加，盈亏重算）。blindBoxName 暂置空，由调用方覆盖。
 *  用于"全部盲盒"总和统计查询——统计口径与单个盲盒（computeFromIncome/computeFromDanmu）一致，只是累加多个盲盒。 */
async function aggregateBoxes(
  mid: number,
  uid: number,
  boxIds: number[],
  range: { start: Date; end: Date } | null,
  source: "income" | "danmu",
): Promise<BlindBoxProfitResult> {
  let drawCount = 0;
  let totalEarned = 0;
  let totalSpent = 0;
  for (const boxId of boxIds) {
    const p =
      source === "income"
        ? await computeFromIncome(mid, uid, boxId, range)
        : await computeFromDanmu(mid, uid, boxId, range);
    drawCount += p.drawCount;
    totalEarned += p.totalEarned;
    totalSpent += p.totalSpent;
  }
  return {
    blindBoxId: boxIds.length === 1 ? boxIds[0] : 0,
    blindBoxName: "",
    drawCount,
    totalEarned,
    totalSpent,
    profit: totalEarned - totalSpent,
  };
}

/**
 * 判断一条弹幕是否为盲盒盈亏查询弹幕，若是则计算并发送回复弹幕。
 * 返回发送的弹幕文本；非查询弹幕返回 null。
 * 参数 uid 为 0 时表示不按用户过滤（返回"全部粉丝"的盲盒数据）。
 */
export async function tryHandleBlindBoxQuery(
  mid: number,
  uid: number,
  content: string,
  roomId: number,
): Promise<string | null> {
  const text = (content ?? "").trim();
  if (!text) return null;

  // 1) 完全匹配识别查询短语（必须一字不差；含额外文本的一律不触发）
  const platform = await getPlatform();
  const ctx = await loadBoxCtx(platform);
  const matched = matchQueryPhrase(ctx, text);
  if (!matched) return null;
  const { boxIds, period } = matched;
  // 指定盲盒：若命中的是"全部盲盒"（boxIds 为空）则聚合所有可查询盲盒（profitIds）
  const queryBoxIds = boxIds.length > 0 ? boxIds : ctx.config.profitIds;
  const resultName = boxIds.length > 0 ? boxName(ctx.info, boxIds[0]) : "全部盲盒";

  // 2) 选数据源（与单个盲盒查询一致，只是可跨多个盲盒聚合）
  let result: BlindBoxProfitResult;
  if (period === "today") {
    const a = await aggregateBoxes(mid, uid, queryBoxIds, periodRange(period), "danmu");
    result = { ...a, blindBoxName: resultName };
  } else if (period === "yesterday") {
    const yesterday = periodRange(period)!;
    const yesterdayDate = localDayStr(new Date(yesterday.start));
    const incomeReady = await hasIncomeRecordOn(mid, yesterdayDate);
    const a = incomeReady
      ? await aggregateBoxes(mid, uid, queryBoxIds, yesterday, "income")
      : await aggregateBoxes(mid, uid, queryBoxIds, yesterday, "danmu");
    result = { ...a, blindBoxName: resultName };
  } else {
    // 本周/本月/历史：收入记录 + 弹幕礼物记录，两者相加。
    // 收入记录通常已覆盖至昨天（唯一的系统性缺口是"今天"），故默认只补"今日"弹幕数据；
    // 若收入记录尚未含昨日（缺口延伸到昨天），则再补"昨日"弹幕数据，避免遗漏。
    const income = await aggregateBoxes(mid, uid, queryBoxIds, periodRange(period), "income");
    const todayDanmu = await aggregateBoxes(mid, uid, queryBoxIds, periodRange("today"), "danmu");
    if (await hasIncomeRecordOn(mid, yesterdayDayStr())) {
      result = mergeProfit({ ...income, blindBoxName: resultName }, todayDanmu);
    } else {
      const yesterdayDanmu = await aggregateBoxes(mid, uid, queryBoxIds, periodRange("yesterday"), "danmu");
      result = mergeProfit({ ...income, blindBoxName: resultName }, todayDanmu, yesterdayDanmu);
    }
  }

  // 4) 组装回复弹幕（形式与"盲盒"页面查询弹幕一致）
  const round = (n: number) => Math.round(n);
  const reply =
    `[吃瓜]${PERIOD_TEXT[period]}${result.blindBoxName}：${result.drawCount}个 ` +
    `${round(result.totalEarned)}-${round(result.totalSpent)} = ${round(result.profit)}电池`;

  // 发送频率保护：避免短时间内连续回复触发 B站"发送弹幕的频率过快"
  const now = Date.now();
  if (now - lastReplyAt < REPLY_COOLDOWN_MS) return null;
  lastReplyAt = now;

  // 发送弹幕：遇"发送频率过快/风控"（多为主播在别处刚发过弹幕占用 B站 冷却窗口）时自动逐级等待重试
  const { sendDanmakuWithRetry } = await import("@/lib/barrage");
  const res = await sendDanmakuWithRetry(roomId, reply);
  if (res.code !== 0) {
    console.warn("[展示]盲盒查询回复弹幕发送失败", res.message || res.msg || res.code);
  }
  return reply;
}