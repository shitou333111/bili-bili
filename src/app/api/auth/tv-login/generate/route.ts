import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/tv-login/generate
 * 生成 TV 端登录二维码（返回 qrcode_url 和 qrcode_key）
 * TV端扫码登录成功后会返回 access_key + refresh_token
 */
export async function GET() {
  try {
    const resp = await fetch(
      "https://passport.bilibili.com/x/passport-tv-login/qrcode/generate",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Referer: "https://www.bilibili.com/",
        },
        cache: "no-store",
      },
    );
    const data = await resp.json();
    if (data.code !== 0) {
      return NextResponse.json({ code: data.code, message: data.message || "生成二维码失败" });
    }
    return NextResponse.json({
      code: 0,
      data: {
        url: data.data?.url ?? "",
        qrcode_key: data.data?.qrcode_key ?? "",
      },
    });
  } catch (err) {
    return NextResponse.json({ code: -1, message: "生成二维码失败" }, { status: 500 });
  }
}
