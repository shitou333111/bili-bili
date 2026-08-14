import { NextRequest, NextResponse } from "next/server";
import { readGlobalRecords, getStatsForUid } from "@/lib/medical-fee";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical/stats?uid=<uid>
 * 返回某用户有史以来发放/收到的医药费统计（基于全局去重记录）。
 */
export async function GET(request: NextRequest) {
  const uid = Number(request.nextUrl.searchParams.get("uid") || "0");
  if (!uid) {
    return NextResponse.json({ code: -1, message: "缺少 uid 参数" }, { status: 400 });
  }
  const records = await readGlobalRecords();
  const stats = getStatsForUid(records, uid);
  return NextResponse.json({ code: 0, data: { uid, ...stats } });
}