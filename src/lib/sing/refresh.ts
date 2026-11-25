/**
 * 点歌机 · 歌单刷新
 *
 * /sing 每次打开都会调用：不只是读服务器缓存，而是重新向各音乐平台解析
 * 已导入的歌单 / 单曲链接，更新歌曲列表。
 * 单个链接失败时保留旧数据并写 lastError（不整体失败）。
 */
import { parseLink } from "./music-service";
import { readProfile, writeProfile } from "./store";
import type { SingProfile } from "./types";

const CONCURRENCY = 3;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = new Array(Math.min(limit, Math.max(items.length, 1))).fill(0).map(async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/** 刷新一个用户的全部歌单与单曲；返回最新 profile（不存在返回 null） */
export async function refreshProfile(uid: string): Promise<SingProfile | null> {
  const profile = await readProfile(uid);
  if (!profile) return null;

  let changed = false;

  await mapLimit(profile.songs, CONCURRENCY, async (item, index) => {
    if (!item.link) return;
    const parsed = await parseLink(item.link, true);
    const song = parsed.ok ? parsed.songs?.[0] : undefined;
    if (song) {
      profile.songs[index] = { ...item, song };
      changed = true;
    }
  });

  await mapLimit(profile.playlists, CONCURRENCY, async (item, index) => {
    const parsed = await parseLink(item.link, true);
    if (parsed.ok && parsed.songs && parsed.songs.length > 0) {
      profile.playlists[index] = {
        ...item,
        title: parsed.name || item.title,
        cover: parsed.cover || item.cover,
        songs: parsed.songs,
        updatedAt: Date.now(),
        lastError: undefined,
      };
    } else {
      profile.playlists[index] = {
        ...item,
        lastError: parsed.error === "service_unavailable" ? "解析服务未就绪" : `刷新失败：${parsed.error || "未知错误"}`,
        updatedAt: Date.now(),
      };
    }
    changed = true;
  });

  if (changed) await writeProfile(profile);
  return profile;
}
