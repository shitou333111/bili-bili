import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { setCachedAnchorInfo, setCachedFanInfo } from "@/lib/user-data";

export const dynamic = "force-dynamic";

/**
 * POST /api/user-data/write
 * 通用写入端点：画图时将加载到的头像数据写入对应 JSON 文件
 *
 * body: { type: "received-anchors-list" | "send-fans-list", mid, uname, data: { uid: { name, face } } }
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json({ code: 401, message: "未登录" }, { status: 401 });
  }

  const { type, data } = await request.json() as {
    type: "received-anchors-list" | "send-fans-list";
    data: Record<string, { name: string; face: string }>;
  };

  if (!type || !data || typeof data !== "object") {
    return NextResponse.json({ code: 400, message: "参数错误" }, { status: 400 });
  }

  let count = 0;
  for (const [uidStr, info] of Object.entries(data)) {
    const uid = Number(uidStr);
    if (!uid) continue;
    if (type === "received-anchors-list") {
      await setCachedAnchorInfo(session.mid, session.uname, uid, info.name, info.face);
    } else if (type === "send-fans-list") {
      await setCachedFanInfo(session.mid, session.uname, uid, info.name, info.face);
    }
    count++;
  }

  return NextResponse.json({ code: 0, message: "ok", data: { count } });
}
