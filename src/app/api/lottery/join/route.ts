import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/**
 * POST /api/lottery/join
 * 参与天选抽奖（需要登录）
 *
 * Body: { id: number, room_id: number }
 */
export async function POST(request: NextRequest) {
  let body: { id?: unknown; room_id?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }

  const lotteryId = Number(body.id);
  const roomId = Number(body.room_id);
  if (!lotteryId || !roomId) {
    return NextResponse.json({ code: -1, message: "缺少 id 或 room_id 参数" }, { status: 400 });
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

  const csrf = cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
  if (!csrf) {
    return NextResponse.json({ code: -1, message: "未找到 csrf" });
  }

  const params: Record<string, string> = {
    csrf,
    follow: "true",
    id: String(lotteryId),
    jump_from_str: "",
    live_statistics: JSON.stringify({
      pc_client: "pink",
      jumpfrom: "-99998",
      room_category: "0",
      lottery_id: lotteryId,
      lottery_type: 1,
      trackid: "-99998",
    }),
    platform: "pc",
    room_id: String(roomId),
    session_id: "",
    spm_id: "444.8.interaction.anchor_draw_auto",
  };
  const formBody = new URLSearchParams(params).toString();

  try {
    const result = await fetchBilibiliJson<{
      code: number;
      message?: string;
      msg?: string;
      data?: unknown;
    }>({
      url: "https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Join",
      method: "POST",
      body: formBody,
      cookie: cred.cookie,
      live: true,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[Lottery] 参与抽奖失败:", err);
    return NextResponse.json({ code: -1, message: "参与抽奖失败" }, { status: 500 });
  }
}
