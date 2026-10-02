import { NextResponse } from "next/server";
import { readAdminConfig } from "@/lib/admin-config";
import { incrementAnchorClick } from "@/lib/anchor-clicks";

export const dynamic = "force-dynamic";

/**
 * POST /api/recommended-anchors/click
 * body: { uid: number }
 * 递增该主播的全局点击次数（所有用户共享、累计）。
 * 计数存于独立的 .data/anchor-clicks.json（见 anchor-clicks.ts），
 * 不写 admin-config.json，因此 admin 保存配置不会清空计数。
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const uid = Number(body?.uid);
    if (!uid || uid <= 0) {
      return NextResponse.json({ code: -1, message: "uid 无效" }, { status: 400 });
    }

    const config = await readAdminConfig();
    const anchor = config?.recommended_anchors?.find((a) => a.uid === uid);
    if (!anchor) {
      return NextResponse.json({ code: -1, message: "主播不存在" }, { status: 404 });
    }

    const click_count = await incrementAnchorClick(uid, anchor.click_count || 0);

    return NextResponse.json({ code: 0, data: { click_count } });
  } catch (e) {
    return NextResponse.json(
      { code: -1, message: "服务器错误: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 },
    );
  }
}
