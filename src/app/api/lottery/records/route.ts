import { NextResponse } from "next/server";
import { getUserLotteryRecord, readLotteryConfig } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 获取当前用户（mid）的抽奖记录 + 服务器当前抽奖概率，供抽奖页长期查看自己的结果 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mid = Number(url.searchParams.get("mid") || 0);
  if (!mid) {
    return NextResponse.json({ code: -1, message: "missing mid" }, { status: 400 });
  }
  const record = await getUserLotteryRecord(mid);
  const config = await readLotteryConfig();
  return NextResponse.json({ code: 0, data: { drawn: !!record, record, config } });
}
