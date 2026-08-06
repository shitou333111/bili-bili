import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  // fallback: query 参数 _sid（Tauri WebView 可能不发送 cookie）
  if (!sid) {
    sid = url.searchParams.get("_sid") ?? null;
  }
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json<ApiResponse<{ loggedIn: false; reason: string }>>(
      {
        code: 0,
        message: "no active site session",
        data: { loggedIn: false, reason: "no session" },
      },
      { status: 200 },
    );
  }

  // 离线模式：跳过 B 站校验，视为已登录（仍可就地读取缓存数据）
  if (isOffline(url)) {
    return NextResponse.json<ApiResponse<{ loggedIn: true; sid: string; uname: string }>>(
      {
        code: 0,
        message: "active (offline)",
        data: { loggedIn: true, sid: session.sid, uname: session.uname },
      },
      { status: 200 },
    );
  }

  // 验证 B站凭证，失效则尝试刷新
  const credentialResult = await ensureValidCredential(session);

  if (!credentialResult.valid) {
    // 凭证失效且刷新失败，需要重新登录
    return NextResponse.json<ApiResponse<{ loggedIn: false; expired: true; sid: string; uname: string }>>(
      {
        code: 0,
        message: "needs relogin",
        data: { loggedIn: false, expired: true, sid: session.sid, uname: session.uname },
      },
      { status: 200 },
    );
  }

  // 凭证有效
  return NextResponse.json<ApiResponse<{ loggedIn: true; sid: string; uname: string }>>(
    {
      code: 0,
      message: "active",
      data: { loggedIn: true, sid: session.sid, uname: session.uname },
    },
    { status: 200 },
  );
}