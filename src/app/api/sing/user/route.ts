import { NextResponse } from "next/server";
import { isValidUid, readProfile, writeProfile } from "@/lib/sing/store";
import type { SingProfile, SingRole } from "@/lib/sing/types";

export const dynamic = "force-dynamic";

/**
 * GET  /api/sing/user?uid=xxx  → 读取 profile（不存在时 profile=null）
 * POST /api/sing/user          → 保存角色/昵称（不改动歌曲）
 *
 * 无鉴权：按需求由用户输入自己的 B 站 uid 认领歌单。
 */
export async function GET(request: Request) {
  const uid = new URL(request.url).searchParams.get("uid") || "";
  if (!isValidUid(uid)) {
    return NextResponse.json({ code: 400, message: "uid 无效", data: null }, { status: 400 });
  }
  const profile = await readProfile(uid);
  return NextResponse.json({ code: 0, message: "ok", data: { profile } });
}

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
  const role: SingRole | undefined = body?.role === "anchor" ? "anchor" : body?.role === "fan" ? "fan" : undefined;
  const uname = typeof body?.uname === "string" ? body.uname.trim().slice(0, 60) : undefined;

  let profile = await readProfile(uid);
  if (!profile) {
    profile = {
      uid,
      uname: uname || undefined,
      role: role ?? "fan",
      songs: [],
      playlists: [],
      updatedAt: Date.now(),
    };
  } else {
    if (role) profile.role = role;
    if (uname !== undefined) profile.uname = uname || undefined;
  }
  await writeProfile(profile);
  return NextResponse.json({ code: 0, message: "ok", data: { profile } });
}

export type { SingProfile };
