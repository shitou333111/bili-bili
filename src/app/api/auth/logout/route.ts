import { NextResponse } from "next/server";
import { getSessionCookieName, setCurrentSession } from "@/lib/auth/session";
import type { ApiResponse } from "@/lib/bilibili/types";

export async function POST() {
  await setCurrentSession(null);

  const response = NextResponse.json<ApiResponse<{ success: boolean }>>(
    {
      code: 0,
      message: "logged out",
      data: { success: true },
    },
    { status: 200 },
  );

  response.cookies.delete(getSessionCookieName());

  return response;
}