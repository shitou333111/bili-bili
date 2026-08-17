import { NextResponse } from "next/server";
import { readAdminConfig, writeAdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

/**
 * POST /api/recommended-anchors/click
 * body: { uid: number }
 * 递增该主播的全局点击次数（所有用户共享）。
 * 采用 read-modify-write 整体写回，不丢失 admin 同时修改的其他字段。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const uid = Number(body?.uid);
    if (!uid || uid <= 0) {
      return NextResponse.json({ code: -1, message: "uid 无效" }, { status: 400 });
    }

    const config = await readAdminConfig();
    if (!config?.recommended_anchors) {
      return NextResponse.json({ code: -1, message: "无推荐主播列表" }, { status: 404 });
    }

    const anchor = config.recommended_anchors.find((a) => a.uid === uid);
    if (!anchor) {
      return NextResponse.json({ code: -1, message: "主播不存在" }, { status: 404 });
    }

    anchor.click_count = (anchor.click_count || 0) + 1;
    await writeAdminConfig(config);

    return NextResponse.json({ code: 0, data: { click_count: anchor.click_count } });
  } catch (e) {
    return NextResponse.json(
      { code: -1, message: "服务器错误: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 },
    );
  }
}
