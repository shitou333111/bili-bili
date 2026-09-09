import { NextRequest, NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/**
 * POST /api/lottery/enter-room
 * 进入直播间 - 触发 roomEntryAction 使自己计入在线观众（需要登录）
 * 天选福袋开奖时必须在直播间才能中奖
 *
 * Body: { room_id: number }
 */
export async function POST(request: NextRequest) {
  let body: { room_id?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }

  const roomId = Number(body.room_id);
  if (!roomId) {
    return NextResponse.json({ code: -1, message: "缺少 room_id 参数" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid) {
    return NextResponse.json({ code: -1, message: "登录凭证失效" });
  }

  try {
    const result = await fetchBilibiliJson<{
      code: number;
      message?: string;
      data?: unknown;
    }>({
      url: "https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction",
      method: "POST",
      body: JSON.stringify({ room_id: roomId, platform: "pc" }),
      cookie: cred.cookie,
      live: true,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[Lottery] 进入直播间失败:", err);
    return NextResponse.json({ code: -1, message: "进入直播间失败" }, { status: 500 });
  }
}
