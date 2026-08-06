import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { setCurrentSession, getSessionCookieName, getSessionBySid } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

export async function POST(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const { sid } = await request.json();
  if (!sid) {
    return NextResponse.json({ code: 400, message: "missing sid" }, { status: 400 });
  }

  // 获取目标用户的 userToken，用于前端更新 localStorage
  const targetSession = await getSessionBySid(sid);
  const targetUserToken = targetSession?.userToken || "";

  await setCurrentSession(sid);

  const res = NextResponse.json({ code: 0, message: "ok", data: { userToken: targetUserToken } });
  res.cookies.set(getSessionCookieName(), sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return res;
}