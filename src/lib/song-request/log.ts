/**
 * 点歌机 · 点歌记录
 *
 * 每条点歌（含播放失败 / 未匹配 / 未投喂礼物）都落一条记录到
 * <dataDir>/uid_<mid>/song-request-log.json，点歌机卡片读取展示。
 * 记录按时间倒序保存，最多 MAX_ENTRIES 条；写盘失败（如 Web 端）时降级为内存记录。
 */
import { getPlatform } from "@/lib/platform";
import type { PlaybackPlatform, SingPlatform } from "@/lib/sing/types";

const LOG_NAME = "song-request-log.json";
/** 记录条数上限（超出丢弃最旧的） */
const MAX_ENTRIES = 200;
/**
 * 本次软件启动的会话标识：落盘时一并写入。
 * 重启（模块重新加载）后标识变化 → 旧会话的记录直接丢弃，点歌记录每次从零开始。
 */
const SESSION_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export type SongRequestLogStatus =
  | "playing"
  | "queued"
  | "played"
  | "failed"
  | "unmatched"
  | "no_list"
  | "unavailable"
  | "gift_required";

export interface SongRequestLogEntry {
  /** 点歌时间（毫秒时间戳） */
  ts: number;
  uid: number;
  /** 点歌用户昵称 */
  uname: string;
  /** 点歌用户头像 */
  avatar?: string;
  /** 弹幕里点的歌名（关键词之后的内容） */
  query: string;
  /** 实际播放/命中的歌名 */
  songName?: string;
  artists?: string[];
  platform?: PlaybackPlatform;
  /** 用户点的原曲来自哪个平台（用于记录里显示来源图标） */
  originPlatform?: SingPlatform;
  status: SongRequestLogStatus;
  /** 附加说明：失败原因 / 排队位置等 */
  detail?: string;
}

const STATUSES: SongRequestLogStatus[] = [
  "playing",
  "queued",
  "played",
  "failed",
  "unmatched",
  "no_list",
  "unavailable",
  "gift_required",
];

/** 每个主播账号的内存副本（首次读取后缓存） */
const memory = new Map<number, SongRequestLogEntry[]>();
/** 记录变化订阅者 */
const listeners = new Map<number, Set<(entries: SongRequestLogEntry[]) => void>>();

function sanitizeEntry(raw: unknown): SongRequestLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ts = Number(r.ts);
  const status = r.status as SongRequestLogStatus;
  if (!Number.isFinite(ts) || ts <= 0 || !STATUSES.includes(status)) return null;
  return {
    ts: Math.floor(ts),
    uid: Number(r.uid) || 0,
    uname: typeof r.uname === "string" ? r.uname : "",
    avatar: typeof r.avatar === "string" ? r.avatar : undefined,
    query: typeof r.query === "string" ? r.query : "",
    songName: typeof r.songName === "string" ? r.songName : undefined,
    artists: Array.isArray(r.artists)
      ? (r.artists as unknown[]).filter((a): a is string => typeof a === "string")
      : undefined,
    platform: typeof r.platform === "string" ? (r.platform as PlaybackPlatform) : undefined,
    originPlatform:
      typeof r.originPlatform === "string" ? (r.originPlatform as SingPlatform) : undefined,
    status,
    detail: typeof r.detail === "string" ? r.detail : undefined,
  };
}

function notify(mid: number, entries: SongRequestLogEntry[]): void {
  const set = listeners.get(mid);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(entries);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  }
}

async function readFromDisk(mid: number): Promise<SongRequestLogEntry[]> {
  try {
    const platform = await getPlatform();
    const path = `${await platform.getDataDir()}/uid_${mid}/${LOG_NAME}`;
    const raw = JSON.parse(await platform.readFile(path));
    // 上一次软件会话留下的记录不再展示（点歌记录随重启清空）
    if (raw?.session && raw.session !== SESSION_ID) return [];
    const list: unknown[] = Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw) ? raw : [];
    return list
      .map(sanitizeEntry)
      .filter((e): e is SongRequestLogEntry => !!e)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

async function writeToDisk(mid: number, entries: SongRequestLogEntry[]): Promise<void> {
  try {
    const platform = await getPlatform();
    const dir = `${await platform.getDataDir()}/uid_${mid}`;
    await platform.mkdir(dir);
    await platform.writeFile(`${dir}/${LOG_NAME}`, JSON.stringify({ session: SESSION_ID, entries }, null, 2));
  } catch {
    /* Web 端 / 磁盘异常：保留内存记录即可 */
  }
}

/** 串行执行读改写，避免并发点歌互相覆盖 */
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** 读取某主播的点歌记录（时间倒序） */
export async function loadSongRequestLog(mid: number): Promise<SongRequestLogEntry[]> {
  const cached = memory.get(mid);
  if (cached) return cached;
  const entries = await readFromDisk(mid);
  const cur = memory.get(mid);
  if (cur) return cur; // 读取期间已有新记录写入
  memory.set(mid, entries);
  return entries;
}

/** 追加一条点歌记录（内存立即可见，随后异步落盘） */
export function appendSongRequestLog(mid: number, entry: SongRequestLogEntry): Promise<void> {
  return serialize(async () => {
    const list = memory.get(mid) ?? (await readFromDisk(mid));
    const next = [entry, ...list].slice(0, MAX_ENTRIES);
    memory.set(mid, next);
    notify(mid, next);
    await writeToDisk(mid, next);
  }).then(() => undefined);
}

/** 更新一条已有点歌记录（按点歌时间 ts 定位），用于「排队 → 播放 → 已播放」状态流转 */
export function updateSongRequestLog(
  mid: number,
  ts: number,
  patch: Partial<Pick<SongRequestLogEntry, "status" | "detail">>,
): Promise<void> {
  return serialize(async () => {
    const list = memory.get(mid) ?? (await readFromDisk(mid));
    const idx = list.findIndex((e) => e.ts === ts);
    if (idx < 0) return;
    const next = list.slice();
    next[idx] = { ...next[idx], ...patch };
    memory.set(mid, next);
    notify(mid, next);
    await writeToDisk(mid, next);
  }).then(() => undefined);
}

/** 清空某主播的点歌记录 */
export function clearSongRequestLog(mid: number): Promise<void> {
  return serialize(async () => {
    memory.set(mid, []);
    notify(mid, []);
    await writeToDisk(mid, []);
  });
}

/** 订阅点歌记录变化，返回取消订阅函数 */
export function subscribeSongRequestLog(
  mid: number,
  cb: (entries: SongRequestLogEntry[]) => void,
): () => void {
  let set = listeners.get(mid);
  if (!set) {
    set = new Set();
    listeners.set(mid, set);
  }
  set.add(cb);
  return () => {
    const cur = listeners.get(mid);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) listeners.delete(mid);
  };
}
