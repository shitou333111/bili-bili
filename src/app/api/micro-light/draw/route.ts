import { NextRequest, NextResponse } from "next/server";
import { drawForPk } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * POST /api/micro-light/draw
 * body: { uid: number; pkId: number; roomId?: number }
 * 服务端会重新拉取 B站 记录并校验资格（有效期 / 名次 / 人数 / 是否打满 / 先到先得 / 月度上限）。
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: -1, message: "请求格式错误" }, { status: 400 });
  }
  const uid = Number(body.uid);
  const pkId = Number(body.pkId);
  const roomId = Number(body.roomId) || 0;
  if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(pkId) || pkId <= 0) {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }

  try {
    const result = await drawForPk({ uid, pkId, roomId });
    return NextResponse.json({
      code: 0,
      data: {
        draw: result.draw,
        entry: result.entry,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "抽奖失败，请稍后重试" },
      { status: 200 },
    );
  }
}
