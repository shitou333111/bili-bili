import { NextResponse } from "next/server";
import { buildLeaderboardMeta } from "@/lib/leaderboard-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await buildLeaderboardMeta();
    return NextResponse.json({ code: 0, data });
  } catch (err) {
    console.error("[LeaderboardMeta] 构建失败:", err);
    return NextResponse.json({ code: -1, message: "获取榜单配置失败" }, { status: 500 });
  }
}
