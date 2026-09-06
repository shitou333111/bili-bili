import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readLotteryConfig, updateLotteryConfig } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 管理后台：读取当前抽奖概率配置 */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const config = await readLotteryConfig();
  return NextResponse.json({ code: 0, data: { config } });
}

/** 管理后台：更新抽奖概率（格式 "1/n"，n 为 ≥2 的整数），改后所有平台立即生效 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const denom = Number(body?.oddsDenom ?? 0);
  if (!Number.isInteger(denom) || denom < 2) {
    return NextResponse.json({ code: -1, message: "概率分母必须是大于等于 2 的整数" }, { status: 400 });
  }
  const config = await updateLotteryConfig(denom);
  return NextResponse.json({ code: 0, data: { config } });
}
