import fs from "node:fs/promises";
import path from "node:path";
import {
  isSingPlatform,
  type PlaylistItem,
  type SingPlatform,
  type SingProfile,
  type SingRole,
  type SongItem,
  type SongRef,
} from "./types";

/** 与现有数据目录约定一致：<cwd>/.data */
const DATA_DIR = path.join(process.cwd(), ".data");
const SING_DIR = path.join(DATA_DIR, "sing");

const MAX_PLAYLISTS = 50;
const MAX_SONGS_PER_PLAYLIST = 5000;
const MAX_SONG_ITEMS = 2000;

export function isValidUid(uid: unknown): uid is string {
  return typeof uid === "string" && /^\d{1,20}$/.test(uid);
}

function profilePath(uid: string): string {
  return path.join(SING_DIR, `uid_${uid}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SING_DIR, { recursive: true });
}

function str(v: unknown, max = 300): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

export function sanitizeSongRef(raw: unknown): SongRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const name = str(r.name, 200);
  if (!id || !name || !isSingPlatform(r.platform)) return null;
  const artists = Array.isArray(r.artists)
    ? r.artists.map((a) => str(a, 100)).filter(Boolean).slice(0, 10)
    : typeof r.artists === "string"
      ? [str(r.artists, 100)].filter(Boolean)
      : [];
  const album = str(r.album, 200);
  const playId = str(r.playId, 64);
  return {
    platform: r.platform,
    id,
    playId: playId || undefined,
    name,
    artists,
    album: album || undefined,
    duration: num(r.duration),
  };
}

export function sanitizeProfile(raw: unknown): SingProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isValidUid(r.uid)) return null;
  const role: SingRole = r.role === "anchor" ? "anchor" : "fan";

  const songs: SongItem[] = [];
  if (Array.isArray(r.songs)) {
    for (const item of r.songs) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const song = sanitizeSongRef(it.song);
      if (!song) continue;
      songs.push({
        kind: "song",
        song,
        link: str(it.link, 500) || undefined,
        addedAt: num(it.addedAt) ?? Date.now(),
      });
      if (songs.length >= MAX_SONG_ITEMS) break;
    }
  }

  const playlists: PlaylistItem[] = [];
  if (Array.isArray(r.playlists)) {
    for (const item of r.playlists) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const link = str(it.link, 500);
      if (!link || !isSingPlatform(it.platform)) continue;
      const songs: SongRef[] = [];
      if (Array.isArray(it.songs)) {
        for (const s of it.songs) {
          const song = sanitizeSongRef(s);
          if (!song) continue;
          songs.push(song);
          if (songs.length >= MAX_SONGS_PER_PLAYLIST) break;
        }
      }
      playlists.push({
        kind: "playlist",
        platform: it.platform as SingPlatform,
        link,
        title: str(it.title, 200) || "未命名歌单",
        cover: str(it.cover, 500) || undefined,
        songs,
        updatedAt: num(it.updatedAt) ?? Date.now(),
        lastError: str(it.lastError, 300) || undefined,
      });
      if (playlists.length >= MAX_PLAYLISTS) break;
    }
  }

  return {
    uid: r.uid,
    uname: str(r.uname, 60) || undefined,
    role,
    songs,
    playlists,
    updatedAt: num(r.updatedAt) ?? Date.now(),
  };
}

interface CacheEntry {
  mtimeMs: number;
  profile: SingProfile;
}

const cache = new Map<string, CacheEntry>();

export async function readProfile(uid: string): Promise<SingProfile | null> {
  if (!isValidUid(uid)) return null;
  const file = profilePath(uid);
  try {
    const st = await fs.stat(file);
    const hit = cache.get(uid);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.profile;
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const profile = sanitizeProfile(raw);
    if (!profile) return null;
    cache.set(uid, { mtimeMs: st.mtimeMs, profile });
    return profile;
  } catch {
    return null;
  }
}

export async function writeProfile(profile: SingProfile): Promise<void> {
  if (!isValidUid(profile.uid)) throw new Error("invalid uid");
  await ensureDir();
  const file = profilePath(profile.uid);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const data: SingProfile = { ...profile, updatedAt: Date.now() };
  await fs.writeFile(tmp, JSON.stringify(data), "utf8");
  await fs.rename(tmp, file);
  try {
    const st = await fs.stat(file);
    cache.set(profile.uid, { mtimeMs: st.mtimeMs, profile: data });
  } catch {
    cache.delete(profile.uid);
  }
}

export async function deleteProfile(uid: string): Promise<void> {
  if (!isValidUid(uid)) return;
  await fs.unlink(profilePath(uid)).catch(() => {});
  cache.delete(uid);
}

/** 读取全部用户（用于主播匹配度），带目录级 10s 缓存 */
let allCache: { at: number; profiles: SingProfile[] } | null = null;

export async function listProfiles(force = false): Promise<SingProfile[]> {
  if (!force && allCache && Date.now() - allCache.at < 10_000) return allCache.profiles;
  let names: string[] = [];
  try {
    names = await fs.readdir(SING_DIR);
  } catch {
    allCache = { at: Date.now(), profiles: [] };
    return [];
  }
  const out: SingProfile[] = [];
  for (const name of names) {
    const m = /^uid_(\d{1,20})\.json$/.exec(name);
    if (!m) continue;
    const profile = await readProfile(m[1]);
    if (profile) out.push(profile);
  }
  allCache = { at: Date.now(), profiles: out };
  return out;
}

export async function listProfilesByRole(role: SingRole): Promise<SingProfile[]> {
  const all = await listProfiles();
  return all.filter((p) => p.role === role);
}

/** 展平用户全部歌曲（单独导入 + 所有歌单），用于匹配与随机 */
export function allSongs(profile: SingProfile): SongRef[] {
  const out: SongRef[] = profile.songs.map((s) => s.song);
  for (const pl of profile.playlists) out.push(...pl.songs);
  return out;
}

export function songCount(profile: SingProfile): number {
  return profile.songs.length + profile.playlists.reduce((n, p) => n + p.songs.length, 0);
}

/** 找到某个平台歌曲在 profile 中的位置（用于「导入后去重」提示） */
export function hasSong(profile: SingProfile, platform: string, id: string): boolean {
  return allSongs(profile).some((s) => s.platform === platform && s.id === id);
}
