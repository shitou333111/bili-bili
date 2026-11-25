import { NextResponse } from "next/server";
import { refreshProfile } from "@/lib/sing/refresh";
import { isValidUid, readProfile } from "@/lib/sing/store";

export const dynamic = "force-dynamic";

/**
 * POST /api/sing/refresh
 * body: { uid }
 *
 * 重新向各音乐平台解析该 uid 的所有歌单 / 单曲（/sing 页面每次打开都会调用）。
 * 单个链接失败不会整体失败，旧数据保留并在歌单上记 lastError。
 */
export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体不是合法 JSON", data: null }, { status: 400 });
  }
  const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
  if (!isValidUid(uid)) {
    return NextResponse.json({ code: 400, message: "uid 无效", data: null }, { status: 400 });
  }

  const existing = await readProfile(uid);
  if (!existing) {
    return NextResponse.json({ code: 404, message: "该 uid 还没有歌单", data: { profile: null } }, { status: 404 });
  }

  try {
    const profile = await refreshProfile(uid);
    return NextResponse.json({ code: 0, message: "ok", data: { profile } });
  } catch (err: any) {
    return NextResponse.json(
      { code: 500, message: `刷新失败：${err?.message || String(err)}`, data: { profile: existing } },
      { status: 500 },
    );
  }
}
