/**
 * 点歌听 · 弹幕关键词 → 歌曲匹配
 *
 * 规则（与产品需求一致）：
 * 1. 歌名是主信号：完全相同 > 包含 > 字二元组相似；
 * 2. 歌名多匹配时，query 里若含歌手 / 专辑名则加分消歧；
 * 3. query 本身是歌手名（或与歌手名高度相似）时，随机播放该歌手的一首歌；
 * 4. 都没有 → 返回 null（由调用方触发歌单刷新 / 直接平台搜索）。
 */
import {
  diceSimilarity,
  fold,
  normalizeArtist,
  normalizeTitle,
} from "./normalize";
import { searchSongs, parseLink } from "./music-service";
import type { PlaybackPlatform, SongRef } from "./types";

export type MatchReason = "exact" | "contains" | "fuzzy" | "artist";

export interface SongMatch {
  song: SongRef;
  score: number;
  reason: MatchReason;
  /** 在输入列表中的位置：同分时保留平台搜索排序（官方/热门通常在前） */
  rank?: number;
}

const TITLE_THRESHOLD = 0.55;
/** 认为是「直接命中歌名」的分数门槛 */
export const STRONG_SCORE = 0.8;
/** 版本标记（Live/伴奏/Remix…）：原版优先于各种改编版本 */
const VERSION_MARKER =
  /(live|现场|演唱会|concert|纯享|伴奏|remaster|feat|ft\.|remix|dj|cover|翻唱版|翻唱|抖音|无损|高音质|完整版|片段|副歌|铃声|official|mv|高清|原唱|女声版|男声版)/i;

function hasVersionMarker(name: string): boolean {
  return VERSION_MARKER.test(fold(name));
}

/** 原始标题归一（只统一大小写/全半角/去标点，保留 Live、伴奏等版本词） */
function rawTitle(input: string): string {
  return fold(input).replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 查询词分词：按空白/标点切分（中文不切分），用于「额外关键词」覆盖率 */
function words(input: string): string[] {
  return fold(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 1);
}

/** 弹幕关键词的切分假设：整串 + 「歌名部分 / 歌手部分」二段切分 */
export interface QueryIntent {
  /** 当作歌名/关键词的部分 */
  title: string;
  /** 当作歌手的部分（没有则为整串假设） */
  artist?: string;
  /** 用户输入的完整串 */
  raw: string;
}

/**
 * 生成切分假设。空格后的内容不一定是歌手（可能是「钢琴版」这类歌名关键词），
 * 所以这里只提出假设，最终由候选歌曲的歌手字段来验证。
 */
export function buildQueryIntents(query: string): QueryIntent[] {
  const raw = query.trim();
  if (!raw) return [];
  const intents: QueryIntent[] = [{ title: raw, raw }];
  const tokens = raw.split(/[\s,，、/|]+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return intents;
  for (let k = 1; k < tokens.length; k++) {
    const artist = tokens.slice(k).join(" ");
    // 版本词（Live / 伴奏 / 钢琴版…）不是歌手
    if (VERSION_MARKER.test(fold(artist))) continue;
    intents.push({ title: tokens.slice(0, k).join(" "), artist, raw });
  }
  return intents;
}

/**
 * 按某个切分假设打分：歌手部分必须真的匹配候选的歌手，
 * 否则该假设不成立（例如「七里香 钢琴版」不会把「钢琴版」当歌手）。
 */
function scoreIntent(intent: QueryIntent, song: SongRef): SongMatch | null {
  const base = scoreSong(intent.artist ? intent.title : intent.raw, song);
  if (!base) return null;
  if (!intent.artist) return base;
  const hint = normalizeArtist(intent.artist);
  if (hint.length < 2) return null;
  const hit = song.artists.some((artist) => {
    const norm = normalizeArtist(artist);
    return norm === hint || (norm.length >= 2 && diceSimilarity(norm, hint) >= 0.85);
  });
  if (!hit) return null;
  return { ...base, score: Math.min(1, base.score + 0.25), reason: "artist" };
}

/** 所有切分假设取最高分（同一首歌只保留最高分） */
export function matchSongsByIntent(query: string, songs: SongRef[]): SongMatch[] {
  const best = new Map<string, SongMatch>();
  for (const intent of buildQueryIntents(query)) {
    songs.forEach((song, index) => {
      const m = scoreIntent(intent, song);
      if (!m) return;
      m.rank = index;
      const key = `${song.platform}:${song.id}`;
      const prev = best.get(key);
      if (!prev || m.score > prev.score) best.set(key, m);
    });
  }
  const out = [...best.values()];
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.song.name.length - b.song.name.length ||
      (b.song.album ? 1 : 0) - (a.song.album ? 1 : 0),
  );
  return out;
}

/**
 * 单首歌 vs 查询词打分。返回 null 表示低于阈值。
 */
export function scoreSong(query: string, song: SongRef): SongMatch | null {
  const qt = normalizeTitle(query);
  const nt = normalizeTitle(song.name);
  if (!qt || !nt) return null;
  const qRaw = rawTitle(query);
  const nRaw = rawTitle(song.name);

  let score = 0;
  let reason: MatchReason = "fuzzy";

  if (qRaw && qRaw === nRaw) {
    // 用户输入与歌名「原文」完全一致（含 Live / 伴奏等版本词）→ 最高优先级
    score = 1;
    reason = "exact";
  } else if (nt === qt) {
    score = 0.9;
    reason = "exact";
  } else if (qt.length >= 2 && nt.includes(qt)) {
    score = 0.82 + 0.13 * Math.min(1, qt.length / nt.length);
    reason = "contains";
  } else if (nt.length >= 3 && nt.length / qt.length >= 0.6 && qt.includes(nt)) {
    // 候选歌名只是查询词的一小部分时不算命中：
    // 「蒲公英的约定」不应匹配「约定」；真正的「歌名 歌手」由切分假设精确命中。
    score = 0.8;
    reason = "contains";
  } else {
    if (qt.length < 2) return null;
    const sim = diceSimilarity(qt, nt);
    if (sim < 0.45) return null;
    score = sim * 0.85;
  }

  // 「额外关键词」覆盖：query 里写到的版本词（Live 等）在歌名里也出现 → 更贴近用户意图。
  // 例：歌名「昨迟人 (Live)」对 query「昨迟人 Live」的覆盖率是 100%，「昨迟人」只有 50%。
  const toks = words(query);
  if (toks.length > 1) {
    const hit = toks.filter((t) => nRaw.includes(t)).length;
    score += 0.09 * (hit / toks.length);
  }

  // 歌手 / 专辑提示加分
  const qf = fold(query);
  const artistNorms = song.artists.map(normalizeArtist).filter((a) => a.length >= 2);
  if (artistNorms.some((a) => qf.includes(a))) score += 0.12;
  const album = song.album ? normalizeTitle(song.album) : "";
  if (album.length >= 2 && qt.includes(album)) score += 0.08;

  // 用户没点名版本时，原版优先于 Live / 伴奏 / Remix 等改编版本
  if (hasVersionMarker(song.name) && !hasVersionMarker(query)) score -= 0.06;

  score = Math.min(1, Math.round(Math.max(0, score) * 1000) / 1000);
  if (score < TITLE_THRESHOLD) return null;
  return { song, score, reason };
}

/** 对所有歌曲打分并按分数排序（按平台+id 去重） */
export function matchSongs(query: string, songs: SongRef[]): SongMatch[] {
  const seen = new Set<string>();
  const out: SongMatch[] = [];
  songs.forEach((song, index) => {
    const key = `${song.platform}:${song.id}`;
    if (seen.has(key)) return;
    const m = scoreSong(query, song);
    if (!m) return;
    seen.add(key);
    m.rank = index;
    out.push(m);
  });
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.song.name.length - b.song.name.length ||
      (b.song.album ? 1 : 0) - (a.song.album ? 1 : 0),
  );
  return out;
}

export interface ArtistIntent {
  artist: string;
  songs: SongRef[];
}

/** 判断 query 是否是某个歌手名（完全一致或高度相似），返回该歌手的歌 */
export function detectArtistIntent(query: string, songs: SongRef[]): ArtistIntent | null {
  const q = normalizeArtist(query);
  if (!q || q.length < 2) return null;

  const byArtist = new Map<string, { display: string; songs: SongRef[] }>();
  for (const song of songs) {
    for (const artist of song.artists) {
      const norm = normalizeArtist(artist);
      if (!norm) continue;
      let entry = byArtist.get(norm);
      if (!entry) {
        entry = { display: artist, songs: [] };
        byArtist.set(norm, entry);
      }
      entry.songs.push(song);
    }
  }

  let best: { norm: string; display: string; exact: boolean; sim: number } | null = null;
  for (const [norm, entry] of byArtist) {
    const exact = norm === q;
    const sim = exact ? 1 : norm.length >= 2 ? diceSimilarity(norm, q) : 0;
    if (!exact && sim < 0.85) continue;
    if (!best || (exact && !best.exact) || (exact === best.exact && sim > best.sim)) {
      best = { norm, display: entry.display, exact, sim };
    }
  }
  if (!best) return null;
  const entry = byArtist.get(best.norm);
  if (!entry || entry.songs.length === 0) return null;
  return { artist: entry.display, songs: entry.songs };
}

/**
 * 同分候选：优先最短标题（通常是原版，而非「(童声版)」「(Live)」等），
 * 再优先平台搜索结果靠前的（官方/热门通常排在最前，避免随机点到翻唱）。
 */
function pickFromTies(ties: SongMatch[]): SongMatch {
  const minLen = Math.min(...ties.map((t) => t.song.name.length));
  const shortest = ties.filter((t) => t.song.name.length === minLen);
  return shortest.reduce((best, cur) => ((cur.rank ?? 0) < (best.rank ?? 0) ? cur : best));
}

/**
 * 综合决策：优先强歌名命中 → 歌手意图 → 弱歌名命中。
 * 同分候选（如多个版本）优先原版，避免每次都点到改编版本。
 */
export function pickSong(query: string, songs: SongRef[], random: () => number = Math.random): SongMatch | null {
  const matches = matchSongsByIntent(query, songs);

  if (matches.length > 0) {
    const top = matches[0];
    if (top.score >= STRONG_SCORE) {
      const ties = matches.filter((m) => top.score - m.score < 0.01);
      return pickFromTies(ties);
    }
  }

  const intent = detectArtistIntent(query, songs);
  if (intent) {
    const chosen = intent.songs[Math.floor(random() * intent.songs.length)];
    if (chosen) return { song: chosen, score: 0.75, reason: "artist" };
  }

  if (matches.length > 0) {
    const top = matches[0];
    const ties = matches.filter((m) => top.score - m.score < 0.01);
    return pickFromTies(ties);
  }
  return null;
}

/** 跨平台候选打分：歌名 0.7 + 歌手 0.3 */
export function scoreCandidate(origin: SongRef, candidate: SongRef): number {
  const titleSim = diceSimilarity(normalizeTitle(origin.name), normalizeTitle(candidate.name));
  const originArtists = new Set(origin.artists.map(normalizeArtist).filter(Boolean));
  let artistSim = 0;
  for (const artist of candidate.artists) {
    const norm = normalizeArtist(artist);
    if (!norm) continue;
    if (originArtists.has(norm)) {
      artistSim = 1;
      break;
    }
    for (const oa of originArtists) {
      if (!oa) continue;
      artistSim = Math.max(artistSim, diceSimilarity(oa, norm));
    }
  }
  let raw = titleSim * 0.7 + artistSim * 0.3;
  if (hasVersionMarker(candidate.name) && !hasVersionMarker(origin.name)) raw -= 0.05;
  return Math.round(Math.max(0, raw) * 1000) / 1000;
}

/**
 * 部分平台的解析结果只带「非播放用 id」，播放前需要补齐 playId：
 * - 酷狗：歌单只返回 hash，播放接口要 mixsongid（库的 extra.album_audio_id）
 * - QQ：Song.ID 是字母数字 SongMID，客户端只认十进制 songid → 解析单曲详情拿 song_id
 */
async function resolvePlayId(song: SongRef): Promise<SongRef> {
  if (song.playId) return song;
  if (song.platform === "qq") {
    // QQ 的 id 是字母数字 SongMID；客户端只认十进制 songid。
    // 当前 qq.Search 拿不到结果，所以走单曲详情解析（详情接口的 Extra.song_id 就是数字 id）。
    if (/^\d+$/.test(song.id)) return { ...song, playId: song.id };
    try {
      const parsed = await parseLink(`https://y.qq.com/n/ryqq/songDetail/${song.id}`);
      const hit = parsed.ok
        ? parsed.songs?.find((s) => s.playId && /^\d+$/.test(s.playId))
        : undefined;
      if (hit?.playId) return { ...song, playId: hit.playId };
    } catch {
      /* 解析失败就按原 id 尝试播放 */
    }
    return song;
  }
  if (song.platform !== "kugou") return song;
  try {
    const q = `${song.name} ${song.artists[0] || ""}`.trim();
    const candidates = await searchSongs(song.platform, q, 10);
    const titleNorm = normalizeTitle(song.name);
    const hit = candidates.find(
      (c) =>
        c.playId &&
        (c.id === song.id || diceSimilarity(normalizeTitle(c.name), titleNorm) >= 0.9),
    );
    if (hit?.playId) return { ...song, playId: hit.playId };
  } catch {
    /* 补不到就按原 id 尝试播放 */
  }
  return song;
}

/**
 * 把一首（其他平台的）歌转到目标播放平台：用「歌名 + 第一歌手」搜索，
 * 对结果重新打分，要求歌名相似度 ≥ 0.6 且总分 ≥ 0.66。
 */
export async function findOnPlaybackPlatform(
  origin: SongRef,
  platform: PlaybackPlatform,
): Promise<SongRef | null> {
  if (origin.platform === platform) return resolvePlayId(origin);

  const q = `${origin.name} ${origin.artists[0] || ""}`.trim();
  let candidates = await searchSongs(platform, q, 10);
  // 「歌名 + 歌手」有时搜不到（QQ 对部分组合关键词会返回空，或该曲只有现场版），
  // 退回只搜歌名再试一次；但此时必须歌手也匹配，避免把同名翻唱当成原曲。
  let titleOnly = false;
  if (candidates.length === 0 && origin.artists[0]) {
    candidates = await searchSongs(platform, origin.name, 10);
    titleOnly = true;
  }
  if (candidates.length === 0) return null;

  const originTitle = normalizeTitle(origin.name);
  let best: { song: SongRef; score: number } | null = null;
  for (const candidate of candidates) {
    const titleSim = diceSimilarity(originTitle, normalizeTitle(candidate.name));
    if (titleSim < 0.6) continue;
    const score = scoreCandidate(origin, candidate);
    // 纯歌名搜索的结果里混有大量同名翻唱：总分不足 0.85 说明歌手基本不匹配，直接丢弃
    if (titleOnly && score < 0.85) continue;
    if (!best || score > best.score) {
      best = { song: { ...candidate, platform }, score };
    }
  }
  if (best && best.score >= 0.66) return best.song;
  return null;
}
