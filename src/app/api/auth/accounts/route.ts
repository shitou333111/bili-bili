import { NextRequest, NextResponse } from "next/server";
import {
  adoptSessionUserToken,
  getAllSessions,
  getSessionBySid,
  getSessionCookieName,
  getSessionsByUserToken,
  getUserTokenCookieName,
  readState,
  writeState,
} from "@/lib/auth/session";
import { loadAccountInfo, readAccountNoRevenue } from "@/lib/user-data";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  // 获取用户标识：优先 cookie，fallback 到 query 参数（Tauri WebView 可能不发送 cookie）
  let userToken = request.cookies.get(getUserTokenCookieName())?.value || url.searchParams.get("_user_token") || null;

  // 自愈：浏览器带着 sid Cookie 访问，就证明该会话属于它。
  // 早期版本创建的会话没有 userToken（永远匹配不到），或历史按 mid 去重时令牌被其他设备覆盖过，
  // 这里按 sid 把归属纠正回当前浏览器，否则账号会从列表中消失、也无法切换。
  const sid = request.cookies.get(getSessionCookieName())?.value || null;
  const current = await getSessionBySid(sid);
  if (current) {
    if (!userToken) userToken = current.userToken || null;
    if (userToken && current.userToken !== userToken) {
      await adoptSessionUserToken(current.sid, userToken);
    }
  }

  // 旧账号找回：早期版本的会话没有 userToken 字段，任何设备都匹配不到（账号列表里消失）。
  // 浏览器会带上本机缓存过的 mid（IndexedDB），据此把这些"无归属"的旧会话认领到当前浏览器。
  // 只认领 userToken 为空的会话，不会抢夺其他设备已归属的账号。
  const claimedMids = new Set(
    (url.searchParams.get("_mids") ?? "")
      .split(",")
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0),
  );
  if (userToken && claimedMids.size > 0) {
    const allSessions = await getAllSessions();
    for (const s of allSessions) {
      if (!s.userToken && claimedMids.has(s.mid)) {
        await adoptSessionUserToken(s.sid, userToken);
      }
    }
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

  // 与 GET 相同的用户标识解析：优先 cookie，fallback 到 query 参数 / 当前 sid 会话
  let userToken = request.cookies.get(getUserTokenCookieName())?.value || url.searchParams.get("_user_token") || null;
  const currentSid = request.cookies.get(getSessionCookieName())?.value || null;
  const current = await getSessionBySid(currentSid);
  if (current) {
    if (!userToken) userToken = current.userToken || null;
    if (userToken && current.userToken !== userToken) {
      await adoptSessionUserToken(current.sid, userToken);
    }
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