import { NextResponse } from "next/server";
import { createSessionInput, saveSession, getSessionCookieName } from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export async function POST() {
  const session = createSessionInput({
    uname: "本地测试账号",
    mid: 100000,
    biliSessdata: "dev-sessdata",
    biliRefreshToken: "dev-refresh-token",
    source: "dev",
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
  return response;
}
