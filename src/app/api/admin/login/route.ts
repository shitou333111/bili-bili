import { NextResponse } from "next/server";
import { verifyAdmin, createAdminSession, getAdminCookieName } from "@/lib/auth/admin";

export async function POST(request: Request) {
  const body = await request.json();
  const { username, password } = body;

  if (!verifyAdmin(username, password)) {
    return NextResponse.json({ code: 401, message: "用户名或密码错误" }, { status: 401 });
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
