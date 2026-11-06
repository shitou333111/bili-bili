import { NextRequest, NextResponse } from "next/server";
import { updateMembership } from "@/lib/medical-fee-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/medical-fee/membership
 * body: { uid, groupId, action: "add" | "remove" }
 * 主播把自己登记到某个医药费微信群（或移除），服务端持久化，换设备/清缓存不丢。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求格式错误" }, { status: 400 });
  }
  const r = body as Record<string, unknown>;
  const uid = Number(r?.uid);
  const groupId = String(r?.groupId ?? "");
  const action = r?.action === "remove" ? "remove" : "add";
  if (!uid || uid <= 0 || !groupId) {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }
  try {
    const groups = await updateMembership(uid, groupId, action);
    return NextResponse.json({ code: 0, data: { membership: groups } });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "保存失败" },
      { status: 400 },
    );
  }
}
