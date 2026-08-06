import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { getSynthesisActivityInfo } from "@/lib/user-data";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const activityId = url.searchParams.get("activity_id");
  if (!activityId) {
    return NextResponse.json({ code: 400, message: "missing activity_id" }, { status: 400 });
  }

  // 从本地缓存的活动信息 JSON 中读取 name（与页面卡片显示的名称一致）
  const info = await getSynthesisActivityInfo(activityId);
  return NextResponse.json({
    code: 0,
    data: {
      name: info?.name ?? "",
      icon: info?.icon ?? "",
    },
  });
}