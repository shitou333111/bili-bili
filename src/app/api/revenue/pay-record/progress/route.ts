import { NextResponse } from "next/server";
import { readPayRecordProgress } from "@/lib/pay-record-progress";

export const dynamic = "force-dynamic";

/**
 * 消费记录拉取进度查询（WEB 端长任务轮询用）
 *
 * 前端发起 /api/revenue/pay-record?_t=<ticket> 后，每秒轮询本接口读取进度；
 * ticket 由前端生成、随主请求带上，无需鉴权（只读内存里的进度文案）。
 */
export async function GET(request: Request) {
  const ticket = new URL(request.url).searchParams.get("t") ?? "";
  return NextResponse.json(
    { code: 0, data: readPayRecordProgress(ticket) },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}