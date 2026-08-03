import { NextResponse } from "next/server";
import qrcode from "qrcode";
import type { ApiResponse, QRGenerateResult } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const response = await fetch(
      "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
      {
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: "https://www.bilibili.com/",
          Accept: "application/json, text/plain, */*",
        },
      },
    );

    // 检测响应是否为HTML（防止被重定向到风控页面）
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      console.error("[QR] B站返回HTML而非JSON，前200字符:", html.slice(0, 200));
      return NextResponse.json<ApiResponse<QRGenerateResult>>(
        { code: 1, message: "B站接口返回异常，请稍后重试" },
        { status: 200 },
      );
    }

    const rawText = await response.text();
    let data: { code: number; message: string; data?: QRGenerateResult };
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error("[QR] JSON解析失败，原始响应:", rawText.slice(0, 300));
      return NextResponse.json<ApiResponse<QRGenerateResult>>(
        { code: 1, message: "B站接口返回格式异常，请稍后重试" },
        { status: 200 },
      );
    }

    if (!data.data?.qrcode_key) {
      return NextResponse.json<ApiResponse<QRGenerateResult>>(
        {
          code: 1,
          message: data.message || "二维码生成失败",
        },
        { status: 200 },
      );
    }

    const image = await qrcode.toDataURL(data.data.url, {
      width: 280,
      margin: 1,
      errorCorrectionLevel: "M",
    });

    return NextResponse.json<ApiResponse<QRGenerateResult>>(
      {
        code: 0,
        message: "ok",
        data: {
          ...data.data,
          image,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json<ApiResponse<QRGenerateResult>>(
      {
        code: 1,
        message: error instanceof Error ? error.message : "二维码生成失败",
      },
      { status: 200 },
    );
  }
}