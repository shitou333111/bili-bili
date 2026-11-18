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

async function sendReport(view: LeaderboardView, uid: number, name: string, face: string | undefined, cards: LeaderboardReportCard[]) {
  if (!uid || cards.length === 0) return;
  const key = `${view}:${uid}`;
  const now = Date.now();
  if (now - (lastSentAt.get(key) ?? 0) < REPORT_INTERVAL_MS) return;

  const report: LeaderboardReport = { view, uid, name, face, cards };
  try {
    const res = await serverPost<{ code?: number }>("/api/leaderboard/report", report);
    if (res?.code === 0) lastSentAt.set(key, now);
  } catch {
    // 静默失败
  }
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

export async function reportUserLeaderboard(args: {
  uid: number;
  name: string;
  face?: string;
  blindBoxes: LeaderboardBlindBoxSource[];
  /** 合成统计失败时允许为空：盲盒数据仍应正常上报 */
  synthesis?: LeaderboardSynthesisSource | null;
}): Promise<void> {
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

  await sendReport("user", args.uid, args.name, args.face, cards);
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

/** 主播页口径：收益/成本均为 hamster，展示时 /100 转电池 */
function metricFromAnchorBox(box: LeaderboardAnchorBoxSource, topGift?: LeaderboardTopGift): LeaderboardMetric {
  return normalizeMetric({
    spent: box.cost / 100,
    earned: box.totalHamster / 100,
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

async function fetchAnchorBoxes(range: "today" | "lastFriday"): Promise<LeaderboardAnchorBoxSource[]> {
  try {
    const res = await dataFetch(`/api/anchor/gifts?fast=1&dateRange=${range}`);
    const json = (await res.json()) as { code?: number; data?: { blindBoxProfits?: LeaderboardAnchorBoxSource[] } };
    if (json?.code !== 0) return [];
    return json.data?.blindBoxProfits ?? [];
  } catch {
    return [];
  }
}

const anchorInFlight = new Set<number>();

export async function reportAnchorLeaderboard(args: {
  uid: number;
  name: string;
  face?: string;
  all: LeaderboardAnchorBoxSource[];
}): Promise<void> {
  if (!args.uid || !Array.isArray(args.all) || args.all.length === 0) return;
  if (anchorInFlight.has(args.uid)) return;
  if (Date.now() - (lastSentAt.get(`anchor:${args.uid}`) ?? 0) < REPORT_INTERVAL_MS) return;

  anchorInFlight.add(args.uid);
  try {
    // 只有心动 / 幸运盲盒需要「今天 / 上周五」数据，活动盲盒不拉取
    const needDaily = args.all.some((box) => isPermanentBlindBox(box.gift_id));
    let todayMap = new Map<number, LeaderboardAnchorBoxSource>();
    let fridayMap = new Map<number, LeaderboardAnchorBoxSource>();
    if (needDaily) {
      const [todayBoxes, fridayBoxes] = await Promise.all([
        fetchAnchorBoxes("today"),
        fetchAnchorBoxes("lastFriday"),
      ]);
      todayMap = new Map(todayBoxes.map((b) => [b.gift_id, b]));
      fridayMap = new Map(fridayBoxes.map((b) => [b.gift_id, b]));
    }

    const cards: LeaderboardReportCard[] = [];
    const topGifts = await loadTopGiftMap();
    for (const box of args.all) {
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

    await sendReport("anchor", args.uid, args.name, args.face, cards);
  } finally {
    anchorInFlight.delete(args.uid);
  }
}
