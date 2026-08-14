import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/tools/streamer-info?uid=xxx
 * 通过 B站 API get_status_info_by_uids 获取主播信息（昵称、头像、房间号）
 * 供 Admin 页面添加推荐主播时使用，无需登录凭证（公开API）
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const uid = Number(url.searchParams.get("uid"));

  if (!uid || uid <= 0) {
    return NextResponse.json({ code: 400, message: "缺少有效 uid 参数" }, { status: 400 });
  }

  try {
    const apiUrl = `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${uid}`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Referer": "https://live.bilibili.com/",
      },
    });
    const data = await res.json();

    if (data.code !== 0) {
      return NextResponse.json({ code: -1, message: data.message || data.msg || "B站API返回错误" });
    }

    const info = data.data?.[String(uid)];
    if (!info) {
      return NextResponse.json({ code: -1, message: "未找到该UID对应的主播信息" });
    }

    return NextResponse.json({
      code: 0,
      data: {
        uid,
        uname: info.uname || "",
        face: info.face || "",
        room_id: info.room_id || 0,
        live_status: info.live_status || 0,
        title: info.title || "",
      },
    });
  } catch (err) {
    return NextResponse.json({
      code: -1,
      message: err instanceof Error ? err.message : "请求B站API失败",
    });
  }
}
