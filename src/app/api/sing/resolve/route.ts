import { NextResponse } from "next/server";
import { findOnPlaybackPlatform, pickSong } from "@/lib/sing/match";
import { musicServiceAvailable, searchCapabilities, searchSongs } from "@/lib/sing/music-service";
import { allSongs, isValidUid, readProfile } from "@/lib/sing/store";
import { isPlaybackPlatform, type PlaybackPlatform, type ResolveResult, type SongRef } from "@/lib/sing/types";

export const dynamic = "force-dynamic";

const SPECIAL_RANDOM = new Set(["随机", "随便", "随机一首", "random"]);
const SPECIAL_ANCHOR = new Set(["主播", "主播唱", "点主播"]);

function ok(result: ResolveResult) {
  return NextResponse.json({ code: 0, message: result.message || result.status, data: result });
}

/**
 * 目标平台能否搜索（跨平台转换/无歌单直接点歌都依赖搜索）。
 * 汽水搜索要求本机装有汽水客户端（本机签名器），服务器上没有 → 明确告知不可搜索，
 * 而不是让观众看到「没搜到这首歌」这种误判。
 */
async function canSearchOn(platform: PlaybackPlatform): Promise<boolean> {
  const caps = await searchCapabilities();
  return caps[platform] !== false;
}

/** 把命中歌曲转到目标播放平台并组装结果 */
async function finalize(
  origin: SongRef,
  target: PlaybackPlatform,
  via: "user" | "anchor" | "search",
  matchReason: string,
): Promise<NextResponse> {
  const base: ResolveResult = {
    status: "ok",
    originPlatform: origin.platform,
    matchReason,
    matchedName: origin.name,
    matchedArtists: origin.artists,
  };
  if (origin.platform === target) {
    // 同平台也要补齐播放专用 id（QQ 歌单只带字母数字 SongMID，客户端只认十进制 songid）
    if (!(await musicServiceAvailable())) return ok({ ...base, song: origin, via });
    const resolved = (await findOnPlaybackPlatform(origin, target)) || origin;
    return ok({ ...base, song: resolved, via });
  }
  if (!(await musicServiceAvailable())) {
    return ok({ ...base, status: "service_unavailable", message: "service_unavailable" });
  }
  if (!(await canSearchOn(target))) {
    return ok({ ...base, status: "unmatched", message: "search_unavailable" });
  }
  const converted = await findOnPlaybackPlatform(origin, target);
  if (converted) return ok({ ...base, song: converted, via });
  return ok({ ...base, status: "unmatched", message: "cross_platform_failed" });
}

function pickRandom<T>(list: T[]): T | null {
  if (list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * POST /api/sing/resolve
 * body: { anchorUid, uid, keyword, platform }
 *
 * 点歌解析：特殊词（随机 / 主播）→ 用户歌单匹配 → 跨平台转换；
 * 用户没有歌单时直接在目标平台搜索。
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
  const anchorUid = typeof body?.anchorUid === "string" ? body.anchorUid.trim() : "";
  const rawKeyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  const target: PlaybackPlatform = isPlaybackPlatform(body?.platform) ? body.platform : "netease";

  if (!rawKeyword) return ok({ status: "unmatched", message: "empty_keyword" });

  // 去掉空格与末尾标点后判断特殊词（"点歌 随机" / "点歌 主播"）
  const compact = rawKeyword.replace(/\s+/g, "").replace(/[!！。.？?]+$/g, "").toLowerCase();

  if (SPECIAL_RANDOM.has(compact)) {
    const user = await readProfile(uid);
    const origin = user ? pickRandom(allSongs(user)) : null;
    if (!origin) return ok({ status: "no_list", message: "no_user_list" });
    return finalize(origin, target, "user", "random");
  }

  if (SPECIAL_ANCHOR.has(compact)) {
    if (!isValidUid(anchorUid)) return ok({ status: "unmatched", message: "no_anchor" });
    const anchor = await readProfile(anchorUid);
    const origin = anchor ? pickRandom(allSongs(anchor)) : null;
    if (!origin) return ok({ status: "no_list", message: "anchor_no_list" });
    return finalize(origin, target, "anchor", "random");
  }

  const user = await readProfile(uid);
  const pool = user ? allSongs(user) : [];

  // 没有歌单 → 直接在目标平台搜索
  if (pool.length === 0) {
    if (!(await musicServiceAvailable())) {
      return ok({ status: "service_unavailable", message: "service_unavailable" });
    }
    if (!(await canSearchOn(target))) {
      return ok({ status: "unmatched", message: "search_unavailable" });
    }
    const results = await searchSongs(target, rawKeyword, 10);
    const picked = pickSong(rawKeyword, results);
    if (!picked) {
      return ok({
        status: "unmatched",
        message: "search_no_match",
        candidates: results.slice(0, 5).map((s) => `${s.name} - ${s.artists.join("/")}`),
      });
    }
    return ok({
      status: "ok",
      song: { ...picked.song, platform: target },
      via: "search",
      matchReason: picked.reason,
      matchedName: picked.song.name,
      matchedArtists: picked.song.artists,
    });
  }

  const picked = pickSong(rawKeyword, pool);
  if (!picked) {
    return ok({ status: "unmatched", message: "no_match" });
  }
  return finalize(picked.song, target, "user", picked.reason);
}
