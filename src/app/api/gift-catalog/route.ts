import { NextResponse } from "next/server";
import { ensureGiftCatalogLoaded, getGiftCatalog, getGiftList } from "@/lib/gift-catalog";

export const dynamic = "force-dynamic";

/**
 * 返回礼物目录（gift_id -> { name, img }）+ 完整礼物列表（list，含价格、角标等全部字段）。
 * 数据来自 B站 giftConfig API（无需登录），服务端 12 小时缓存。
 * 完整列表供模拟器等需要全量数据的场景使用，与全 APP 共用同一自动更新数据源。
 */
export async function GET(request: Request) {
  try {
    await ensureGiftCatalogLoaded();
    // compact=1：admin 后台只需要「名称/图标」与礼物单价，不需要完整礼物列表。
    // 完整 list 约 1.6MB（整个响应 1.7MB+），会拖慢 admin 首屏；这里在服务端算好单价映射后只返回精简数据。
    if (new URL(request.url).searchParams.get("compact") === "1") {
      const prices: Record<number, number> = {};
      for (const g of getGiftList()) {
        if (g?.id && g.coin_type === "gold" && g.price) {
          prices[Number(g.id)] = Math.round(Number(g.price) / 100);
        }
      }
      return NextResponse.json(
        { code: 0, message: "ok", data: { gifts: getGiftCatalog(), prices } },
        { status: 200 },
      );
    }
    const data = {
      gifts: getGiftCatalog(),
      list: getGiftList(),
    };
    return NextResponse.json({ code: 0, message: "ok", data }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { code: 500, message: `获取礼物目录失败: ${err?.message || String(err)}`, data: null },
      { status: 500 },
    );
  }
}
