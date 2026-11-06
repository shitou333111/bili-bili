import { NextRequest, NextResponse } from "next/server";
import { buildLeaderboards, type FeePeriod } from "@/lib/medical-fee-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical-fee/leaderboard?period=all|month|week&uid=<uid>&limit=20
 * 一次返回雷锋榜 / 爽吃榜 / 净利榜三个榜单 + 我的排名。
 */
export async function GET(request: NextRequest) {
  const rawPeriod = request.nextUrl.searchParams.get("period") ?? "all";
  const period: FeePeriod = rawPeriod === "month" || rawPeriod === "week" ? rawPeriod : "all";
  const uid = Number((request.nextUrl.searchParams.get("uid") ?? "").replace(/[^\d]/g, "")) || 0;
  const limit = Math.min(50, Math.max(5, Number(request.nextUrl.searchParams.get("limit")) || 20));
  const data = await buildLeaderboards(period, uid, limit);
  return NextResponse.json({ code: 0, data: { period, ...data } });
}
