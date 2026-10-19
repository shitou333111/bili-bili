import { NextRequest, NextResponse } from "next/server";
import { getSessionsByUserToken, getUserTokenCookieName, readState, writeState } from "@/lib/auth/session";
import { loadAccountInfo, readAccountNoRevenue } from "@/lib/user-data";
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
      noRevenue: await readAccountNoRevenue(s.mid, s.uname),
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

/**
 * 从账号列表删除一个会话（仅移除登录态，不动用户数据）。
 * 用户重新扫码登录后按 mid 复用同一批数据，即可快速恢复使用。
 */
export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const sid = url.searchParams.get("sid");
  if (!sid) {
    return NextResponse.json<ApiResponse>({ code: 400, message: "缺少 sid 参数" }, { status: 400 });
  }

  // 与 GET 相同的用户标识解析：优先 cookie，fallback 到 query 参数
  let userToken = request.cookies.get(getUserTokenCookieName())?.value || null;
  if (!userToken) {
    userToken = url.searchParams.get("_user_token") ?? null;
  }

  const state = await readState();
  const target = state.sessions.find((s) => s.sid === sid);
  if (!target) {
    return NextResponse.json<ApiResponse>({ code: 404, message: "账号不存在" }, { status: 404 });
  }
  // 归属校验：只允许删除当前用户自己的会话（userToken 为空时不匹配任何会话，天然拒绝）
  if (!userToken || target.userToken !== userToken) {
    return NextResponse.json<ApiResponse>({ code: 403, message: "无权删除该账号" }, { status: 403 });
  }

  state.sessions = state.sessions.filter((s) => s.sid !== sid);
  await writeState(state);

  return NextResponse.json<ApiResponse>({ code: 0, message: "ok" }, { status: 200 });
}