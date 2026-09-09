import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/tv-login/poll?qrcode_key=xxx
 * 轮询 TV 端扫码登录状态
 * 成功后返回 access_key 和 refresh_token
 */
export async function GET(request: NextRequest) {
  const qrcodeKey = request.nextUrl.searchParams.get("qrcode_key");
  if (!qrcodeKey) {
    return NextResponse.json({ code: -1, message: "缺少 qrcode_key" });
  }

  try {
    const resp = await fetch(
      `https://passport.bilibili.com/x/passport-tv-login/qrcode/poll`,
      {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://www.bilibili.com/",
        },
        body: `qrcode_key=${encodeURIComponent(qrcodeKey)}`,
        cache: "no-store",
      },
    );
    const data = await resp.json();
    // code: 0=成功, 86090=已扫描未确认, 86101=未扫描, 86038=已过期
    if (data.code === 0 && data.data?.access_token) {
      return NextResponse.json({
        code: 0,
        status: "success",
        data: {
          access_token: data.data.access_token,
          refresh_token: data.data.refresh_token || "",
          expires_in: data.data.expires_in || 0,
          uname: data.data?.uname || "",
          mid: data.data?.mid || 0,
          face: data.data?.face || "",
        },
      });
    }
    // 返回当前状态
    return NextResponse.json({
      code: data.code,
      status: data.code === 86090 ? "scanned" : data.code === 86101 ? "waiting" : data.code === 86038 ? "expired" : "unknown",
      message: data.message || "",
    });
  } catch (err) {
    return NextResponse.json({ code: -1, message: "轮询失败" }, { status: 500 });
  }
}
