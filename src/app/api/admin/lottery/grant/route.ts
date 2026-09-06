import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { markRewardGranted } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 管理后台：标记某中奖用户（mid）的奖品已发放，避免重复发放 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const mid = Number(body?.mid ?? 0);
  if (!mid) {
    return NextResponse.json({ code: -1, message: "missing mid" }, { status: 400 });
  }
  const record = await markRewardGranted(mid);
  if (!record) {
    return NextResponse.json({ code: -1, message: "该用户无抽奖记录" }, { status: 404 });
  }
  return NextResponse.json({ code: 0, data: { record } });
}
