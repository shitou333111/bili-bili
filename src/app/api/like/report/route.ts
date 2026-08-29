import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson, getBuvidCookie } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/** likeReportV3 专属签名密钥（与 payRecord 的 DEFAULT_APP_SECRET 不同，已用官方示例精确验证） */
const LIKE_APP_SECRET = "ea1db124af3c7062474693fa704f4ff8";

/**
 * POST /api/like/report
 * 代理 B站 likeReportV3 点赞上报接口（Web 模式：浏览器受 CORS 限制，由服务器转发）。
 * 参数：room_id（直播间长号）、anchor_id（主播 uid）、click_time（点赞次数，上限 1000）。
 * 请求中的 uid 取当前登录会话的 mid，csrf 取 cookie 中 bili_jct，并生成 w_rid 签名。
 */
export async function POST(request: NextRequest) {
  let body: { room_id?: unknown; anchor_id?: unknown; click_time?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }

  const roomId = Number(body.room_id);
  const anchorId = Number(body.anchor_id);
  const clickTime = Math.min(Math.max(Number(body.click_time) || 1000, 1), 1000); // B站 单次上限 1000
  if (!roomId || !anchorId) {
    return NextResponse.json({ code: -1, message: "缺少 room_id 或 anchor_id 参数" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  // fallback: query 参数 _sid（Tauri WebView 可能不发送 cookie）
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录，无法点赞" });
  }
  if (!session.biliSessdata && !(session.biliCookies?.length)) {
    return NextResponse.json({ code: -1, message: "该功能需要登录凭证，服务器账号无法使用" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid) {
    return NextResponse.json({ code: -1, message: "登录凭证失效，请重新登录" });
  }

  const csrf = cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
  if (!csrf) {
    return NextResponse.json({ code: -1, message: "未找到登录凭证(csrf)，请重新登录" });
  }

  const params: Record<string, string> = {
    click_time: String(clickTime),
    room_id: String(roomId),
    uid: String(session.mid),
    anchor_id: String(anchorId),
    web_location: "444.8",
    csrf,
    wts: String(Math.floor(Date.now() / 1000)),
  };
  // w_rid = md5(除 w_rid 外全部参数按 key 排序、join 成 k=v&...（值不 URL 编码）+ 密钥)
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  params.w_rid = createHash("md5").update(`${sorted}${LIKE_APP_SECRET}`).digest("hex");

  const url = "https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3";
  // 该接口仅支持 POST（GET 返回 405），参数放 body（application/x-www-form-urlencoded）
  const formBody = new URLSearchParams(params).toString();

  // 点赞为写操作，B站 风控要求 Cookie 携带 buvid3 设备指纹；缺失则补齐（同 412 反爬处理）
  let likeCookie = cred.cookie;
  try {
    if (!/buvid3\s*=/i.test(likeCookie)) {
      const buvidCookie = await getBuvidCookie();
      if (buvidCookie) likeCookie = `${buvidCookie}; ${likeCookie}`;
    }
  } catch {
    // buvid 获取失败不阻断点赞流程，沿用原 cookie
  }

  try {
    const result = await fetchBilibiliJson<{ code: number; message?: string; msg?: string; data?: unknown }>({
      url,
      method: "POST",
      body: formBody,
      cookie: likeCookie,
      live: true,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[Like] 点赞失败:", err);
    return NextResponse.json({ code: -1, message: "点赞失败" }, { status: 500 });
  }
}
