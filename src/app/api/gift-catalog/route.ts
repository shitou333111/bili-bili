import { NextResponse } from "next/server";
import { ensureGiftCatalogLoaded, getGiftCatalog, getGiftList } from "@/lib/gift-catalog";

export const dynamic = "force-dynamic";

/**
 * 返回礼物目录（gift_id -> { name, img }）+ 完整礼物列表（list，含价格、角标等全部字段）。
 * 数据来自 B站 giftConfig API（无需登录），服务端 12 小时缓存。
 * 完整列表供模拟器等需要全量数据的场景使用，与全 APP 共用同一自动更新数据源。
 */
export async function GET() {
  try {
    await ensureGiftCatalogLoaded();
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
