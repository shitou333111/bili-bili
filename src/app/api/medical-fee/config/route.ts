import { NextRequest, NextResponse } from "next/server";
import { FEE_VALID_HOURS } from "@/lib/medical-fee-calc";
import { readGroupsWithMembers, readMemberGroupIds } from "@/lib/medical-fee-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical-fee/config?uid=<uid>
 * 返回微信群列表（含编号、截图、成员数）以及当前 UID 已登记的群。
 */
export async function GET(request: NextRequest) {
  const uid = Number((request.nextUrl.searchParams.get("uid") ?? "").replace(/[^\d]/g, "")) || 0;
  const [groups, mine] = await Promise.all([
    readGroupsWithMembers(),
    uid > 0 ? readMemberGroupIds(uid) : Promise.resolve([] as string[]),
  ]);
  return NextResponse.json({
    code: 0,
    data: {
      validHours: FEE_VALID_HOURS,
      membership: mine,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        index: g.index,
        image: g.image ?? "",
        memberCount: g.members.length,
        members: g.members,
        mine: mine.includes(g.id),
      })),
    },
  });
}
