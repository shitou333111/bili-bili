import { NextRequest, NextResponse } from "next/server";
import {
  adoptSessionUserToken,
  getSessionBySid,
  getSessionCookieName,
  getUserTokenCookieName,
  setCurrentSession,
} from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const body = await request.json();
  const { sid } = body as { sid?: string };

  if (!sid) {
    return NextResponse.json<ApiResponse<{ success: boolean }>>(
      {
        code: 1,
        message: "sid is required",
        data: { success: false },
      },
      { status: 200 },
    );
  }

  const session = await getSessionBySid(sid);
  if (!session) {
    return NextResponse.json<ApiResponse<{ success: boolean }>>(
      {
        code: 1,
        message: "session not found",
        data: { success: false },
      },
      { status: 200 },
    );
  }

  // 验证用户只能切换自己的账号。
  // 令牌来源：cookie → query → 当前 sid 会话（旧版本会话可能没有 userToken）。
  const currentSid = request.cookies.get(getSessionCookieName())?.value ?? null;
  const currentSession = await getSessionBySid(currentSid);
  let userToken = request.cookies.get(getUserTokenCookieName())?.value;
  if (!userToken) userToken = url.searchParams.get("_user_token") ?? undefined;
  if (!userToken) userToken = currentSession?.userToken || undefined;
  // 自愈：浏览器持有当前会话的 sid Cookie，说明令牌只是漂移/缺失，按当前令牌纠正归属，
  // 否则该浏览器的账号列表与切换都会永久失效。
  if (currentSession && userToken && currentSession.userToken !== userToken) {
    await adoptSessionUserToken(currentSession.sid, userToken);
  }

  // 令牌存在时按令牌校验；令牌完全缺失（极旧数据）时只允许切换到同样没有令牌的会话。
  const ownsSession = userToken ? session.userToken === userToken : !session.userToken;
  if (!ownsSession) {
    return NextResponse.json<ApiResponse<{ success: boolean }>>(
      {
        code: 1,
        message: "无权访问该账号",
        data: { success: false },
      },
      { status: 200 },
    );
  }

  await setCurrentSession(sid);

  const response = NextResponse.json<ApiResponse<{ success: boolean; sid: string; uname: string }>>(
    {
      code: 0,
      message: "switched",
      data: { success: true, sid: session.sid, uname: session.uname },
    },
    { status: 200 },
  );

  response.cookies.set(getSessionCookieName(), session.sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 持久化（与登录/切号一致），否则浏览器关闭后丢失登录
    maxAge: 365 * 24 * 60 * 60,
  });

  return response;
}