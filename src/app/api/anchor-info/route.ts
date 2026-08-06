import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { readPayRecords } from "@/lib/user-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/anchor-info
 * 从 pay-records.json 提取主播分布数据
 * 返回每个主播的 UID、昵称、送礼总金额
 * 供主播分布图使用
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json({ code: 401, message: "未登录" }, { status: 401 });
  }

  const records = await readPayRecords(session.mid, session.uname);
  const anchorMap = new Map<number, { name: string; hamster: number }>();
  for (const r of records) {
    if (!r.ruid) continue;
    // pay_coin 是付费金仓鼠数量，1:1 对应 hamster
    const hamster = Number(String(r.pay_coin || r.coin).replace(/,/g, "")) || 0;
    const existing = anchorMap.get(r.ruid);
    if (existing) {
      existing.hamster += hamster;
    } else {
      anchorMap.set(r.ruid, { name: r.r_uname || "", hamster });
    }
  }

  const anchors = Array.from(anchorMap.entries())
    .map(([ruid, v]) => ({ ruid, rname: v.name, hamster: v.hamster }))
    .sort((a, b) => b.hamster - a.hamster);

  return NextResponse.json({ code: 0, data: anchors });
}
