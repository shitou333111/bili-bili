import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readLotteryConfig, updateLotteryConfig } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/** 管理后台：读取当前抽奖配置（概率 + 活动开关） */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const config = await readLotteryConfig();
  return NextResponse.json({ code: 0, data: { config } });
}

/**
 * 管理后台：更新抽奖配置
 * - oddsDenom：概率分母（格式 "1/n"，n 为 ≥2 的整数），改后所有平台立即生效；
 * - enabled：活动开关（false 时抽奖暂停，APP 内抽奖页可打开但不可用）。
 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const partial: { oddsDenom?: number; enabled?: boolean } = {};
  if (body?.oddsDenom !== undefined) {
    const denom = Number(body.oddsDenom);
    if (!Number.isInteger(denom) || denom < 2) {
      return NextResponse.json({ code: -1, message: "概率分母必须是大于等于 2 的整数" }, { status: 400 });
    }
    partial.oddsDenom = denom;
  }
  if (typeof body?.enabled === "boolean") {
    partial.enabled = body.enabled;
  }
  if (partial.oddsDenom === undefined && partial.enabled === undefined) {
    return NextResponse.json({ code: -1, message: "没有可更新的配置项" }, { status: 400 });
  }
  const config = await updateLotteryConfig(partial);
  return NextResponse.json({ code: 0, data: { config } });
}
