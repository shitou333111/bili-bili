import { NextRequest, NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/**
 * POST /api/barrage/send
 * 代理 B站 msg/send 接口（Web 模式：浏览器受 CORS 限制，由服务器转发）。
 * 使用当前登录会话的 B站 Cookie + bili_jct 作为 CSRF 发送弹幕。
 * 必要参数：csrf、roomid、msg、rnd（当前秒时间戳，缺失冷却 90s，携带 5s）、fontsize、color。
 */
export async function POST(request: NextRequest) {
  let body: { roomid?: unknown; message?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }

  const roomid = Number(body.roomid);
  const message = String(body.message ?? "").trim();
  if (!roomid || !message) {
    return NextResponse.json({ code: -1, message: "缺少 roomid 或 message 参数" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  // fallback: query 参数 _sid（Tauri WebView 可能不发送 cookie）
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录，无法发送弹幕" });
  }
  // 服务器收集账号无 B站 Cookie，无法发送
  if (!session.biliSessdata && !(session.biliCookies?.length)) {
    return NextResponse.json({ code: -1, message: "该功能需要登录凭证，服务器账号无法使用" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid) {
    return NextResponse.json({ code: -1, message: "登录凭证失效，请重新登录" });
  }

  const csrf = cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
  if (!csrf) {
    return NextResponse.json({ code: -1, message: "未找到登录凭证(csrf)，请重新登录" });
  }

  const rnd = Math.floor(Date.now() / 1000);
  const payload = new URLSearchParams({
    roomid: String(roomid),
    msg: message,
    rnd: String(rnd),
    fontsize: "25",
    color: "16777215",
    csrf,
  }).toString();

  try {
    const result = await fetchBilibiliJson<{ code: number; message?: string; msg?: string; data?: unknown }>({
      url: "https://api.live.bilibili.com/msg/send",
      method: "POST",
      body: payload,
      cookie: cred.cookie,
      live: true,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[Barrage] 发送弹幕失败:", err);
    return NextResponse.json({ code: -1, message: "发送弹幕失败" }, { status: 500 });
  }
}
