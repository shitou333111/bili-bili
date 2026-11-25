import { NextResponse } from "next/server";
import { topHostMatches } from "@/lib/sing/similarity";
import { isValidUid, listProfiles, listProfilesByRole, readProfile, songCount } from "@/lib/sing/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/sing/matches?uid=xxx
 *
 * 返回与当前用户最匹配的主播列表：
 *  - 粉丝：所有主播类用户的歌单匹配度
 *  - 主播：其他主播类用户的匹配度（排除自己）
 * 匹配度 = 0.6×歌手 Jaccard + 0.4×(共同歌曲数/双方歌曲数几何均值)
 */
export async function GET(request: Request) {
  const uid = new URL(request.url).searchParams.get("uid") || "";
  if (!isValidUid(uid)) {
    return NextResponse.json({ code: 400, message: "uid 无效", data: null }, { status: 400 });
  }
  const me = await readProfile(uid);
  if (!me) {
    return NextResponse.json({ code: 0, message: "ok", data: { matches: [], profile: null, anchors: 0 } });
  }

  const anchors = await listProfilesByRole("anchor");
  const matches = topHostMatches(me, anchors, 10);

  // 主播用户额外返回一份「其他主播」总数，便于前端展示
  const all = await listProfiles();
  return NextResponse.json({
    code: 0,
    message: "ok",
    data: {
      matches,
      profile: { uid: me.uid, role: me.role, songCount: songCount(me), updatedAt: me.updatedAt },
      anchors: anchors.length,
      totalUsers: all.length,
    },
  });
}
