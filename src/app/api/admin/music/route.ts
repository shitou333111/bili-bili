import { NextResponse } from "next/server";
import { getAdminSid, validateAdminSession } from "@/lib/auth/admin";
import {
  checkMusicQrLogin,
  clearMusicAccount,
  clearMusicServiceCache,
  getMusicAccounts,
  setMusicAccountCookie,
  startMusicQrLogin,
} from "@/lib/sing/music-service";

export const dynamic = "force-dynamic";

async function authorized(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

/** GET /api/admin/music —— 各平台音乐账号登录状态 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ code: 401, message: "未登录", data: null }, { status: 401 });
  }
  const accounts = await getMusicAccounts();
  return NextResponse.json({
    code: 0,
    message: "ok",
    data: { available: accounts !== null, accounts: accounts || {} },
  });
}

/**
 * POST /api/admin/music
 * body: { action: "qr_start" | "qr_check" | "clear" | "set_cookie", source, key?, cookie? }
 *
 * 扫码登录：start 返回二维码（平台直接给图片，或前端用 url 渲染），
 * check 轮询状态；成功后 Cookie 由 music-service 写在自己的数据目录里，
 * 不会经由浏览器转发。汽水扫码未调通，改用 set_cookie 手动绑定。
 */
export async function POST(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ code: 401, message: "未登录", data: null }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体不是合法 JSON", data: null }, { status: 400 });
  }
  const action = typeof body?.action === "string" ? body.action : "";
  const source = typeof body?.source === "string" ? body.source : "";
  if (!source) {
    return NextResponse.json({ code: 400, message: "缺少 source", data: null }, { status: 400 });
  }

  if (action === "qr_start") {
    return NextResponse.json({ code: 0, message: "ok", data: await startMusicQrLogin(source) });
  }
  if (action === "qr_check") {
    const key = typeof body?.key === "string" ? body.key : "";
    if (!key) {
      return NextResponse.json({ code: 400, message: "缺少 key", data: null }, { status: 400 });
    }
    const data = await checkMusicQrLogin(source, key);
    // 登录状态变化后清搜索缓存，让 VIP 曲目立刻参与搜索结果
    if (data.loggedIn) clearMusicServiceCache();
    return NextResponse.json({ code: 0, message: "ok", data });
  }
  if (action === "clear") {
    const data = await clearMusicAccount(source);
    if (data.ok) clearMusicServiceCache();
    return NextResponse.json({ code: 0, message: "ok", data });
  }
  if (action === "set_cookie") {
    const cookie = typeof body?.cookie === "string" ? body.cookie : "";
    if (!cookie.trim()) {
      return NextResponse.json({ code: 400, message: "Cookie 不能为空", data: null }, { status: 400 });
    }
    const data = await setMusicAccountCookie(source, cookie);
    if (data.ok) clearMusicServiceCache();
    return NextResponse.json({ code: 0, message: "ok", data });
  }
  return NextResponse.json({ code: 400, message: "未知操作", data: null }, { status: 400 });
}
