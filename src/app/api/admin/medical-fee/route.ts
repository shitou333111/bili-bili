import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readGroups, readGroupsWithMembers, writeGroups } from "@/lib/medical-fee-store";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

/** GET /api/admin/medical-fee —— 微信群配置 + 各群已登记人数 */
export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const [groups, withMembers] = await Promise.all([readGroups(), readGroupsWithMembers()]);
  const counts = new Map(withMembers.map((g) => [g.id, g.members.length]));
  return NextResponse.json({
    code: 0,
    data: {
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        image: g.image,
        memberCount: counts.get(g.id) ?? 0,
      })),
    },
  });
}

/** POST /api/admin/medical-fee —— 保存微信群配置（名称 + 截图 URL） */
export async function POST(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求格式错误" }, { status: 400 });
  }
  const groups = await writeGroups((body as Record<string, unknown>)?.groups);
  return NextResponse.json({ code: 0, message: "配置已保存", data: { groups } });
}
