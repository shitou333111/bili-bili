import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

type BiliMedalResponse = {
  code: number;
  message: string;
  data?: {
    list: Record<string, unknown>[];
    special_list: Record<string, unknown>[];
    page_info: { current_page: number; has_more: boolean; next_page: number; total_page: number; number: number };
    total_number: number;
  };
};

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);

  const sid = request.cookies.get(getSessionCookieName())?.value;
  const session = await getSessionBySid(sid);
  if (!session) {
    return NextResponse.json({ code: -101, message: "未登录", data: null });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid || !cred.cookie) {
    return NextResponse.json({ code: -101, message: "登录凭证已失效，请重新扫码登录", data: null });
  }

  try {
    const result = await fetchBilibiliJson<BiliMedalResponse>({
      url: `https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=10`,
      cookie: cred.cookie,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/tools/medals] error:", err);
    return NextResponse.json({ code: -1, message: "请求失败", data: null });
  }
}
