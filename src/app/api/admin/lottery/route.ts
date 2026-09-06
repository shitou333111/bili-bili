import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readLotteryRecords, readLotteryConfig } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 管理后台：查看全部抽奖记录 + 当前抽奖概率（需管理员会话），按抽奖时间倒序 */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const records = await readLotteryRecords();
  const config = await readLotteryConfig();
  const sorted = [...records].sort((a, b) => b.drawnAt.localeCompare(a.drawnAt));
  return NextResponse.json({ code: 0, data: { records: sorted, config } });
}
