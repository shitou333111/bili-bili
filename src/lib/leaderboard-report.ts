/**
 * 黑白榜上报（客户端）
 *
 * 用户侧：粉丝页「盲盒 / 合成」全量统计刷新完成后，把当前账号的紧凑绝对值快照上报；
 * 主播侧：主播页刷新完成后上报盲盒盈亏（活动期），并额外拉取「今天 / 上周五」的快速统计。
 *
 * 上报失败完全静默——它只是娱乐统计，不能影响主流程。
 */

import { computeBlindBoxFromRecords, type BlindBoxCalcRecord, type BlindBoxCalcResult, type BlindBoxGiftMeta, type BlindBoxRewardBagGift } from "./blind-box-calc";
import { BLIND_BOX_CONFIG } from "./config";
import { beijingDateKey, lastPastFridayKey } from "./leaderboard-time";
import { serverPost, serverFetch } from "./server-api";
import { dataFetch } from "./client-fetch";
import {
  ALL_BLIND_CARD,
  blindCardKey,
  normalizeMetric,
  pickMaxGift,
  synCardKey,
  SYN_YEAR_CARD,
  type LeaderboardMaxGift,
  type LeaderboardMeta,
  type LeaderboardMetric,
  type LeaderboardPeriodKey,
  type LeaderboardReport,
  type LeaderboardReportCard,
  type LeaderboardTopGift,
  type LeaderboardView,
} from "./leaderboard-types";

/** 同一用户两次上报的最小间隔 */
const REPORT_INTERVAL_MS = 15_000;
const lastSentAt = new Map<string, number>();

/** 卡片 → 最大礼物缓存（来自 /api/leaderboard/meta，避免每次上报都拉取） */
let topGiftCache: { at: number; map: Record<string, LeaderboardTopGift> } | null = null;
const TOP_GIFT_TTL_MS = 5 * 60_000;

async function loadTopGiftMap(): Promise<Record<string, LeaderboardTopGift>> {
  if (topGiftCache && Date.now() - topGiftCache.at < TOP_GIFT_TTL_MS) return topGiftCache.map;
  try {
    const res = await serverFetch<{ code?: number; data?: LeaderboardMeta }>("/api/leaderboard/meta");
    if (res?.code === 0 && res.data) {
      const map: Record<string, LeaderboardTopGift> = {};
      for (const tab of res.data.tabs) {
        for (const card of tab.cards) {
          if (card.topGift) map[card.key] = card.topGift;
        }
      }
      topGiftCache = { at: Date.now(), map };
      return map;
    }
  } catch {
    // 静默：拿不到就回退到用户自己开出的最大礼物
  }
  return topGiftCache?.map ?? {};
}

/** 统计某个礼物（卡片最大礼物）在本次口径下的获得数量；未获得则为 0 */
function countGift(
  topGift: LeaderboardTopGift | undefined,
  obtained: Array<{ id: number; name?: string; count: number }>,
): LeaderboardMaxGift | null {
  if (!topGift) return null;
  let count = 0;
  for (const g of obtained) {
    // gift_id 可能因目录更新发生变化，名称命中同样计入
    if (g.id === topGift.id || (topGift.name && g.name === topGift.name)) count += g.count;
  }
  return { id: topGift.id, name: topGift.name, img: topGift.img, price: topGift.price, count };
}

/** 只有心动 / 幸运这类长期存在的盲盒才统计「今天 / 上周五」 */
const PERMANENT_BLIND_BOX_IDS = new Set<number>([BLIND_BOX_CONFIG.xindong, BLIND_BOX_CONFIG.lucky]);

function isPermanentBlindBox(id: number): boolean {
  return PERMANENT_BLIND_BOX_IDS.has(id);
}

async function sendReport(
  view: LeaderboardView,
  uid: number,
  name: string,
  face: string | undefined,
  cards: LeaderboardReportCard[],
  force = false,
): Promise<boolean> {
  if (!uid || cards.length === 0) return false;
  const key = `${view}:${uid}`;
  const now = Date.now();
  // 自动上报按最小间隔节流；手动 / 打开榜单触发的上传强制发送（服务端仍有 5s 防抖兜底）
  if (!force && now - (lastSentAt.get(key) ?? 0) < REPORT_INTERVAL_MS) return false;

  const report: LeaderboardReport = { view, uid, name, face, cards };
  try {
    const res = await serverPost<{ code?: number }>("/api/leaderboard/report", report);
    if (res?.code === 0) {
      lastSentAt.set(key, now);
      return true;
    }
  } catch {
    // 静默失败
  }
  return false;
}

// ==================== 用户侧 ====================

export type LeaderboardBlindBoxSource = {
  blindBoxId: number;
  blindBoxName: string;
  blindBoxImg: string;
  blindPrice: number;
  records?: BlindBoxCalcRecord[];
  anchorNames?: Record<number, string>;
  giftMeta?: Record<number, BlindBoxGiftMeta>;
  rewardGifts?: BlindBoxRewardBagGift[];
  gifts: Array<{ gift_id: number; gift_name: string; gift_img: string; unitPrice: number; count: number }>;
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
};

export type LeaderboardSynthesisProfitSource = {
  totalSpent: number;
  totalEarned: number;
  profit: number;
  synthesisCount: number;
  giftList?: Array<{ gift_id?: number; gift_name?: string; gift_img?: string; gift_price?: number; count?: number }>;
};

export type LeaderboardSynthesisSource = {
  activities: Array<{ id: string; name?: string; profit: LeaderboardSynthesisProfitSource }>;
  historical: LeaderboardSynthesisProfitSource;
};

function metricFromBlindBoxResult(result: BlindBoxCalcResult, topGift?: LeaderboardTopGift): LeaderboardMetric {
  const obtained = result.gifts.map((g) => ({ id: g.gift_id, name: g.gift_name, count: g.count }));
  return normalizeMetric({
    spent: result.totalSpent,
    earned: result.totalEarned,
    maxGift:
      countGift(topGift, obtained) ??
      pickMaxGift(
        result.gifts.map((g) => ({
          id: g.gift_id,
          name: g.gift_name,
          img: g.gift_img,
          price: g.unitPrice,
          count: g.count,
        })),
      ),
  });
}

function blindBoxCards(box: LeaderboardBlindBoxSource, topGift?: LeaderboardTopGift): LeaderboardReportCard {
  const periods: Partial<Record<LeaderboardPeriodKey, LeaderboardMetric>> = {};

  if (box.records && box.giftMeta) {
    const base = {
      blindBoxId: box.blindBoxId,
      blindBoxName: box.blindBoxName,
      blindBoxImg: box.blindBoxImg,
      blindPrice: box.blindPrice,
      records: box.records,
      anchorNames: box.anchorNames,
      giftMeta: box.giftMeta,
      rewardGifts: box.rewardGifts,
    };
    periods.activity = metricFromBlindBoxResult(
      computeBlindBoxFromRecords({ ...base, filter: { ruid: null, dateRange: "all" } }),
      topGift,
    );
    // 活动盲盒没有「今天 / 上周五」榜单，不必计算与上报
    if (isPermanentBlindBox(box.blindBoxId)) {
      periods.today = metricFromBlindBoxResult(
        computeBlindBoxFromRecords({ ...base, filter: { dateKey: beijingDateKey() } }),
        topGift,
      );
      periods.lastFriday = metricFromBlindBoxResult(
        computeBlindBoxFromRecords({ ...base, filter: { dateKey: lastPastFridayKey() } }),
        topGift,
      );
    }
  } else {
    // 没有原始记录时至少上报活动期（兼容旧缓存载荷）
    periods.activity = normalizeMetric({
      spent: box.totalSpent,
      earned: box.totalEarned,
      maxGift:
        countGift(topGift, box.gifts.map((g) => ({ id: g.gift_id, name: g.gift_name, count: g.count }))) ??
        pickMaxGift(
          box.gifts.map((g) => ({
            id: g.gift_id,
            name: g.gift_name,
            img: g.gift_img,
            price: g.unitPrice,
            count: g.count,
          })),
        ),
    });
  }

  return { card: blindCardKey(box.blindBoxId), periods };
}

function metricFromSynthesis(p: LeaderboardSynthesisProfitSource, topGift?: LeaderboardTopGift): LeaderboardMetric {
  const giftList = Array.isArray(p.giftList) ? p.giftList : [];
  return normalizeMetric({
    spent: p.totalSpent,
    earned: p.totalEarned,
    maxGift:
      countGift(
        topGift,
        giftList.map((g) => ({ id: Number(g.gift_id) || 0, name: String(g.gift_name ?? ""), count: Number(g.count) || 0 })),
      ) ??
      pickMaxGift(
        giftList.map((g) => ({
          id: Number(g.gift_id) || 0,
          name: String(g.gift_name ?? ""),
          img: String(g.gift_img ?? ""),
          price: Number(g.gift_price) || 0,
          count: Number(g.count) || 0,
        })),
      ),
  });
}

export type UserLeaderboardSource = {
  uid: number;
  name: string;
  face?: string;
  blindBoxes: LeaderboardBlindBoxSource[];
  /** 合成统计失败时允许为空：盲盒数据仍应正常上报 */
  synthesis?: LeaderboardSynthesisSource | null;
};

/** 最近一次成功统计得到的用户上报源：手动上传 / 打开榜单前上传时直接复用，无需重新拉取 */
let lastUserSource: UserLeaderboardSource | null = null;

async function buildUserCards(args: UserLeaderboardSource): Promise<LeaderboardReportCard[]> {
  const cards: LeaderboardReportCard[] = [];
  const topGifts = await loadTopGiftMap();
  const boxes = Array.isArray(args.blindBoxes) ? args.blindBoxes : [];
  for (const box of boxes) {
    if (!box || !box.blindBoxId) continue;
    cards.push(blindBoxCards(box, topGifts[blindCardKey(box.blindBoxId)]));
  }
  const activities = Array.isArray(args.synthesis?.activities) ? args.synthesis.activities : [];
  for (const activity of activities) {
    if (!activity?.id || !activity.profit) continue;
    cards.push({
      card: synCardKey(activity.id),
      periods: { activity: metricFromSynthesis(activity.profit, topGifts[synCardKey(activity.id)]) },
    });
  }
  if (args.synthesis?.historical) {
    // 一年内总合成包含多个活动，无法确定一个最大礼物，不上报礼物
    cards.push({
      card: SYN_YEAR_CARD,
      periods: {
        year: { ...metricFromSynthesis(args.synthesis.historical), maxGift: null },
      },
    });
  }
  return cards;
}

export async function reportUserLeaderboard(args: UserLeaderboardSource): Promise<void> {
  // 先缓存源数据：即使本次因节流未真正发送，手动上传也能拿到最新统计
  lastUserSource = args;
  const cards = await buildUserCards(args);
  await sendReport("user", args.uid, args.name, args.face, cards);
}

/**
 * 手动上传 / 打开黑白榜前上传当前账号数据。
 * 使用最近一次统计缓存，强制发送（跳过客户端节流）。
 */
export async function uploadUserLeaderboardNow(): Promise<{ ok: boolean; at: number }> {
  const args = lastUserSource;
  if (!args || !args.uid) return { ok: false, at: 0 };
  const cards = await buildUserCards(args);
  const ok = await sendReport("user", args.uid, args.name, args.face, cards, true);
  return { ok, at: ok ? Date.now() : 0 };
}

// ==================== 主播侧 ====================

export type LeaderboardAnchorBoxSource = {
  gift_id: number;
  name: string;
  drawCount: number;
  totalHamster: number;
  cost: number;
  profit: number;
  gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string; price?: number }>;
};

/** 主播侧口径：收益/成本仍为金仓鼠，展示时 /50 转「盲盒爆出礼物价值」的电池（不折半） */
function metricFromAnchorBox(box: LeaderboardAnchorBoxSource, topGift?: LeaderboardTopGift): LeaderboardMetric {
  return normalizeMetric({
    spent: box.cost / 50,
    earned: box.totalHamster / 50,
    maxGift:
      countGift(
        topGift,
        (box.gifts ?? []).map((g) => ({ id: g.gift_id, name: g.name, count: g.num })),
      ) ??
      pickMaxGift(
        (box.gifts ?? []).map((g) => ({
          id: g.gift_id,
          name: g.name,
          img: g.img,
          price: g.price ?? 0,
          count: g.num,
        })),
      ),
  });
}

type AnchorBoxesPayload = {
  /** admin「卡片」勾选的盲盒（单独成卡） */
  cards: LeaderboardAnchorBoxSource[];
  /** admin「盈亏」勾选的盲盒（"全部盲盒"聚合统计用） */
  stats: LeaderboardAnchorBoxSource[];
};

async function fetchAnchorBoxes(
  range: "today" | "lastFriday" | "all",
  mid: number,
): Promise<AnchorBoxesPayload> {
  try {
    // mid 显式绑定目标账号：多账号切换时不会读到当前账号的数据
    const res = await dataFetch(`/api/anchor/gifts?fast=1&dateRange=${range}&mid=${mid}`);
    const json = (await res.json()) as {
      code?: number;
      data?: { blindBoxProfits?: LeaderboardAnchorBoxSource[]; blindBoxProfitStats?: LeaderboardAnchorBoxSource[] };
    };
    if (json?.code !== 0) return { cards: [], stats: [] };
    return {
      cards: json.data?.blindBoxProfits ?? [],
      stats: json.data?.blindBoxProfitStats ?? [],
    };
  } catch {
    return { cards: [], stats: [] };
  }
}

/** 「全部盲盒」聚合：花费/收益/抽数累加，盈亏重算（单位：电池，不折半） */
function aggregateAnchorBoxes(boxes: LeaderboardAnchorBoxSource[]): LeaderboardMetric {
  let spent = 0;
  let earned = 0;
  let drawCount = 0;
  for (const box of boxes) {
    spent += box.cost / 50;
    earned += box.totalHamster / 50;
    drawCount += box.drawCount;
  }
  return normalizeMetric({ spent, earned, drawCount, maxGift: null });
}

const anchorInFlight = new Set<number>();

/**
 * 主播盲盒榜上传（仅电脑端调用）：
 * 读取目标账号本地整合后的盲盒盈亏（官方流水 + 弹幕礼物）后上报。
 * 所有请求都用 mid 绑定账号，避免多账号切换时串号。
 *
 * @param opts.auto  随刷新自动上报：跳过 force，沿用客户端最小上报间隔节流
 * @param opts.preloaded 已有本次刷新拿到的活动期数据时直接复用，避免重复读取
 */
export async function uploadAnchorLeaderboardNow(
  args: {
    uid: number;
    name: string;
    face?: string;
    preloaded?: AnchorBoxesPayload;
  },
  opts: { auto?: boolean } = {},
): Promise<{ ok: boolean; at: number }> {
  if (!args.uid) return { ok: false, at: 0 };
  if (anchorInFlight.has(args.uid)) return { ok: false, at: 0 };

  anchorInFlight.add(args.uid);
  try {
    // 活动期 / 累计：同时拿到「卡片」与「盈亏」勾选的盲盒
    const allRes = args.preloaded ?? (await fetchAnchorBoxes("all", args.uid));
    if (allRes.cards.length === 0 && allRes.stats.length === 0) return { ok: false, at: 0 };

    // 只有心动 / 幸运盲盒需要「今天 / 上周五」数据，活动盲盒不拉取
    const needDaily = allRes.cards.some((box) => isPermanentBlindBox(box.gift_id));
    let todayMap = new Map<number, LeaderboardAnchorBoxSource>();
    let fridayMap = new Map<number, LeaderboardAnchorBoxSource>();
    if (needDaily) {
      const [todayRes, fridayRes] = await Promise.all([
        fetchAnchorBoxes("today", args.uid),
        fetchAnchorBoxes("lastFriday", args.uid),
      ]);
      todayMap = new Map(todayRes.cards.map((b) => [b.gift_id, b]));
      fridayMap = new Map(fridayRes.cards.map((b) => [b.gift_id, b]));
    }

    const cards: LeaderboardReportCard[] = [];
    const topGifts = await loadTopGiftMap();
    for (const box of allRes.cards) {
      const topGift = topGifts[blindCardKey(box.gift_id)];
      const periods: Partial<Record<LeaderboardPeriodKey, LeaderboardMetric>> = {
        activity: metricFromAnchorBox(box, topGift),
      };
      if (isPermanentBlindBox(box.gift_id)) {
        const today = todayMap.get(box.gift_id);
        const friday = fridayMap.get(box.gift_id);
        if (today) periods.today = metricFromAnchorBox(today, topGift);
        if (friday) periods.lastFriday = metricFromAnchorBox(friday, topGift);
      }
      cards.push({ card: blindCardKey(box.gift_id), periods });
    }

    // 「全部盲盒」聚合卡（仅主播盲盒榜展示）
    if (allRes.stats.length > 0) {
      cards.push({
        card: ALL_BLIND_CARD,
        periods: { activity: aggregateAnchorBoxes(allRes.stats) },
      });
    }

    const ok = await sendReport("anchor", args.uid, args.name, args.face, cards, !opts.auto);
    return { ok, at: ok ? Date.now() : 0 };
  } finally {
    anchorInFlight.delete(args.uid);
  }
}
