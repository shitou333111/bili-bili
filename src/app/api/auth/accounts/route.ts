import { NextRequest, NextResponse } from "next/server";
import { getSessionsByUserToken, getUserTokenCookieName } from "@/lib/auth/session";
import { loadAccountInfo } from "@/lib/user-data";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // 获取用户标识：优先 cookie，fallback 到 query 参数（Tauri WebView 可能不发送 cookie）
  let userToken = request.cookies.get(getUserTokenCookieName())?.value || null;
  if (!userToken) {
    userToken = url.searchParams.get("_user_token") ?? null;
  }
  
  // 只返回当前用户标识关联的会话
  const sessions = await getSessionsByUserToken(userToken);

  // 按 mid 去重，保留最新的（updatedAt 最近的）
  const seen = new Map<number, typeof sessions[0]>();
  for (const s of sessions) {
    const existing = seen.get(s.mid);
    if (!existing || new Date(s.updatedAt) > new Date(existing.updatedAt)) {
      seen.set(s.mid, s);
    }
  }
  const uniqueSessions = Array.from(seen.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const accounts = await Promise.all(uniqueSessions.map(async (s) => {
    // 优先从 account-info.json 获取最新的 face（admin 模式下 session 中的 face 可能过时）
    let face = s.face ?? "";
    const accountInfo = await loadAccountInfo(s.mid, s.uname);
    if (accountInfo?.face) {
      face = accountInfo.face;
    }
    return {
      sid: s.sid,
      uname: s.uname,
      mid: s.mid,
      face,
      source: s.source,
      updatedAt: s.updatedAt,
    };
  }));

  return NextResponse.json<ApiResponse<{ accounts: typeof accounts; hasAccounts: boolean }>>(
    {
      code: 0,
      message: "ok",
      data: {
        accounts,
        hasAccounts: accounts.length > 0,
      },
    },
    { status: 200 },
  );
}