import { NextResponse } from "next/server";
import { getPublicSnapshot } from "@/lib/lottery-scan";

export const dynamic = "force-dynamic";

/** 客户端读取服务器扫描到的天选/红包列表（无需登录） */
export async function GET() {
  try {
    const data = await getPublicSnapshot();
    return NextResponse.json({ code: 0, data });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "读取扫描结果失败" },
      { status: 500 },
    );
  }
}
