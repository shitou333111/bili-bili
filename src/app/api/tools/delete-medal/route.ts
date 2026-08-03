import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  let sid = request.cookies.get(getSessionCookieName())?.value;
  if (!sid) sid = url.searchParams.get("_sid") ?? undefined;
  const session = await getSessionBySid(sid);
  if (!session) {
    return NextResponse.json({ code: -101, message: "未登录" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid || !cred.cookie) {
    return NextResponse.json({ code: -101, message: "登录凭证已失效，请重新扫码登录" });
  }

  const body = await request.json();
  const { medal_id } = body as { medal_id: number };
  if (!medal_id) return NextResponse.json({ code: -1, message: "缺少 medal_id" });

  const csrf = cred.cookie.match(/bili_jct=([a-f0-9]+)/)?.[1] || "";

  try {
    const result = await fetchBilibiliJson<{ code: number; message: string; data?: unknown }>({
      url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/web_room/del_medal",
      cookie: cred.cookie,
      method: "POST",
      body: `medal_id=${medal_id}&csrf_token=${csrf}&csrf=${csrf}`,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/tools/delete-medal] error:", err);
    return NextResponse.json({ code: -1, message: "请求失败" });
  }
}