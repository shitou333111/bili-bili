import { NextResponse } from "next/server";
import { verifyAdmin, createAdminSession, getAdminCookieName } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json();
  const { username, password } = body;

  // 仅校验密码；用户名可选（多个调用方可能不传），密码正确即通过
  if (!verifyAdmin(username, password)) {
    return NextResponse.json({ code: 401, message: "密码错误" }, { status: 401 });
  }

  const sid = await createAdminSession();
  const res = NextResponse.json({ code: 0, message: "ok" });
  res.cookies.set(getAdminCookieName(), sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
}