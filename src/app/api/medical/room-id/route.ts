import { NextRequest, NextResponse } from "next/server";
import { fetchRoomInfoByUid } from "@/lib/bili-room";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical/room-id?mid=<uid>
 * 返回直播间 roomid / roomStatus。B站主接口对机房 IP 风控 412 时会自动走兜底接口
 * （见 bili-room.ts），不再把风控失败误报成"查不到房间"。
 */
export async function GET(request: NextRequest) {
  const mid = Number((request.nextUrl.searchParams.get("mid") ?? "").replace(/[^\d]/g, ""));
  if (!mid) {
    return NextResponse.json({ code: -1, message: "缺少 mid 参数" }, { status: 400 });
  }

  const { ok, room } = await fetchRoomInfoByUid(mid);
  if (!ok) {
    return NextResponse.json({ code: -1, message: "B站接口暂时不可用（风控或网络异常），请稍后重试" });
  }
  const roomid = room?.roomId ?? 0;
  return NextResponse.json({ code: 0, data: { roomid, roomStatus: roomid > 0 ? 1 : 0 } });
}
