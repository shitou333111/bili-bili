/**
 * GET /api/config
 * 供 Tauri 客户端拉取远程配置（admin-config.json）
 * 无需认证，公开访问
 */
import { NextResponse } from "next/server";
import { readAdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await readAdminConfig();
    return NextResponse.json({
      code: 0,
      data: config ?? {},
    });
  } catch (err) {
    return NextResponse.json({
      code: -1,
      message: "读取配置失败",
    });
  }
}