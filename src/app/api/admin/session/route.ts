import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const name = getAdminCookieName();
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  const sid = match?.[1] ?? null;
  const valid = await validateAdminSession(sid);
  return NextResponse.json({ code: 0, data: { valid } });
}
