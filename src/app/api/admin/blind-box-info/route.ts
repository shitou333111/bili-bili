import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { checkBlindBox } from "@/lib/bilibili/gift-api";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const giftId = Number(url.searchParams.get("gift_id"));
  if (!giftId || giftId <= 0) {
    return NextResponse.json({ code: 400, message: "missing gift_id" }, { status: 400 });
  }

  // 用当前用户 cookie 调 B站接口查询盲盒信息
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sessionSid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  const session = await getActiveSessionFromCookie(sessionSid);

  if (!session) {
    return NextResponse.json({ code: 401, message: "需要先登录B站账号才能查询盲盒信息" }, { status: 401 });
  }

  const credResult = await ensureValidCredential(session);
  if (!credResult.valid) {
    return NextResponse.json({ code: 401, message: "B站凭证已失效，请重新登录" }, { status: 401 });
  }

  const result = await checkBlindBox(giftId, credResult.cookie);
  if (!result) {
    return NextResponse.json({ code: 404, message: "未找到该ID的盲盒信息" }, { status: 404 });
  }

  return NextResponse.json({
    code: 0,
    data: {
      name: result.blindGiftName,
      price: result.blindPrice,
      giftCount: result.gifts.length,
    },
  });
}