import { NextResponse } from "next/server";
import { findOnPlaybackPlatform, pickSong, STRONG_SCORE } from "@/lib/sing/match";
import {
  musicServiceAvailable,
  probeMusicStream,
  searchCapabilities,
  searchSongs,
} from "@/lib/sing/music-service";
import { refreshProfile } from "@/lib/sing/refresh";
import { allSongs, isValidUid, readProfile } from "@/lib/sing/store";
import {
  isPlaybackTarget,
  type PlaybackPlatform,
  type PlaybackTarget,
  type ResolveResult,
  type SongRef,
} from "@/lib/sing/types";

export const dynamic = "force-dynamic";

const SPECIAL_RANDOM = new Set(["随机", "随便", "随机一首", "random"]);
const SPECIAL_ANCHOR = new Set(["主播", "主播唱", "点主播"]);

/** 软件内播放：原平台取不到音频时的换源顺序 */
const INAPP_SWITCH_ORDER: PlaybackPlatform[] = ["netease", "qq", "kugou", "soda"];

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
  target: PlaybackTarget,
  via: "user" | "anchor" | "search",
  matchReason: string,
): Promise<NextResponse> {
  if (target === "inapp") return finalizeInApp(origin, via, matchReason);
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

/**
 * 软件内播放：优先用原平台精确取流；无版权 / 无权益 / 取流失败时自动换源，
 * 换到的平台与原始平台都写进结果，客户端据此在界面和点歌记录里标注「已换源」。
 */
async function finalizeInApp(
  origin: SongRef,
  via: "user" | "anchor" | "search",
  matchReason: string,
): Promise<NextResponse> {
  const base: ResolveResult = {
    status: "ok",
    inapp: true,
    originPlatform: origin.platform,
    matchReason,
    matchedName: origin.name,
    matchedArtists: origin.artists,
  };
  // 试听片段（汽水会员曲目常见）只作为兜底：先继续找能完整播放的音源
  let previewHit: { song: SongRef; probe: { quality?: string }; switched: boolean } | null = null;

  const direct = await probeMusicStream(origin);
  if (direct.ok && !direct.preview) {
    return ok({ ...base, song: origin, via, quality: direct.quality, preview: false });
  }
  if (direct.ok && direct.preview) {
    previewHit = { song: origin, probe: direct, switched: false };
  }
  if (direct.error === "service_unavailable") {
    return ok({ ...base, status: "service_unavailable", message: "service_unavailable" });
  }
  for (const p of INAPP_SWITCH_ORDER) {
    if (p === origin.platform) continue;
    const converted = await findOnPlaybackPlatform(origin, p);
    if (!converted) continue;
    const target = { ...converted, platform: p };
    const probe = await probeMusicStream(target);
    if (!probe.ok) continue;
    if (!probe.preview) {
      return ok({
        ...base,
        song: target,
        via,
        switched: true,
        switchedFrom: origin.platform,
        quality: probe.quality,
        preview: false,
      });
    }
    if (!previewHit) previewHit = { song: target, probe, switched: true };
  }
  if (previewHit) {
    return ok({
      ...base,
      song: previewHit.song,
      via,
      switched: previewHit.switched,
      switchedFrom: previewHit.switched ? origin.platform : undefined,
      quality: previewHit.probe.quality,
      preview: true,
    });
  }
  return ok({ ...base, status: "unmatched", message: "stream_unavailable" });
}

/**
 * 首轮搜索命中不强时，用拆出的单个关键词补搜：
 * 「七里香 周杰伦」→ 再搜「七里香」「周杰伦」，合并后再按完整关键词评分。
 * 这样空格后是歌手时能拿到更好的候选，是「钢琴版」这类歌名关键词时也不会乱搜。
 */
async function searchWithFallback(platform: PlaybackPlatform, keyword: string): Promise<SongRef[]> {
  const first = await searchSongs(platform, keyword, 10);
  const picked = pickSong(keyword, first);
  if (picked && picked.score >= STRONG_SCORE + 0.1) return first;
  const tokens = [...new Set(keyword.split(/[\s,，、/|]+/).filter((t) => t.length >= 2))].slice(0, 2);
  if (tokens.length <= 1) return first;
  const more = await Promise.all(tokens.map((t) => searchSongs(platform, t, 10)));
  return first.concat(...more);
}

/**
 * 软件内播放 + 粉丝没有歌单：逐个平台搜索，取第一个能真正取到音频的结果。
 * 汽水在服务器上通常不能搜索（需要本机签名器），由 canSearchOn 跳过。
 */
async function inAppSearch(keyword: string): Promise<NextResponse> {
  if (!(await musicServiceAvailable())) {
    return ok({ status: "service_unavailable", message: "service_unavailable" });
  }
  let previewHit: { song: SongRef; reason: string; probe: { quality?: string } } | null = null;
  for (const p of INAPP_SWITCH_ORDER) {
    if (!(await canSearchOn(p))) continue;
    const results = await searchWithFallback(p, keyword);
    const picked = pickSong(keyword, results);
    if (!picked) continue;
    const target = { ...picked.song, platform: p };
    const probe = await probeMusicStream(target);
    if (!probe.ok) continue;
    if (!probe.preview) {
      return ok({
        status: "ok",
        inapp: true,
        song: target,
        via: "search",
        matchReason: picked.reason,
        matchedName: picked.song.name,
        matchedArtists: picked.song.artists,
        quality: probe.quality,
        preview: false,
      });
    }
    if (!previewHit) previewHit = { song: target, reason: picked.reason, probe };
  }
  if (previewHit) {
    return ok({
      status: "ok",
      inapp: true,
      song: previewHit.song,
      via: "search",
      matchReason: previewHit.reason,
      matchedName: previewHit.song.name,
      matchedArtists: previewHit.song.artists,
      quality: previewHit.probe.quality,
      preview: true,
    });
  }
  return ok({ status: "unmatched", message: "no_match" });
}

/** 在目标平台直接搜索（可用性检查 + 结果），失败时给出对应的错误响应 */
async function searchOnTarget(
  target: PlaybackPlatform,
  keyword: string,
): Promise<{ error: NextResponse } | { results: SongRef[] }> {
  if (!(await musicServiceAvailable())) {
    return { error: ok({ status: "service_unavailable", message: "service_unavailable" }) };
  }
  if (!(await canSearchOn(target))) {
    return { error: ok({ status: "unmatched", message: "search_unavailable" }) };
  }
  return { results: await searchWithFallback(target, keyword) };
}

/** 把搜索命中的歌曲组装成「直接播放」结果 */
function searchHit(picked: { song: SongRef; reason: string }, target: PlaybackPlatform): NextResponse {
  return ok({
    status: "ok",
    song: { ...picked.song, platform: target },
    via: "search",
    matchReason: picked.reason,
    matchedName: picked.song.name,
    matchedArtists: picked.song.artists,
  });
}

/** 歌单未命中时重新向音乐平台拉一次歌单的冷却：同一用户 60 秒内最多刷新一次 */
const REFRESH_COOLDOWN_MS = 60_000;
const lastRefreshAt = new Map<string, number>();

/**
 * 重新解析该用户的歌单（粉丝可能刚在音乐平台加了歌，服务器缓存的还是旧列表）。
 * 冷却期内直接返回 null，避免每条没命中的点歌都去打平台接口。
 */
async function refreshPool(uid: string): Promise<SongRef[] | null> {
  const now = Date.now();
  if (now - (lastRefreshAt.get(uid) || 0) < REFRESH_COOLDOWN_MS) return null;
  lastRefreshAt.set(uid, now);
  try {
    const profile = await refreshProfile(uid);
    return profile ? allSongs(profile) : null;
  } catch {
    return null;
  }
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
  const target: PlaybackTarget = isPlaybackTarget(body?.platform) ? body.platform : "netease";

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
    if (target === "inapp") return inAppSearch(rawKeyword);
    const searched = await searchOnTarget(target, rawKeyword);
    if ("error" in searched) return searched.error;
    const picked = pickSong(rawKeyword, searched.results);
    if (!picked) {
      return ok({
        status: "unmatched",
        message: "search_no_match",
        candidates: searched.results.slice(0, 5).map((s) => `${s.name} - ${s.artists.join("/")}`),
      });
    }
    return searchHit(picked, target);
  }

  const picked = pickSong(rawKeyword, pool);
  if (picked) return finalize(picked.song, target, "user", picked.reason);

  // 歌单里没有 → 先刷新一遍歌单再匹配（粉丝可能刚加了这首歌，服务器还是旧列表），
  // 刷新后仍未命中才在目标平台搜索最相近的一首。搜索也无结果时返回 no_match，
  // 客户端刷新歌单后会再试一次。
  const refreshed = await refreshPool(uid);
  if (refreshed) {
    const again = pickSong(rawKeyword, refreshed);
    if (again) return finalize(again.song, target, "user", again.reason);
  }

  if (target === "inapp") return inAppSearch(rawKeyword);
  const fallback = await searchOnTarget(target, rawKeyword);
  if ("error" in fallback) return fallback.error;
  const alt = pickSong(rawKeyword, fallback.results);
  if (alt) return searchHit(alt, target);
  return ok({ status: "unmatched", message: "no_match" });
}
