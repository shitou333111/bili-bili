import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readGlobalSwitch, writeGlobalSwitch } from "@/lib/global-switch";

export const dynamic = "force-dynamic";

/** 管理后台：读取全局访问开关状态（disabled=true 时 /api/* 会被 middleware 返回 503） */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const state = await readGlobalSwitch();
  return NextResponse.json({ code: 0, data: { disabled: state.disabled } });
}

/**
 * 管理后台：设置全局访问开关。
 * - disabled=true：切断所有客户端对 /api/* 的访问（放行 /api/admin/*，后台仍可用）；
 * - disabled=false：恢复访问。
 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.disabled !== "boolean") {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }
  const state = await writeGlobalSwitch(body.disabled);
  return NextResponse.json({ code: 0, data: { disabled: state.disabled } });
}
