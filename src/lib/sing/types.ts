/**
 * 点歌听 · 共享类型
 *
 * 数据流向：
 *   粉丝 /sing → /api/sing/* → .data/sing/uid_<uid>.json
 *   主播端弹幕 → /api/sing/resolve → 目标平台歌曲 → 本地音乐软件播放
 */

/** music-lib 支持的平台标识（与 Go 解析服务的 source 对齐） */
export const SING_PLATFORMS = [
  "netease",
  "qq",
  "kugou",
  "kuwo",
  "migu",
  "qianqian",
  "soda",
  "fivesing",
  "jamendo",
  "joox",
  "apple",
  "spotify",
  "bilibili",
] as const;

export type SingPlatform = (typeof SING_PLATFORMS)[number];

/** 桌面端实际可播放的平台（点歌听目标软件） */
export const PLAYBACK_PLATFORMS = ["netease", "qq", "kugou", "soda"] as const;
export type PlaybackPlatform = (typeof PLAYBACK_PLATFORMS)[number];

/**
 * 点歌听的播放方式：
 * - 具体平台 = 用本机该音乐软件播放；
 * - inapp = 服务器解析音频、经代理流式传给客户端，在软件内播放。
 */
export const PLAYBACK_TARGETS = [...PLAYBACK_PLATFORMS, "inapp"] as const;
export type PlaybackTarget = (typeof PLAYBACK_TARGETS)[number];

const PLATFORM_LABELS: Record<SingPlatform, string> = {
  netease: "网易云音乐",
  qq: "QQ音乐",
  kugou: "酷狗音乐",
  kuwo: "酷我音乐",
  migu: "咪咕音乐",
  qianqian: "千千音乐",
  soda: "汽水音乐",
  fivesing: "5sing",
  jamendo: "Jamendo",
  joox: "JOOX",
  apple: "Apple Music",
  spotify: "Spotify",
  bilibili: "Bilibili",
};

export function isSingPlatform(value: unknown): value is SingPlatform {
  return typeof value === "string" && (SING_PLATFORMS as readonly string[]).includes(value);
}

export function isPlaybackPlatform(value: unknown): value is PlaybackPlatform {
  return typeof value === "string" && (PLAYBACK_PLATFORMS as readonly string[]).includes(value);
}

export function isPlaybackTarget(value: unknown): value is PlaybackTarget {
  return typeof value === "string" && (PLAYBACK_TARGETS as readonly string[]).includes(value);
}

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as SingPlatform] || platform;
}

/** 一首歌的跨平台标识 */
export interface SongRef {
  platform: SingPlatform;
  /** 平台内歌曲 id（播放时直接使用） */
  id: string;
  /** 平台播放接口专用 id（酷狗 mixsongid / QQ 十进制 songid；缺失时用 id） */
  playId?: string;
  name: string;
  artists: string[];
  album?: string;
  /** 时长（秒） */
  duration?: number;
}

/** 单独导入的歌曲 */
export interface SongItem {
  kind: "song";
  song: SongRef;
  /** 原始链接，用于打开 /sing 时刷新元数据 */
  link?: string;
  addedAt: number;
}

/** 导入的歌单（折叠组） */
export interface PlaylistItem {
  kind: "playlist";
  platform: SingPlatform;
  /** 原始歌单链接，用于刷新 */
  link: string;
  title: string;
  cover?: string;
  songs: SongRef[];
  updatedAt: number;
  /** 最近一次刷新失败原因（保留旧歌曲） */
  lastError?: string;
}

export type SingRole = "fan" | "anchor";

export interface SingProfile {
  uid: string;
  uname?: string;
  /** 头像 URL（服务端提供时可用） */
  avatar?: string;
  role: SingRole;
  songs: SongItem[];
  playlists: PlaylistItem[];
  updatedAt: number;
}

/** 歌单解析服务的统一返回 */
export interface ParsedLink {
  ok: boolean;
  platform?: SingPlatform;
  kind?: "playlist" | "song" | "album";
  name?: string;
  cover?: string;
  songs?: SongRef[];
  /** 解析后实际使用的规范链接（短链会换成长期地址，用于后续刷新） */
  link?: string;
  error?: string;
}

export type ResolveStatus = "ok" | "unmatched" | "no_list" | "service_unavailable";

export interface ResolveResult {
  status: ResolveStatus;
  /** 最终要播放的歌曲（已转换到目标平台） */
  song?: SongRef;
  /** user=命中粉丝歌单；anchor=主播歌单随机；search=直接搜索 */
  via?: "user" | "anchor" | "search";
  /** 命中的原始歌曲平台（跨平台时与 song.platform 不同） */
  originPlatform?: SingPlatform;
  /** 匹配方式：exact/contains/fuzzy/artist/random */
  matchReason?: string;
  /** 命中的原始歌曲信息（跨平台转换失败时用于回复文案） */
  matchedName?: string;
  matchedArtists?: string[];
  /** 未匹配时给客户端参考 */
  candidates?: string[];
  message?: string;
  /** 软件内播放：由服务器取流后代理给客户端 */
  inapp?: boolean;
  /** 原平台无法取流，已自动换到其他平台（song.platform 是实际播放平台） */
  switched?: boolean;
  /** 换源前的原始平台 */
  switchedFrom?: SingPlatform;
  /** 实际取到的音质（请求 high 但账号权益不足时会自动降级） */
  quality?: string;
  /** 只拿到平台试听片段（汽水会员曲目在服务器上常见） */
  preview?: boolean;
}

export interface HostMatch {
  uid: string;
  uname?: string;
  /** 头像 URL（服务端提供时可用） */
  avatar?: string;
  score: number;
  sharedSingers: number;
  sharedSongs: number;
  /** 部分共同歌手名，便于前端展示 */
  singerNames: string[];
}
