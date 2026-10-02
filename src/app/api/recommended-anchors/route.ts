import { NextResponse } from "next/server";
import { readAdminConfig, type RecommendedAnchor } from "@/lib/admin-config";
import { readAnchorClicks } from "@/lib/anchor-clicks";

export const dynamic = "force-dynamic";

/** 公开API：返回管理员配置中 visible=true 的推荐主播列表，按 order 升序排序；
 *  点击次数来自全局计数文件（所有用户共享累计）。 */
export async function GET() {
  const config = await readAdminConfig();
  const clicks = await readAnchorClicks();
  const all = config?.recommended_anchors ?? [];
  const visible: RecommendedAnchor[] = all
    .filter((a) => a.visible && a.uid > 0 && a.uname)
    .sort((a, b) => a.order - b.order)
    // 计数文件尚无该 uid 时回退旧配置里的内联值，避免历史计数丢失
    .map((a) => ({ ...a, click_count: clicks[String(a.uid)] ?? a.click_count ?? 0 }));
  return NextResponse.json({ code: 0, data: visible });
}
