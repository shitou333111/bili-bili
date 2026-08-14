import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical/universal?room_id=<id>&anchor_uid=<uid>
 * 代理 B站 UniversalInfoForAudience，返回多位主播接力 PK 的实时信息。
 * 该接口为公开接口，无需登录凭证。
 */
export async function GET(request: NextRequest) {
  const roomId = request.nextUrl.searchParams.get("room_id");
  const anchorUid = request.nextUrl.searchParams.get("anchor_uid");
  if (!roomId || !anchorUid) {
    return NextResponse.json({ code: -1, message: "缺少 room_id 或 anchor_uid 参数" }, { status: 400 });
  }
  try {
    const url = `https://api.live.bilibili.com/xlive/web-room/v2/universalInteract/UniversalInfoForAudience?room_id=${encodeURIComponent(
      roomId,
    )}&anchor_uid=${encodeURIComponent(anchorUid)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[Medical] 获取接力信息失败:", err);
    return NextResponse.json({ code: -1, message: "获取接力信息失败" }, { status: 500 });
  }
}