import { NextResponse } from "next/server";
import { parseLink } from "@/lib/sing/music-service";
import { isValidUid, readProfile, writeProfile } from "@/lib/sing/store";
import { platformLabel, type PlaylistItem, type SingProfile, type SingRole } from "@/lib/sing/types";

export const dynamic = "force-dynamic";

const MAX_PLAYLISTS = 50;
const MAX_SONG_ITEMS = 2000;

function errorMessage(error?: string): string {
  switch (error) {
    case "service_unavailable":
      return "解析服务未就绪，请先在服务端运行 npm run build:music-service";
    case "unsupported_platform":
      return "暂不支持该平台的链接";
    case "no_songs":
      return "没有解析到歌曲（歌单可能为空或需要登录）";
    case "timeout":
      return "解析超时，请稍后重试";
    case "empty_url":
      return "请输入歌单或歌曲链接";
    default:
      return `解析失败：${error || "未知错误"}`;
  }
}

/**
 * POST /api/sing/import
 * body: { uid, url, role? }
 *
 * 解析链接并按类型追加：
 *  - 单曲 → songs 最前面（歌曲形式添加的排在上方）
 *  - 歌单/专辑 → playlists（同链接视为重新导入，替换歌曲）
 * 返回 { profile, imported }
 */
export async function POST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体不是合法 JSON", data: null }, { status: 400 });
  }
  const uid = typeof body?.uid === "string" ? body.uid.trim() : "";
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!isValidUid(uid)) {
    return NextResponse.json({ code: 400, message: "uid 无效", data: null }, { status: 400 });
  }
  if (!url) {
    return NextResponse.json({ code: 400, message: "请输入歌单或歌曲链接", data: null }, { status: 400 });
  }
  const role: SingRole | undefined = body?.role === "anchor" ? "anchor" : body?.role === "fan" ? "fan" : undefined;

  const parsed = await parseLink(url);
  if (!parsed.ok || !parsed.platform || !parsed.songs?.length) {
    const status = parsed.error === "service_unavailable" ? 503 : 400;
    return NextResponse.json(
      { code: -1, message: errorMessage(parsed.error), data: { error: parsed.error, platform: parsed.platform } },
      { status },
    );
  }

  let profile = await readProfile(uid);
  if (!profile) {
    profile = { uid, role: role ?? "fan", songs: [], playlists: [], updatedAt: Date.now() };
  } else if (role) {
    profile.role = role;
  }

  const songs = parsed.songs;
  let imported: Record<string, unknown>;
  let deduped = false;

  if (parsed.kind === "song" && songs.length === 1) {
    const song = songs[0];
    const exists = profile.songs.some((s) => s.song.platform === song.platform && s.song.id === song.id);
    if (exists) {
      deduped = true;
    } else {
      profile.songs.unshift({ kind: "song", song, link: url, addedAt: Date.now() });
      if (profile.songs.length > MAX_SONG_ITEMS) profile.songs.length = MAX_SONG_ITEMS;
    }
    imported = { kind: "song", platform: song.platform, name: song.name, count: 1 };
  } else {
    const item: PlaylistItem = {
      kind: "playlist",
      platform: parsed.platform,
      link: url,
      title: parsed.name || `${platformLabel(parsed.platform)}歌单`,
      cover: parsed.cover,
      songs,
      updatedAt: Date.now(),
    };
    const index = profile.playlists.findIndex((p) => p.link === url);
    if (index >= 0) {
      profile.playlists[index] = item;
      deduped = true;
    } else if (profile.playlists.length >= MAX_PLAYLISTS) {
      return NextResponse.json({ code: 400, message: `最多导入 ${MAX_PLAYLISTS} 个歌单`, data: { profile } }, { status: 400 });
    } else {
      profile.playlists.push(item);
    }
    imported = {
      kind: parsed.kind || "playlist",
      platform: parsed.platform,
      name: item.title,
      count: songs.length,
    };
  }

  await writeProfile(profile);
  return NextResponse.json({ code: 0, message: "ok", data: { profile, imported, deduped } });
}

export type { SingProfile };
