import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readConfig, rollPrize } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/micro-light/preview?votes=1234
 * 按当前配置预览某一票数下各奖品的动态概率与期望值（后台调参用）。
 */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const votes = Math.max(0, Number(new URL(request.url).searchParams.get("votes")) || 0);
  const config = await readConfig();
  const roll = rollPrize(config, votes);
  return NextResponse.json({
    code: 0,
    data: {
      votes,
      targetEv: roll.targetEv,
      probabilities: roll.probabilities,
    },
  });
}
