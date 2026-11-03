import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { resetDraw, updateDrawStatus, type MicroLightDrawStatus } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/micro-light/status
 * body: { id: string; status: "miss"|"pending"|"granted"|"void"|"reset"; note?: string }
 * 标记抽奖记录的结算状态；reset 表示撤销该次抽奖（删除记录并让该 PK 回到未抽奖）。
 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: 400, message: "请求格式错误" }, { status: 400 });
  }
  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  if (!id || !["miss", "pending", "granted", "void", "reset"].includes(status)) {
    return NextResponse.json({ code: 400, message: "参数错误" }, { status: 400 });
  }
  // reset：撤销该次抽奖记录并释放 PK 锁定，记录回到未抽奖状态
  if (status === "reset") {
    const reset = await resetDraw(id);
    if (!reset) return NextResponse.json({ code: -1, message: "记录不存在" });
    return NextResponse.json({ code: 0, data: { reset: true, ...reset } });
  }
  const rec = await updateDrawStatus(id, status as MicroLightDrawStatus, body.note === undefined ? undefined : String(body.note));
  if (!rec) {
    return NextResponse.json({ code: -1, message: "记录不存在" });
  }
  return NextResponse.json({ code: 0, data: { draw: rec } });
}
