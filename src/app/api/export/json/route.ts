import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { readPayRecords, getBeijingTime } from "@/lib/user-data";
import type { RawGiftRecord } from "@/lib/revenue";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const url = new URL(request.url);
  // 会话 ID：优先 cookie，fallback 到 query 参数（Tauri WebView 可能不发送 cookie）
  const sid = url.searchParams.get("_sid")
    ?? cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1]
    ?? null;
  const session = await getActiveSessionFromCookie(sid);

  let records: RawGiftRecord[];
  let fileName: string;
  let accountInfo: { uname: string; mid: number; source: string } | null = null;

  if (session) {
    records = await readPayRecords(session.mid, session.uname);
    if (records.length === 0) {
      return NextResponse.json(
        { code: 1, message: "no records available" },
        { status: 404 },
      );
    }
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    fileName = `bili-revenue-${month}.json`;
    accountInfo = {
      uname: session.uname,
      mid: session.mid,
      source: session.source,
    };
  } else {
    return NextResponse.json(
      { code: 403, message: "未登录" },
      { status: 403 },
    );
  }

  const totalCoins = records.reduce((sum, r) => {
    const coins = Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0;
    return sum + coins;
  }, 0);

  const exportData = {
    exportedAt: getBeijingTime(),
    account: accountInfo,
    totalRecords: records.length,
    totalCoins,
    records,
  };

  const jsonStr = JSON.stringify(exportData, null, 2);

  return new NextResponse(jsonStr, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}