/**
 * GET /api/config
 * 供 Tauri 客户端拉取远程配置（admin-config.json）
 * 无需认证，公开访问
 */
import { NextResponse } from "next/server";
import { readAdminConfig } from "@/lib/admin-config";
import { getEffectiveRedPocketGifts } from "@/lib/red-pocket-gifts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await readAdminConfig();
    const data: Record<string, unknown> = { ...(config ?? {}) };
    // 红包礼物列表：admin 手动维护（未配置时为空），客户端据此标记消费记录中的红包礼物。
    data.red_pocket_gifts = await getEffectiveRedPocketGifts();
    return NextResponse.json({
      code: 0,
      data,
    });
  } catch (err) {
    return NextResponse.json({
      code: -1,
      message: "读取配置失败",
    });
  }
}