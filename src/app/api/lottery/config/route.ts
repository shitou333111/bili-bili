import { NextResponse } from "next/server";
import { readLotteryConfig } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 公开只读接口：返回服务器当前抽奖概率配置（admin 修改后所有平台立即读到新值） */
export async function GET() {
  const config = await readLotteryConfig();
  return NextResponse.json({ code: 0, data: { config } });
}
