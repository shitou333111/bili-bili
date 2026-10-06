/**
 * 展示模块 —— 配置与今日礼物记录持久化。
 *
 * - 配置：<dataDir>/uid_<mid>/display-config.json（按登录主播 uid 分目录，用户私有）。
 * - 展示相关三个用户文件（config / 弹幕调试日志 / 礼物记录）均在 uid_<mid>/ 下，
 *   属于本地运行配置，不上传服务器。
 */
import { getPlatform } from "@/lib/platform";
import {
  DEFAULT_DISPLAY_CONFIG,
  type DisplayConfig,
  type DisplayLayout,
  type EntryAnimeConfig,
  type MovableRect,
  type ScreenOrientation,
} from "./types";

const CONFIG_NAME = "display-config.json";

/** 把布局矩形规整为合法数值：非法/缺失回退默认。 */
function normalizeRect(v: unknown, fallback: MovableRect): MovableRect {
  const r = (v ?? {}) as Partial<MovableRect>;
  const x = Number(r.x);
  const y = Number(r.y);
  const scale = Number(r.scale);
  return {
    x: Number.isFinite(x) && x >= 0 ? Math.round(x) : fallback.x,
    y: Number.isFinite(y) && y >= 0 ? Math.round(y) : fallback.y,
    scale: Number.isFinite(scale) && scale > 0 ? Math.min(3, Math.max(0.3, Math.round(scale * 100) / 100)) : fallback.scale,
  };
}

/** 归一化元素布局：逐元素×朝向补默认，数值非法回退。 */
function normalizeLayout(raw: unknown): DisplayLayout {
  const d = DEFAULT_DISPLAY_CONFIG.layout;
  const r = (raw ?? {}) as Partial<DisplayLayout>;
  const norm = (el: "gift" | "giftEffect" | "entry" | "anime" | "banner", rawEl: unknown): Record<ScreenOrientation, MovableRect> => {
    const re = (rawEl ?? {}) as Record<ScreenOrientation, unknown>;
    const def = d[el];
    return {
      landscape: normalizeRect(re?.landscape, def.landscape),
      portrait: normalizeRect(re?.portrait, def.portrait),
    };
  };
  return {
    gift: norm("gift", r.gift),
    giftEffect: norm("giftEffect", (r as any).giftEffect),
    entry: norm("entry", r.entry),
    anime: norm("anime", r.anime),
    banner: norm("banner", (r as any).banner),
  };
}
/** 把片段秒数规整为非负有限数（0 = 未设置/从头/播到尾），非法值归 0。 */
function clampSec(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 按画布朝向解析某位用户的入场视频路径（只配置其中一个则横竖屏共用该视频）。 */
export function resolveAnimeVideo(
  a: EntryAnimeConfig,
  orientation: ScreenOrientation,
): string {
  return orientation === "portrait"
    ? a.videoPortrait || a.videoLandscape
    : a.videoLandscape || a.videoPortrait;
}

/** 按画布朝向解析某位用户入场视频的播放片段（秒）：横竖屏各自一套；0=整段。 */
export function resolveAnimeSegment(
  a: EntryAnimeConfig,
  orientation: ScreenOrientation,
): { startSec: number; endSec: number } {
  if (orientation === "portrait") {
    return { startSec: a.portraitStartSec, endSec: a.portraitEndSec };
  }
  return { startSec: a.landscapeStartSec, endSec: a.landscapeEndSec };
}

/**
 * 派生"总开关"：面板已无独立总开关，任一**画布显示子模块**（收到的礼物展示 / 礼物特效 /
 * 入场提示 / 入场动画 / 横幅）开启即视为开启（画布正常渲染），全部关闭即视为关闭（画布空白）。
 * 注意：盲盒盈亏·弹幕查询与弹幕互动不参与触发（它们不显示在画布上）。
 */
export function displayMaster(cfg: DisplayConfig): boolean {
  return !!(cfg.gift || cfg.giftEffect?.enabled || cfg.entry || cfg.anime || cfg.banner?.enabled);
}

/**
 * 是否需要运行弹幕监听服务（本地浏览器源服务 + 直播间弹幕监听）：
 *  - 任一画布显示模块开启 → 需要（礼物/入场提示/入场动画/礼物特效都靠监听触发）
 *  - 盲盒盈亏·弹幕查询开启 → 也需要（查询本身就是靠监听弹幕实现的），
 *    因此"总开关"关闭（画布空白）也不会影响盲盒查询
 *  - 弹幕互动不需要（它自己按间隔向直播间发弹幕，不依赖监听）
 */
export function displayNeedsService(cfg: DisplayConfig): boolean {
  return displayMaster(cfg) || !!cfg.blindBoxQuery?.enabled;
}

/** 上次入场时间记录条数上限：超出时按时间戳保留最近的条目，防止文件无限增长 */
const MAX_ENTRY_LAST_SEEN = 2000;

/** 清洗"上次入场时间"映射：仅保留 uid 键 + 合法时间戳；超限时丢弃最旧的记录。 */
function normalizeEntryLastSeen(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = Number(v);
    if (k && Number.isFinite(t) && t > 0) out[k] = Math.floor(t);
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_ENTRY_LAST_SEEN) {
    keys.sort((a, b) => out[a] - out[b]); // 最旧在前
    for (const k of keys.slice(0, keys.length - MAX_ENTRY_LAST_SEEN)) delete out[k];
  }
  return out;
}

/** 解析一个可能残缺的配置对象，用默认值补齐缺失字段（向前兼容）。 */
export function normalizeConfig(raw: unknown): DisplayConfig {
  const d = DEFAULT_DISPLAY_CONFIG;
  const r = (raw ?? {}) as Partial<DisplayConfig>;
  return {
    screenOrientation: r.screenOrientation === "portrait" ? "portrait" : "landscape",
    entry: r.entry ?? d.entry,
    gift: r.gift ?? d.gift,
    anime: r.anime ?? d.anime,
    giftEffect: {
      enabled: !!r.giftEffect?.enabled,
      keyword: !!r.giftEffect?.keyword,
    },
    banner: {
      enabled: !!r.banner?.enabled,
      // 按钮文字限制 30 个字以内：超出截断，缺失用默认文案
      text: (typeof r.banner?.text === "string" ? r.banner.text : d.banner.text).slice(0, 30),
    },
    entryFilter: {
      zongdu: !!r.entryFilter?.zongdu,
      tidu: !!r.entryFilter?.tidu,
      jianzhang: !!r.entryFilter?.jianzhang,
      // 灯牌等级阈值：合法数字保留，缺失/非法回退默认（31）
      medalLevelThreshold:
        typeof r.entryFilter?.medalLevelThreshold === "number" &&
        Number.isFinite(r.entryFilter.medalLevelThreshold) &&
        r.entryFilter.medalLevelThreshold >= 0
          ? Math.floor(r.entryFilter.medalLevelThreshold)
          : d.entryFilter.medalLevelThreshold,
    },
    // 入场冷却：非法值回退默认（bilibili = 不额外冷却）
    entryCooldown:
      r.entryCooldown === "30min" || r.entryCooldown === "1h" || r.entryCooldown === "10h"
        ? r.entryCooldown
        : d.entryCooldown,
    entryLastSeen: normalizeEntryLastSeen(r.entryLastSeen),
    // 入场动画冷却：与入场提示同款选项、独立记录（非法值回退默认）
    animeCooldown:
      r.animeCooldown === "30min" || r.animeCooldown === "1h" || r.animeCooldown === "10h"
        ? r.animeCooldown
        : d.animeCooldown,
    animeLastSeen: normalizeEntryLastSeen(r.animeLastSeen),
    // 视频边缘羽化强度：左右/上下独立设置，0=关闭，上限 40（非法/缺失回退默认）
    animeFeatherH:
      typeof r.animeFeatherH === "number" && Number.isFinite(r.animeFeatherH) && r.animeFeatherH >= 0
        ? Math.min(40, Math.round(r.animeFeatherH))
        : d.animeFeatherH,
    animeFeatherV:
      typeof r.animeFeatherV === "number" && Number.isFinite(r.animeFeatherV) && r.animeFeatherV >= 0
        ? Math.min(40, Math.round(r.animeFeatherV))
        : d.animeFeatherV,
    // 阈值允许为 0（0 = 不限制），只有非法/负数才回退默认值
    giftPriceThreshold:
      typeof r.giftPriceThreshold === "number" &&
      Number.isFinite(r.giftPriceThreshold) &&
      r.giftPriceThreshold >= 0
        ? r.giftPriceThreshold
        : d.giftPriceThreshold,
    // 礼物展示条方向：仅接受 "vertical"，其余（含旧配置缺失）回退横条
    giftBarOrientation: r.giftBarOrientation === "vertical" ? "vertical" : "horizontal",
    animeList: Array.isArray(r.animeList)
      ? r.animeList.map((a) => {
          // 兼容旧配置字段 videoPath：作为横屏视频迁移
          const legacyVid = (a as any).videoPath || "";
          return {
            uid: Number(a.uid) || 0,
            uname: a.uname || "",
            face: a.face || "",
            videoLandscape: (a as any).videoLandscape || legacyVid || "",
            videoPortrait: (a as any).videoPortrait || "",
            enabled: !!a.enabled,
            landscapeStartSec: clampSec((a as any).landscapeStartSec),
            landscapeEndSec: clampSec((a as any).landscapeEndSec),
            portraitStartSec: clampSec((a as any).portraitStartSec),
            portraitEndSec: clampSec((a as any).portraitEndSec),
          };
        })
      : d.animeList,
    layout: normalizeLayout((r as any).layout),
    danmaku: {
      enabled: !!r.danmaku?.enabled,
      // 发送间隔最小 60 秒：小于 60 自动改为 60（非法/缺失用默认）
      intervalSec:
        typeof r.danmaku?.intervalSec === "number" &&
        Number.isFinite(r.danmaku.intervalSec)
          ? Math.max(60, Math.floor(r.danmaku.intervalSec))
          : d.danmaku.intervalSec,
      text: r.danmaku?.text ?? d.danmaku.text,
    },
    blindBoxQuery: {
      // 字段缺失（老配置/首次）时默认开启；一旦写入就记住用户选择
      enabled: r.blindBoxQuery === undefined ? true : !!r.blindBoxQuery.enabled,
    },
  };
}

/** 各账号展示配置的内存缓存（按 mid 分开，避免账号切换串配置） */
const configCache = new Map<number, DisplayConfig>();

/** 读取某账号的展示配置（内存缓存，避免频繁读盘） */
export async function loadDisplayConfig(mid: number): Promise<DisplayConfig> {
  const cached = configCache.get(mid);
  if (cached) return cached;
  const platform = await getPlatform();
  const path = `${await platform.getDataDir()}/uid_${mid}/${CONFIG_NAME}`;
  let cfg: DisplayConfig;
  try {
    const raw = JSON.parse(await platform.readFile(path));
    cfg = normalizeConfig(raw);
  } catch {
    // 文件不存在/损坏 → 全新默认配置（新对象，避免外部误改共享默认值）
    cfg = normalizeConfig(undefined);
  }
  configCache.set(mid, cfg);
  return cfg;
}

/** 保存某账号的展示配置并刷新该账号内存缓存。 */
export async function saveDisplayConfig(mid: number, config: DisplayConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  configCache.set(mid, normalized);
  const platform = await getPlatform();
  const dir = `${await platform.getDataDir()}/uid_${mid}`;
  await platform.mkdir(dir);
  await platform.writeFile(`${dir}/${CONFIG_NAME}`, JSON.stringify(normalized, null, 2));
}