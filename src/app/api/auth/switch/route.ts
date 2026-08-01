import { NextRequest, NextResponse } from "next/server";
import { getSessionBySid, getSessionCookieName, getUserTokenCookieName, setCurrentSession } from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export async function POST(request: NextRequest) {
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

  // 验证用户只能切换自己的账号
  const userToken = request.cookies.get(getUserTokenCookieName())?.value;
  if (userToken !== session.userToken) {
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
  });

  return response;
}