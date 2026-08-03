import { NextRequest, NextResponse } from "next/server";
import { createSessionInput, saveSession, getSessionCookieName, getUserTokenCookieName } from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // 获取或生成用户标识
  let userToken = request.cookies.get(getUserTokenCookieName())?.value;
  if (!userToken) {
    userToken = crypto.randomUUID();
  }

  const session = createSessionInput({
    uname: "本地测试账号",
    mid: 100000,
    biliSessdata: "dev-sessdata",
    biliRefreshToken: "dev-refresh-token",
    source: "dev",
    userToken,
  });

  await saveSession(session);

  const response = NextResponse.json<ApiResponse<{ sid: string; uname: string }>>(
    {
      code: 0,
      message: "dev session created",
      data: { sid: session.sid, uname: session.uname },
    },
    { status: 200 },
  );
  response.cookies.set(getSessionCookieName(), session.sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  response.cookies.set(getUserTokenCookieName(), userToken, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60, // 1年有效期
  });
  return response;
}