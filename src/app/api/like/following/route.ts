import { NextRequest, NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson, getBuvidCookie } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/like/following
 * 代理 B站 关注列表接口（Web 模式：浏览器受 CORS 限制，由服务器转发）。
 * 返回正在直播的常看关注主播（第一页前 9 位）。
 */
export async function GET(request: NextRequest) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  // fallback: query 参数 _sid（Tauri WebView 可能不发送 cookie）
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录，无法获取关注列表" });
  }
  if (!session.biliSessdata && !(session.biliCookies?.length)) {
    return NextResponse.json({ code: -1, message: "该功能需要登录凭证，服务器账号无法使用" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid) {
    return NextResponse.json({ code: -1, message: "登录凭证失效，请重新登录" });
  }

  try {
    // 关注列表请求带上 buvid3 设备指纹，确保 B站 返回"常看"排序（浏览器/手机均携带）
    let listCookie = cred.cookie;
    try {
      if (!/buvid3\s*=/i.test(listCookie)) {
        const buvidCookie = await getBuvidCookie();
        if (buvidCookie) listCookie = `${buvidCookie}; ${listCookie}`;
      }
    } catch {
      // buvid 获取失败不阻断流程，沿用原 cookie
    }
    const result = await fetchBilibiliJson<{
      code: number;
      message?: string;
      data?: { list?: Array<{ uid: number; roomid: number; uname: string; face: string; title: string; live_status: number }> };
    }>({
      url: "https://api.live.bilibili.com/xlive/web-ucenter/user/following?page=1&page_size=9&ignoreRecord=1&hit_ab=true",
      cookie: listCookie,
      live: true,
    });
    if (result.code !== 0) {
      return NextResponse.json(result);
    }
    // 仅保留正在开播（live_status=1）且有直播间的主播
    const list: { uid: number; roomid: number; uname: string; face: string; title: string }[] =
      result.data?.list?.filter((a) => a.live_status === 1 && a.roomid > 0) ?? [];
    // 当前登录账号若也是主播且正在开播，则排到列表最上面（自己不能关注自己，列表不含自己）
    const own = await fetchOwnLiveRoom(cred.cookie, session);
    if (own) list.unshift(own);
    return NextResponse.json({ code: 0, message: "ok", data: { list } });
  } catch (err) {
    console.error("[Like] 获取关注列表失败:", err);
    return NextResponse.json({ code: -1, message: "获取关注列表失败" }, { status: 500 });
  }
}

/** 检测当前登录账号自己的直播间：有房且正在开播时返回主播信息，否则 null */
async function fetchOwnLiveRoom(
  cookie: string,
  session: { mid: number; uname: string; face?: string },
): Promise<{ uid: number; roomid: number; uname: string; face: string; title: string } | null> {
  try {
    const data = await fetchBilibiliJson<{
      code: number;
      data?: { roomid: number; liveStatus: number; title?: string } | null;
    }>({
      url: `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${session.mid}`,
      cookie,
      live: true,
    });
    if (data.code === 0 && data.data && data.data.roomid > 0 && data.data.liveStatus === 1) {
      return {
        uid: session.mid,
        roomid: data.data.roomid,
        uname: session.uname,
        face: session.face ?? "",
        title: data.data.title ?? "",
      };
    }
    return null;
  } catch {
    return null;
  }
}
