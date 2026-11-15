import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readGlobalSwitch, writeGlobalSwitch } from "@/lib/global-switch";

export const dynamic = "force-dynamic";

/**
 * 管理后台：读取全局访问开关状态。
 * - disabled=true 时 /api/* 会被 middleware 返回 503；
 * - webDisabled=true 时浏览器访问网页端页面会返回「请下载客户端」提示页。
 */
export async function GET(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const state = await readGlobalSwitch();
  return NextResponse.json({ code: 0, data: { disabled: state.disabled, webDisabled: state.webDisabled } });
}

/**
 * 管理后台：设置全局访问开关（可只传其中一个字段，未传的保持原值）。
 * - disabled=true：切断所有客户端对 /api/* 的访问（放行 /api/admin/*，后台仍可用）；
 * - webDisabled=true：关闭网页端（提示下载客户端），客户端不受影响。
 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.disabled !== "boolean" && typeof body?.webDisabled !== "boolean") {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }
  const state = await writeGlobalSwitch({
    disabled: typeof body?.disabled === "boolean" ? body.disabled : undefined,
    webDisabled: typeof body?.webDisabled === "boolean" ? body.webDisabled : undefined,
  });
  return NextResponse.json({ code: 0, data: { disabled: state.disabled, webDisabled: state.webDisabled } });
}
