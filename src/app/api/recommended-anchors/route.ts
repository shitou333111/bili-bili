import { NextResponse } from "next/server";
import { readAdminConfig, type RecommendedAnchor } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

/** 公开API：返回管理员配置中 visible=true 的推荐主播列表，按 order 升序排序 */
export async function GET() {
  const config = await readAdminConfig();
  const all = config?.recommended_anchors ?? [];
  const visible: RecommendedAnchor[] = all
    .filter((a) => a.visible && a.uid > 0 && a.uname)
    .sort((a, b) => a.order - b.order);
  return NextResponse.json({ code: 0, data: visible });
}
