import { NextResponse } from "next/server";
import { fetchBilibiliJson } from "@/lib/bilibili/client";
import type { ApiResponse, LoginProbeResult } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";

  if (!cookieHeader) {
    return NextResponse.json<ApiResponse<LoginProbeResult>>(
      {
        code: 0,
        message: "no browser session",
        data: { isLogin: false },
      },
      { status: 200 },
    );
  }

  try {
    const result = await fetchBilibiliJson<{
      code: number;
      message: string;
      data: { isLogin: boolean; uname?: string; mid?: number };
    }>({
      url: "https://api.bilibili.com/x/web-interface/nav",
      cookie: cookieHeader,
    });

    if (result.code !== 0 || !result.data?.isLogin) {
      return NextResponse.json<ApiResponse<LoginProbeResult>>(
        {
          code: 0,
          message: "not logged in",
          data: { isLogin: false },
        },
        { status: 200 },
      );
    }

    return NextResponse.json<ApiResponse<LoginProbeResult>>(
      {
        code: 0,
        message: "ok",
        data: {
          isLogin: true,
          uname: result.data.uname,
          mid: result.data.mid,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json<ApiResponse<LoginProbeResult>>(
      {
        code: 1,
        message: error instanceof Error ? error.message : "probe failed",
        data: { isLogin: false },
      },
      { status: 200 },
    );
  }
}
