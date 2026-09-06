import { NextResponse } from "next/server";
import { drawLottery } from "@/lib/lottery";

export const dynamic = "force-dynamic";

/**
 * 执行抽奖：中奖率固定 1/20，奖品为一个月舰长。
 * 每个用户（mid）只能抽取一次，重复抽取返回已有记录。
 * 前端已限制仅登录账号可进入；服务器按 mid 持久化，保证一人一次。
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const mid = Number(body?.mid || 0);
  const uname = String(body?.uname || "未知用户");
  if (!mid) {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }
  const { record, alreadyDrawn } = await drawLottery(mid, uname);
  return NextResponse.json({ code: 0, data: { record, alreadyDrawn } });
}
