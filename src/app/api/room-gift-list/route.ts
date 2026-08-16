import { NextResponse } from "next/server";
import { ensureRoomGiftListLoaded, getRoomGiftData } from "@/lib/room-gift-list";

export const dynamic = "force-dynamic";

/**
 * 返回直播间礼物面板数据（data.gift_data：room_gift_list.gold_list 原始顺序 + tab_list）。
 * 数据来自 B站 roomGiftList API（无需登录），服务端 12 小时缓存。
 * 供 Web 模式模拟器"礼物"选项卡使用；Tauri 模式由本地客户端直连并缓存到 roomGiftList.json。
 */
export async function GET() {
  try {
    await ensureRoomGiftListLoaded();
    const giftData = getRoomGiftData();
    if (!giftData) {
      return NextResponse.json(
        { code: -1, message: "直播间礼物面板数据不可用", data: null },
        { status: 502 },
      );
    }
    return NextResponse.json({ code: 0, message: "ok", data: { gift_data: giftData } }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { code: 500, message: `获取直播间礼物面板失败: ${err?.message || String(err)}`, data: null },
      { status: 500 },
    );
  }
}
