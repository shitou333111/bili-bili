import { NextResponse } from "next/server";
import { ensureGiftCatalogLoaded, getGiftCatalog } from "@/lib/gift-catalog";

export const dynamic = "force-dynamic";

/**
 * 返回礼物图标目录（gift_id -> { name, img }）。
 * 数据来自 B站 giftConfig API（无需登录），服务端 12 小时缓存。
 * 仅返回图标信息，不含价格。
 */
export async function GET() {
  try {
    await ensureGiftCatalogLoaded();
    const data = getGiftCatalog();
    return NextResponse.json({ code: 0, message: "ok", data }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { code: 500, message: `获取礼物目录失败: ${err?.message || String(err)}`, data: null },
      { status: 500 },
    );
  }
}
