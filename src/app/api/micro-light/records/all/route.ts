import { NextRequest, NextResponse } from "next/server";
import { readDraws } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * GET /api/micro-light/records/all?month=YYYY-MM&winnersOnly=1
 * 公开的全部主播抽奖记录（不含 admin 备注）；默认按抽奖时间倒序取最近 200 条。
 */
export async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get("month") ?? "";
  const winnersOnly = request.nextUrl.searchParams.get("winnersOnly") === "1";
  const draws = await readDraws();
  const list = draws
    .filter((d) => (month ? d.month === month : true))
    .filter((d) => (winnersOnly ? d.prizeKind !== "none" && d.status !== "miss" : true))
    .filter((d) => d.status !== "void")
    .sort((a, b) => new Date(b.drawnAt).getTime() - new Date(a.drawnAt).getTime())
    .slice(0, 200)
    .map((d) => ({
      id: d.id,
      uid: d.uid,
      uname: d.uname,
      face: d.face ?? "",
      month: d.month,
      pkId: d.pkId,
      prizeKind: d.prizeKind,
      prizeName: d.prizeName,
      prizeText: d.prizeText,
      prizeImg: d.prizeImg ?? "",
      votes: d.votes,
      rank: d.rank,
      participants: d.participants,
      secondVotes: d.secondVotes,
      playedFull: d.playedFull,
      drawnAt: d.drawnAt,
      status: d.status,
    }));

  return NextResponse.json({ code: 0, data: { list, month } });
}
