import { NextRequest, NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/lottery/check?_action=roominfo&room_id=xxx
 * 获取直播间基本信息（主播昵称等，无需登录）
 */
export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("_action");
  if (action === "roominfo") {
    const roomId = Number(request.nextUrl.searchParams.get("room_id"));
    if (!roomId) return NextResponse.json({ code: -1, message: "缺少 room_id" });
    try {
      const result = await fetchBilibiliJson<{
        code: number;
        data?: { by_room_ids?: Record<string, { room_id: number; uid: number; title: string; uname: string; online: number; face: string; live_status: number }> };
      }>({
        url: `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?room_ids=${roomId}&req_biz=web-room`,
      });
      const room = result.data?.by_room_ids?.[String(roomId)];
      if (room) {
        return NextResponse.json({ code: 0, data: { uname: room.uname, title: room.title, face: room.face, online: room.online } });
      }
      return NextResponse.json({ code: -1, message: "未找到房间" });
    } catch {
      return NextResponse.json({ code: -1, message: "获取房间信息失败" });
    }
  }
    // 通过 UID 获取房间信息
    if (action === "roominfo_by_uid") {
      const uid = Number(request.nextUrl.searchParams.get("uid"));
      if (!uid) return NextResponse.json({ code: -1, message: "缺少 uid" });
      try {
        const result = await fetchBilibiliJson<{
          code: number;
          data?: { roomid: number; liveStatus: number; title?: string; uname?: string; face?: string; online?: number };
        }>({
          url: `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`,
          live: true,
        });
        if (result.code === 0 && result.data && result.data.roomid > 0) {
          return NextResponse.json({ code: 0, data: { roomid: result.data.roomid, uname: result.data.uname ?? `UID${uid}`, title: result.data.title ?? "", face: result.data.face ?? "", online: result.data.online ?? 0 } });
        }
        return NextResponse.json({ code: -1, message: "该 UID 没有直播间" });
      } catch {
        return NextResponse.json({ code: -1, message: "获取房间信息失败" });
      }
    }
    return NextResponse.json({ code: -1, message: "未知 action" });
  }

/**
 * POST /api/lottery/check
 * 检测指定直播间是否有天选福袋（需要登录）
 *
 * Body: { room_id: number }
 */
export async function POST(request: NextRequest) {
  let body: { room_id?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }

  const roomId = Number(body.room_id);
  if (!roomId) {
    return NextResponse.json({ code: -1, message: "缺少 room_id 参数" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid) {
    return NextResponse.json({ code: -1, message: "登录凭证失效" });
  }

  try {
    const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?roomid=${roomId}&need_guard=true&web_location=444.8`;
    const result = await fetchBilibiliJson<{
      code: number;
      message?: string;
      data?: {
        anchor: {
          id: number;
          room_id: number;
          status: number;
          award_name: string;
          award_num: number;
          danmu: string;
          time: number;
          current_time: number;
          require_text: string;
          require_type: number;
          ruid: number;
        } | null;
      };
    }>({
      url,
      cookie: cred.cookie,
      live: true,
    });

    if (result.code !== 0) {
      return NextResponse.json({ code: result.code, message: result.message || "检测天选失败" });
    }

    const anchor = result.data?.anchor;
    // status !== 1 表示没有进行中的天选
    const active = anchor && anchor.status === 1 ? anchor : null;
    return NextResponse.json({ code: 0, data: { anchor: active } });
  } catch (err) {
    console.error("[Lottery] 检测天选失败:", err);
    return NextResponse.json({ code: -1, message: "检测天选失败" }, { status: 500 });
  }
}
