import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import {
  createSessionInput,
  getAllSessions,
  getSessionBySid,
  getSessionCookieName,
  getUserTokenCookieName,
  saveSession,
  setCurrentSession,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

/**
 * 管理员切换到某个账号（浏览器端「查看数据」）。
 *
 * 入参二选一：
 *   - sid：已存在的会话，直接切过去（客户端/本地登录账号）；
 *   - mid + uname：服务器收集账号在浏览器里没有本地会话，只读查看时按 mid 找会话；
 *     找不到就创建一个 source="server" 的只读会话（无 B站 凭证，数据由服务器路由返回）。
 */
export async function POST(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { sid, mid, uname, face } = body as {
    sid?: string;
    mid?: number;
    uname?: string;
    face?: string;
  };

  let session = sid ? await getSessionBySid(sid) : null;
  if (!session && typeof mid === "number" && mid > 0) {
    const all = await getAllSessions();
    // 只按 mid 找已有会话（不新建重复会话，也不覆盖该账号原有的扫码登录凭证）
    session = all.find((item) => item.mid === mid) ?? null;
  }

  // 目标用户标识（供前端更新 localStorage）
  let targetUserToken = session?.userToken || "";
  // 新建只读会话时需要给这个浏览器写入 userToken cookie（只写一次）
  let issuedUserToken: string | null = null;

  if (!session) {
    if (typeof mid !== "number" || mid <= 0 || !uname) {
      return NextResponse.json({ code: 400, message: "missing sid or mid/uname" }, { status: 400 });
    }
    const cookieHeader = request.headers.get("cookie") ?? "";
    let userToken =
      cookieHeader.match(new RegExp(`${getUserTokenCookieName()}=([^;]+)`))?.[1] ?? "";
    if (!userToken) {
      userToken = randomUUID();
      issuedUserToken = userToken;
    }
    session = await saveSession(
      createSessionInput({
        uname,
        mid,
        face,
        // 服务器收集账号没有 B站 凭证：只读展示，不参与凭证校验（见 /api/auth/status）
        biliSessdata: "",
        biliRefreshToken: "",
        source: "server",
        userToken,
      }),
    );
    targetUserToken = session.userToken;
  }

  await setCurrentSession(session.sid);

  const res = NextResponse.json({
    code: 0,
    message: "ok",
    data: { userToken: targetUserToken, sid: session.sid },
  });
  res.cookies.set(getSessionCookieName(), session.sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 持久化（与登录/切号一致），否则浏览器关闭后丢失登录
    maxAge: 365 * 24 * 60 * 60,
  });
  if (issuedUserToken) {
    res.cookies.set(getUserTokenCookieName(), issuedUserToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
    });
  }
  return res;
}
