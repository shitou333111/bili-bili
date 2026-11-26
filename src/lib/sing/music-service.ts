/**
 * 点歌听 · Go 解析服务调用层
 *
 * music-service 是一个极薄的 CLI（依赖 github.com/guohuiyuan/music-lib）：
 *   music-service parse <url>
 *   music-service search --source <platform> --q <text> --limit N
 * 每次调用输出单行 JSON。这里负责定位二进制、执行、解析、缓存。
 *
 * 二进制查找顺序：MUSIC_SERVICE_BIN → .tools/music-service/music-service[.exe]
 * 找不到时统一返回 service_unavailable（由 API/UI 给出明确文案）。
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeSongRef } from "./store";
import { isSingPlatform, type ParsedLink, type SongRef } from "./types";

const execFileAsync = promisify(execFile);

const CLI_TIMEOUT = 20_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const CACHE_TTL = 60_000;

function candidateBins(): string[] {
  const out: string[] = [];
  const env = process.env.MUSIC_SERVICE_BIN;
  if (env) out.push(env);
  const base = path.join(process.cwd(), ".tools", "music-service");
  if (process.platform === "win32") {
    out.push(path.join(base, "music-service.exe"));
  } else {
    out.push(path.join(base, "music-service"));
  }
  out.push(path.join(base, "music-service-linux-amd64"));
  out.push(path.join(base, "music-service"));
  return Array.from(new Set(out));
}

let binCache: string | null | undefined;

async function resolveBin(): Promise<string | null> {
  if (binCache !== undefined) return binCache;
  for (const file of candidateBins()) {
    try {
      await fs.access(file);
      binCache = file;
      return file;
    } catch {
      /* 继续找下一个 */
    }
  }
  binCache = null;
  return null;
}

/** 服务是否可用（UI 可在进入页面时提示） */
export async function musicServiceAvailable(): Promise<boolean> {
  return (await resolveBin()) !== null;
}

interface CliOutcome {
  ok: boolean;
  data: any;
  error?: string;
}

/** 从 stdout 里取最后一行 JSON（库/Go 可能打印日志，取最靠后的合法 JSON 行） */
function parseStdout(stdout: string): unknown | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* 再往前找 */
    }
  }
  return null;
}

function unwrap(raw: unknown): CliOutcome {
  if (!raw || typeof raw !== "object") return { ok: false, data: null, error: "bad_output" };
  const obj = raw as Record<string, any>;
  if (typeof obj.code === "number") {
    if (obj.code !== 0) return { ok: false, data: null, error: String(obj.message || obj.error || "failed") };
    return { ok: true, data: obj.data ?? obj };
  }
  if (obj.ok === false) return { ok: false, data: null, error: String(obj.error || obj.message || "failed") };
  if (obj.ok === true) return { ok: true, data: obj.data ?? obj };
  if (obj.error) return { ok: false, data: null, error: String(obj.error) };
  return { ok: true, data: obj.data ?? obj };
}

async function run(args: string[]): Promise<CliOutcome> {
  const bin = await resolveBin();
  if (!bin) return { ok: false, data: null, error: "service_unavailable" };
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: CLI_TIMEOUT,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      encoding: "utf8",
    });
    const raw = parseStdout(stdout);
    if (raw === null) return { ok: false, data: null, error: "bad_output" };
    return unwrap(raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { ok: false, data: null, error: "service_unavailable" };
    if (err?.killed) return { ok: false, data: null, error: "timeout" };
    return { ok: false, data: null, error: String(err?.message || err) };
  }
}

/** 把服务返回的歌曲数组清洗成 SongRef[]（缺 platform 时用歌单平台补） */
function normalizeSongs(raw: unknown, fallbackPlatform: string): SongRef[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SongRef[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, any>;
    const platform = isSingPlatform(it.platform) ? it.platform : isSingPlatform(fallbackPlatform) ? fallbackPlatform : null;
    if (!platform) continue;
    const id = it.id != null ? String(it.id) : "";
    const artists = Array.isArray(it.artists)
      ? it.artists
      : Array.isArray(it.artist)
        ? it.artist
        : typeof it.artists === "string"
          ? it.artists.split(/[\/、,&]/)
          : typeof it.artist === "string"
            ? [it.artist]
            : [];
    const rawDuration = Number(it.duration ?? it.duration_ms ?? 0);
    const duration = Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration > 10_000 ? rawDuration / 1000 : rawDuration)
      : undefined;
    const song = sanitizeSongRef({
      platform,
      id,
      // 本机播放接口需要的专用 id：酷狗 mixsongid / QQ 十进制 songid
      playId: it.playId ?? it.play_id ?? it.extra?.album_audio_id ?? it.extra?.song_id,
      name: it.name ?? it.song_name ?? it.title ?? it.songName,
      artists,
      album: it.album ?? it.album_name ?? it.albumName,
      duration,
    });
    if (song) out.push(song);
  }
  return out;
}

// ==================== 结果缓存 ====================

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) {
    // 简单淘汰：删最旧的一半
    const keys = Array.from(cache.keys()).slice(0, 250);
    for (const k of keys) cache.delete(k);
  }
  return value;
}

// ==================== 对外 API ====================

/** 解析歌单 / 专辑 / 单曲链接；fresh=true 时跳过缓存（刷新场景） */
export async function parseLink(url: string, fresh = false): Promise<ParsedLink> {
  const link = url.trim();
  if (!link) return { ok: false, error: "empty_url" };
  const key = `parse:${link}`;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value as ParsedLink;
  }
  const value = await (async () => {
    const res = await run(["parse", link]);
    if (!res.ok) {
      return { ok: false, error: res.error || "parse_failed" } as ParsedLink;
    }
    const d = res.data || {};
    const platform = isSingPlatform(d.platform) ? d.platform : undefined;
    if (!platform) return { ok: false, error: "unsupported_platform" } as ParsedLink;
    const kind: ParsedLink["kind"] = d.kind === "song" ? "song" : d.kind === "album" ? "album" : "playlist";
    const songs = normalizeSongs(d.songs ?? (d.song ? [d.song] : []), platform);
    if (songs.length === 0) return { ok: false, platform, error: "no_songs" } as ParsedLink;
    return {
      ok: true,
      platform,
      kind,
      name: typeof d.name === "string" ? d.name : typeof d.title === "string" ? d.title : undefined,
      cover: typeof d.cover === "string" ? d.cover : undefined,
      link: typeof d.link === "string" && d.link ? d.link : undefined,
      songs,
    } as ParsedLink;
  })();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** 在指定平台搜索歌曲（跨平台转换 / 无歌单直接点歌） */
export async function searchSongs(platform: string, query: string, limit = 10): Promise<SongRef[]> {
  const q = query.trim();
  if (!q || !isSingPlatform(platform)) return [];
  const n = Math.min(Math.max(Math.round(limit), 1), 30);
  return cached(`search:${platform}:${n}:${q}`, async () => {
    // 优先走 serve 模式：搜索实例会带上管理员绑定的账号 Cookie。
    // 匿名实例会被音乐库过滤掉 VIP/付费曲目（网易云 fl=0、QQ payplay=1），
    // 导致原唱搜不到、只剩翻唱。
    const res = await serviceJson("/api/music/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: platform, q, limit: n }),
    });
    const served = asRecord(res.data);
    if (res.ok && Array.isArray(served.songs)) {
      return normalizeSongs(served.songs, platform);
    }
    // 平台自身搜索失败（如上游 502）时不用再跑匿名 CLI 重复一次
    if (res.error !== "service_unavailable" && res.error !== "bad_output") return [] as SongRef[];
    // 服务没起 / 旧版二进制没有该接口时退回 CLI（无 Cookie，VIP 曲目可能被过滤）
    const cli = await run(["search", "--source", platform, "--q", q, "--limit", String(n)]);
    if (!cli.ok) return [] as SongRef[];
    const d = cli.data || {};
    return normalizeSongs(d.songs ?? d.list ?? d, platform);
  });
}

/**
 * 各平台「搜索」能力探测（服务端本地条件，不是网络探测）。
 *
 * 目前只有汽水需要判断：它的搜索要求本机装了汽水客户端并提供签名器，
 * 没有客户端的环境（如 Linux 服务器）搜什么都是空结果。
 * 返回值缺省表示「未知」，调用方应按可用处理，避免旧版二进制被误伤。
 */
let searchCapCache: { at: number; value: Record<string, boolean> } | null = null;

export async function searchCapabilities(): Promise<Record<string, boolean>> {
  if (searchCapCache && Date.now() - searchCapCache.at < 300_000) return searchCapCache.value;
  const res = await run(["capabilities"]);
  const raw = res.ok ? (res.data as Record<string, any>)?.search : null;
  const value: Record<string, boolean> = {};
  if (raw && typeof raw === "object") {
    for (const [key, val] of Object.entries(raw)) {
      if (typeof val === "boolean") value[key] = val;
    }
  }
  searchCapCache = { at: Date.now(), value };
  return value;
}

/** 清空内存缓存（测试用） */
export function clearMusicServiceCache(): void {
  cache.clear();
  searchCapCache = null;
  binCache = undefined;
}

// ==================== serve 模式（软件内播放） ====================

/**
 * serve 模式地址：music-service 以常驻 HTTP 进程运行，只监听回环地址，
 * 由 Next 服务端反代（浏览器/客户端永远拿不到这个地址）。
 */
export function musicServiceBase(): string {
  return (process.env.MUSIC_SERVICE_URL || "http://127.0.0.1:8081").replace(/\/+$/, "");
}

/** 内部访问令牌（与 music-service 的 --token 对齐；未配置时为空） */
export function musicServiceToken(): string {
  return (process.env.MUSIC_SERVICE_TOKEN || "").trim();
}

/** 把服务返回的 JSON 当对象读取，避免到处写 any */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function serviceJson(pathname: string, init?: RequestInit, timeoutMs = 15_000): Promise<CliOutcome> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) || {}),
  };
  const token = musicServiceToken();
  if (token) headers["X-Music-Token"] = token;
  try {
    const res = await fetch(`${musicServiceBase()}${pathname}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.json().catch(() => null);
    return unwrap(raw);
  } catch {
    return { ok: false, data: null, error: "service_unavailable" };
  }
}

export interface MusicAccountStatus {
  loggedIn: boolean;
  updatedAt?: number;
  cookieKeys?: string[];
}

/** 查询各平台账号登录状态（服务不可用时返回 null） */
export async function getMusicAccounts(): Promise<Record<string, MusicAccountStatus> | null> {
  const res = await serviceJson("/api/music/accounts", undefined, 6000);
  if (!res.ok) return null;
  const accounts = asRecord(res.data).accounts;
  return accounts && typeof accounts === "object" ? (accounts as Record<string, MusicAccountStatus>) : null;
}

export interface MusicQrSession {
  ok: boolean;
  key?: string;
  url?: string;
  /** 平台直接给的二维码图片（data URL）；为空时前端用 url 自行渲染 */
  image?: string;
  expiresAt?: number;
  error?: string;
}

/** 创建扫码登录会话 */
export async function startMusicQrLogin(source: string): Promise<MusicQrSession> {
  const res = await serviceJson(
    `/api/music/login/${encodeURIComponent(source)}/start`,
    { method: "POST" },
    30_000,
  );
  if (!res.ok) return { ok: false, error: res.error || "qr_start_failed" };
  const d = asRecord(res.data);
  return {
    ok: true,
    key: typeof d.key === "string" ? d.key : "",
    url: typeof d.url === "string" ? d.url : "",
    image: typeof d.image === "string" ? d.image : undefined,
    expiresAt: typeof d.expiresAt === "number" ? d.expiresAt : undefined,
  };
}

export interface MusicQrStatus {
  ok: boolean;
  status?: "waiting" | "scanned" | "success" | "expired" | "failed";
  message?: string;
  key?: string;
  loggedIn?: boolean;
  extra?: Record<string, string>;
  error?: string;
}

const QR_STATUS = ["waiting", "scanned", "success", "expired", "failed"] as const;

/** 轮询扫码状态（成功时服务端已把 Cookie 落盘） */
export async function checkMusicQrLogin(source: string, key: string): Promise<MusicQrStatus> {
  const res = await serviceJson(
    `/api/music/login/${encodeURIComponent(source)}/check?key=${encodeURIComponent(key)}`,
    undefined,
    30_000,
  );
  if (!res.ok) return { ok: false, error: res.error || "qr_check_failed" };
  const d = asRecord(res.data);
  const status =
    typeof d.status === "string" && (QR_STATUS as readonly string[]).includes(d.status)
      ? (d.status as MusicQrStatus["status"])
      : undefined;
  return {
    ok: true,
    status,
    message: typeof d.message === "string" ? d.message : undefined,
    key: typeof d.key === "string" ? d.key : undefined,
    loggedIn: d.loggedIn === true,
    extra: d.extra && typeof d.extra === "object" ? (d.extra as Record<string, string>) : undefined,
  };
}

/**
 * 手动绑定某平台账号 Cookie。
 * 用于汽水音乐：其扫码登录依赖官方动态风控签名，music-lib 明确未调通，
 * 只能由管理员从已登录的汽水客户端/浏览器复制 Cookie 填进来。
 */
export async function setMusicAccountCookie(
  source: string,
  cookie: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await serviceJson(
    `/api/music/accounts/${encodeURIComponent(source)}/cookie`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie }),
    },
    15_000,
  );
  return { ok: res.ok, error: res.error };
}

/** 清除某平台账号 Cookie */
export async function clearMusicAccount(source: string): Promise<{ ok: boolean; error?: string }> {
  const res = await serviceJson(
    `/api/music/accounts/${encodeURIComponent(source)}/clear`,
    { method: "POST" },
    10_000,
  );
  return { ok: res.ok, error: res.error };
}

export interface StreamProbe {
  ok: boolean;
  quality?: string;
  ext?: string;
  /** 拿到的只是平台试听片段（汽水会员曲目在服务器上常见） */
  preview?: boolean;
  error?: string;
}

/** 探测一首歌能否在该平台取到完整音频（点歌解析时用于判断是否需要换源） */
export async function probeMusicStream(song: SongRef, quality = "standard"): Promise<StreamProbe> {
  const qs = new URLSearchParams({
    source: song.platform,
    id: song.id,
    name: song.name || "",
    artist: song.artists?.join("/") || "",
    quality,
  });
  if (song.playId) qs.set("playid", song.playId);
  const res = await serviceJson(`/api/music/probe?${qs.toString()}`, undefined, 20_000);
  if (!res.ok) return { ok: false, error: res.error || "probe_failed" };
  const d = asRecord(res.data);
  return {
    ok: true,
    quality: typeof d.quality === "string" ? d.quality : undefined,
    ext: typeof d.ext === "string" ? d.ext : undefined,
    preview: d.preview === true,
  };
}
