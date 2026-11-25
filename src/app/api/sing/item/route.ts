import { NextResponse } from "next/server";
import { isValidUid, readProfile, writeProfile } from "@/lib/sing/store";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/sing/item
 * body: { uid, kind: "song" | "playlist", platform?, id?, link?, index? }
 *
 * 删除单曲或整个歌单。优先按 platform+id / link 定位，其次按下标。
 */
export async function DELETE(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体不是合法 JSON", data: null }, { status: 400 });
  }
  const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
  const kind = body?.kind;
  if (!isValidUid(uid)) {
    return NextResponse.json({ code: 400, message: "uid 无效", data: null }, { status: 400 });
  }
  if (kind !== "song" && kind !== "playlist") {
    return NextResponse.json({ code: 400, message: "kind 必须是 song 或 playlist", data: null }, { status: 400 });
  }

  const profile = await readProfile(uid);
  if (!profile) {
    return NextResponse.json({ code: 404, message: "该 uid 还没有歌单", data: null }, { status: 404 });
  }

  let removed = false;
  if (kind === "song") {
    const platform = typeof body?.platform === "string" ? body.platform : "";
    const id = body?.id != null ? String(body.id) : "";
    let index = Number.isInteger(body?.index) ? Number(body.index) : -1;
    if (index < 0 && platform && id) {
      index = profile.songs.findIndex((s) => s.song.platform === platform && s.song.id === id);
    }
    if (index >= 0 && index < profile.songs.length) {
      profile.songs.splice(index, 1);
      removed = true;
    }
  } else {
    const link = typeof body?.link === "string" ? body.link : "";
    let index = Number.isInteger(body?.index) ? Number(body.index) : -1;
    if (index < 0 && link) index = profile.playlists.findIndex((p) => p.link === link);
    if (index >= 0 && index < profile.playlists.length) {
      profile.playlists.splice(index, 1);
      removed = true;
    }
  }

  if (removed) await writeProfile(profile);
  return NextResponse.json({
    code: 0,
    message: removed ? "ok" : "没有找到要删除的条目",
    data: { profile, removed },
  });
}
