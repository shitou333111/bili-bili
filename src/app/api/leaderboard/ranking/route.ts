import { NextResponse } from "next/server";
import { buildLeaderboardMeta, findCardMeta, resolveView } from "@/lib/leaderboard-meta";
import { readLeaderboardBoard } from "@/lib/leaderboard-store";
import { beijingDateKey, lastPastFridayKey } from "@/lib/leaderboard-time";
import {
  emptyMetric,
  isPeriodKey,
  MAX_RANK_LIMIT,
  MAX_RANK_ROWS,
  sumMetrics,
  type LeaderboardMetric,
  type LeaderboardPeriodKey,
  type LeaderboardRanking,
  type LeaderboardRow,
  type LeaderboardSort,
} from "@/lib/leaderboard-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

function stripMetric(p: LeaderboardMetric): LeaderboardMetric {
  return {
    drawCount: p.drawCount,
    spent: p.spent,
    earned: p.earned,
    profit: p.profit,
    maxGift: p.maxGift,
  };
}

function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MAX_RANK_ROWS;
  return Math.min(MAX_RANK_LIMIT, Math.max(1, Math.round(n)));
}

/** 相对榜口径：收入 ÷ 花费（花费为 0 的记录不参与排名） */
function ratioOf(m: LeaderboardMetric): number {
  return m.spent > 0 ? m.earned / m.spent : 0;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cardKey = url.searchParams.get("card") ?? "";
  const periodParam = url.searchParams.get("period") ?? "";
  const viewParam = url.searchParams.get("view") ?? "";
  const sort: LeaderboardSort = url.searchParams.get("sort") === "relative" ? "relative" : "absolute";
  // 「豪」榜：不按盈亏，按花费金额倒序
  const bySpend = url.searchParams.get("side") === "luxury";
  const limit = parseLimit(url.searchParams.get("limit"));

  const meta = await buildLeaderboardMeta();
  const card = findCardMeta(meta, cardKey);
  if (!card) {
    return NextResponse.json({ code: -1, message: "卡片不存在" }, { status: 404 });
  }

  const period: LeaderboardPeriodKey = card.periods.some((p) => p.key === periodParam)
    ? (periodParam as LeaderboardPeriodKey)
    : card.defaultPeriod;
  if (!isPeriodKey(period)) {
    return NextResponse.json({ code: -1, message: "周期非法" }, { status: 400 });
  }
  const view = resolveView(card, viewParam);

  const board = await readLeaderboardBoard(view, card.key);
  const now = Date.now();
  const todayKey = beijingDateKey(now);
  const fridayKey = lastPastFridayKey(now);

  const rows: Array<{ uid: number; name: string; face?: string; metric: LeaderboardMetric }> = [];
  for (const entry of Object.values(board.entries)) {
    const stored = entry.periods?.[period];
    if (!stored) continue;
    if (period === "today") {
      if (stored.dayKey !== todayKey) continue;
      if (entry.updatedAt < now - DAY_MS) continue;
    } else if (period === "lastFriday") {
      if (stored.dayKey !== fridayKey) continue;
    }
    rows.push({
      uid: entry.uid,
      name: entry.name,
      face: entry.face,
      metric: stripMetric(stored),
    });
  }

  const summaryBase = rows.length > 0 ? sumMetrics(rows.map((r) => r.metric)) : emptyMetric();

  // 相对榜下花费为 0 的记录没有比值，不参与排名；「豪」榜按花费排序，保留全部记录
  const ranked = !bySpend && sort === "relative" ? rows.filter((r) => r.metric.spent > 0) : rows;

  const betterFirst = (a: (typeof rows)[number], b: (typeof rows)[number]): number => {
    if (bySpend) {
      if (b.metric.spent !== a.metric.spent) return b.metric.spent - a.metric.spent;
      if (b.metric.earned !== a.metric.earned) return b.metric.earned - a.metric.earned;
      return a.uid - b.uid;
    }
    if (sort === "relative") {
      const d = ratioOf(b.metric) - ratioOf(a.metric);
      if (d !== 0) return d;
    } else if (b.metric.profit !== a.metric.profit) {
      return b.metric.profit - a.metric.profit;
    }
    if (b.metric.earned !== a.metric.earned) return b.metric.earned - a.metric.earned;
    return a.uid - b.uid;
  };

  const worseFirst = (a: (typeof rows)[number], b: (typeof rows)[number]): number => {
    if (sort === "relative") {
      const d = ratioOf(a.metric) - ratioOf(b.metric);
      if (d !== 0) return d;
    } else if (a.metric.profit !== b.metric.profit) {
      return a.metric.profit - b.metric.profit;
    }
    return a.uid - b.uid;
  };

  const top: LeaderboardRow[] = [...ranked]
    .sort(betterFirst)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, uid: r.uid, name: r.name, face: r.face, metric: r.metric }));

  const bottom: LeaderboardRow[] = [...ranked]
    .sort(worseFirst)
    .slice(0, limit)
    .map((r, i) => ({ rank: -(i + 1), uid: r.uid, name: r.name, face: r.face, metric: r.metric }));

  const data: LeaderboardRanking = {
    card: card.key,
    period,
    view,
    sort,
    summary: { ...summaryBase, users: rows.length },
    top,
    bottom,
    total: ranked.length,
    updatedAt: board.updatedAt,
  };

  return NextResponse.json({ code: 0, data });
}
