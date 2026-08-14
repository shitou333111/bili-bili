import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical/room-id?mid=<uid>
 * 代理 B站 getRoomInfoOld，返回直播间 roomid。
 * 该接口为公开接口，无需登录凭证。
 */
export async function GET(request: NextRequest) {
  const mid = request.nextUrl.searchParams.get("mid");
  if (!mid) {
    return NextResponse.json({ code: -1, message: "缺少 mid 参数" }, { status: 400 });
  }
  try {
    const url = `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${encodeURIComponent(mid)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      cache: "no-store",
    });
    const data = await res.json();
    if (data?.code !== 0) {
      return NextResponse.json({ code: data?.code ?? -1, message: data?.message ?? "获取房间信息失败" });
    }
    return NextResponse.json({ code: 0, data: { roomid: data?.data?.roomid ?? 0 } });
  } catch (err) {
    console.error("[Medical] 获取房间信息失败:", err);
    return NextResponse.json({ code: -1, message: "获取房间信息失败" }, { status: 500 });
  }
}