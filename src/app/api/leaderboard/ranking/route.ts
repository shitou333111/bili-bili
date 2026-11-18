import { NextResponse } from "next/server";
import { buildLeaderboardMeta, findCardMeta, resolveView } from "@/lib/leaderboard-meta";
import { readLeaderboardBoard } from "@/lib/leaderboard-store";
import { beijingDateKey, lastPastFridayKey } from "@/lib/leaderboard-time";
import {
  emptyMetric,
  isPeriodKey,
  MAX_RANK_ROWS,
  sumMetrics,
  type LeaderboardMetric,
  type LeaderboardPeriodKey,
  type LeaderboardRanking,
  type LeaderboardRow,
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cardKey = url.searchParams.get("card") ?? "";
  const periodParam = url.searchParams.get("period") ?? "";
  const viewParam = url.searchParams.get("view") ?? "";

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

  rows.sort((a, b) => {
    if (b.metric.profit !== a.metric.profit) return b.metric.profit - a.metric.profit;
    if (b.metric.earned !== a.metric.earned) return b.metric.earned - a.metric.earned;
    return a.uid - b.uid;
  });

  const top: LeaderboardRow[] = rows
    .slice(0, MAX_RANK_ROWS)
    .map((r, i) => ({ rank: i + 1, uid: r.uid, name: r.name, face: r.face, metric: r.metric }));

  const remaining = rows.slice(MAX_RANK_ROWS);
  const bottom: LeaderboardRow[] = remaining
    .sort((a, b) => {
      if (a.metric.profit !== b.metric.profit) return a.metric.profit - b.metric.profit;
      return a.uid - b.uid;
    })
    .slice(0, MAX_RANK_ROWS)
    .map((r, i) => ({ rank: -(i + 1), uid: r.uid, name: r.name, face: r.face, metric: r.metric }));

  const data: LeaderboardRanking = {
    card: card.key,
    period,
    view,
    summary: { ...summaryBase, users: rows.length },
    top,
    bottom,
    total: rows.length,
    updatedAt: board.updatedAt,
  };

  return NextResponse.json({ code: 0, data });
}
