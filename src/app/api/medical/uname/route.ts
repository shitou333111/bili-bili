import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical/uname?mid=<uid>
 * 通过 B站公开接口查询 UID 对应的昵称（用于页面顶部徽章）。
 */
export async function GET(request: NextRequest) {
  const mid = request.nextUrl.searchParams.get("mid");
  if (!mid) {
    return NextResponse.json({ code: -1, message: "缺少 mid 参数" }, { status: 400 });
  }
  try {
    const url = `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}&photo=false`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
      },
      cache: "no-store",
    });
    const data = await res.json();
    if (data?.code === 0 && data?.data?.card?.name) {
      return NextResponse.json({ code: 0, data: { uid: Number(mid), uname: data.data.card.name } });
    }
    return NextResponse.json({ code: -1, message: data?.message ?? "未找到用户" });
  } catch (err) {
    console.error("[Medical] 查询昵称失败:", err);
    return NextResponse.json({ code: -1, message: "查询昵称失败" }, { status: 500 });
  }
}