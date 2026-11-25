/**
 * 点歌机 · 粉丝与主播的匹配度
 *
 * score = 0.6 × Jaccard(歌手集合) + 0.4 × (共同歌曲数 / 双方歌曲数几何均值)
 * 歌手集合用归一化后的歌手名；共同歌曲按「归一化歌名 + 歌手集合」判定。
 * 结果按 uid+updatedAt 缓存，避免每次请求重复计算。
 */
import type { HostMatch, SingProfile } from "./types";
import { allSongs } from "./store";
import { normalizeArtist, normalizeTitle } from "./normalize";

interface ProfileIndex {
  key: string;
  uid: string;
  uname?: string;
  singers: Map<string, string>;
  songs: Set<string>;
  songCount: number;
}

const indexCache = new Map<string, ProfileIndex>();

function songKey(name: string, artists: string[]): string {
  const title = normalizeTitle(name);
  const singer = artists.map(normalizeArtist).filter(Boolean).sort().join("/");
  return `${title}|${singer}`;
}

export function indexProfile(profile: SingProfile): ProfileIndex {
  const key = `${profile.uid}:${profile.updatedAt}`;
  const hit = indexCache.get(profile.uid);
  if (hit && hit.key === key) return hit;

  const singers = new Map<string, string>();
  const songs = new Set<string>();
  let songCount = 0;
  for (const song of allSongs(profile)) {
    songCount++;
    songs.add(songKey(song.name, song.artists));
    for (const artist of song.artists) {
      const norm = normalizeArtist(artist);
      if (!norm) continue;
      if (!singers.has(norm)) singers.set(norm, artist);
    }
  }
  const entry: ProfileIndex = {
    key,
    uid: profile.uid,
    uname: profile.uname,
    singers,
    songs,
    songCount,
  };
  indexCache.set(profile.uid, entry);
  if (indexCache.size > 2000) {
    const keys = Array.from(indexCache.keys()).slice(0, 1000);
    for (const k of keys) indexCache.delete(k);
  }
  return entry;
}

/** 粉丝与主播的匹配度（a 为当前用户，b 为候选主播） */
export function compareProfiles(a: SingProfile, b: SingProfile): HostMatch {
  const ia = indexProfile(a);
  const ib = indexProfile(b);

  const sharedSingerKeys: string[] = [];
  const [small, large] = ia.singers.size <= ib.singers.size ? [ia.singers, ib.singers] : [ib.singers, ia.singers];
  for (const norm of small.keys()) {
    if (large.has(norm)) sharedSingerKeys.push(norm);
  }

  let sharedSongs = 0;
  const [smallSongs, largeSongs] = ia.songs.size <= ib.songs.size ? [ia.songs, ib.songs] : [ib.songs, ia.songs];
  for (const k of smallSongs) if (largeSongs.has(k)) sharedSongs++;

  const union = ia.singers.size + ib.singers.size - sharedSingerKeys.length;
  const jaccard = union > 0 ? sharedSingerKeys.length / union : 0;
  const geometric = Math.sqrt(Math.max(ia.songCount, 0) * Math.max(ib.songCount, 0));
  const songRatio = geometric > 0 ? sharedSongs / geometric : 0;

  const score = Math.round((0.6 * jaccard + 0.4 * songRatio) * 1000) / 1000;

  return {
    uid: b.uid,
    uname: b.uname,
    score,
    sharedSingers: sharedSingerKeys.length,
    sharedSongs,
    singerNames: sharedSingerKeys.slice(0, 8).map((k) => small.get(k) || ib.singers.get(k) || k),
  };
}

/**
 * 取与 me 最匹配的候选（自动排除自己），按分数降序。
 * 共同歌手或共同歌曲为 0 的候选不返回。
 */
export function topHostMatches(me: SingProfile, candidates: SingProfile[], limit = 10): HostMatch[] {
  const out: HostMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.uid === me.uid) continue;
    const m = compareProfiles(me, candidate);
    if (m.sharedSingers === 0 && m.sharedSongs === 0) continue;
    out.push(m);
  }
  out.sort((x, y) => y.score - x.score || y.sharedSingers - x.sharedSingers || y.sharedSongs - x.sharedSongs);
  return out.slice(0, limit);
}
