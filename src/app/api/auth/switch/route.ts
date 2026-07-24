import { NextResponse } from "next/server";
import { getSessionBySid, getSessionCookieName, setCurrentSession } from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export async function POST(request: Request) {
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