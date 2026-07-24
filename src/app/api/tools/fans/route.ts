import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

type BiliFan = {
  mid: number;
  uname: string;
  face: string;
  sign: string;
  attribute: number; // 0:未关注 2:已关注 6:互粉
  mtime: number;
  special: number;
  vip: { vipType: number; vipDueDate: number };
  official_verify: { type: number; desc: string };
};

type BiliFansResponse = {
  code: number;
  message: string;
  data: {
    total: number;
    list: BiliFan[];
    offset?: string;
  };
};

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const pn = parseInt(url.searchParams.get("pn") || "1", 10);
  const ps = parseInt(url.searchParams.get("ps") || "50", 10);

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
    const result = await fetchBilibiliJson<BiliFansResponse>({
      url: `https://api.bilibili.com/x/relation/fans?vmid=${session.mid}&pn=${pn}&ps=${ps}&order=desc`,
      cookie: cred.cookie,
    });

    if (result.code !== 0) {
      return NextResponse.json({ code: result.code, message: result.message, data: null });
    }

    const fans = (result.data.list || []).map((f) => ({
      mid: f.mid,
      uname: f.uname,
      face: f.face,
      attribute: f.attribute,
      mtime: f.mtime,
    }));

    return NextResponse.json({
      code: 0,
      message: "0",
      data: {
        total: result.data.total,
        list: fans,
        pn,
        ps,
      },
    });
  } catch (err) {
    console.error("[/api/tools/fans] error:", err);
    return NextResponse.json({ code: -1, message: "请求失败", data: null });
  }
}
