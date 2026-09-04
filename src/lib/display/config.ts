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
  const norm = (el: "gift" | "entry" | "anime", rawEl: unknown): Record<ScreenOrientation, MovableRect> => {
    const re = (rawEl ?? {}) as Record<ScreenOrientation, unknown>;
    const def = d[el];
    return {
      landscape: normalizeRect(re?.landscape, def.landscape),
      portrait: normalizeRect(re?.portrait, def.portrait),
    };
  };
  return {
    gift: norm("gift", r.gift),
    entry: norm("entry", r.entry),
    anime: norm("anime", r.anime),
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

/** 解析一个可能残缺的配置对象，用默认值补齐缺失字段（向前兼容）。 */
export function normalizeConfig(raw: unknown): DisplayConfig {
  const d = DEFAULT_DISPLAY_CONFIG;
  const r = (raw ?? {}) as Partial<DisplayConfig>;
  return {
    master: !!r.master,
    screenOrientation: r.screenOrientation === "portrait" ? "portrait" : "landscape",
    entry: r.entry ?? d.entry,
    gift: r.gift ?? d.gift,
    anime: r.anime ?? d.anime,
    entryFilter: {
      zongdu: !!r.entryFilter?.zongdu,
      tidu: !!r.entryFilter?.tidu,
      jianzhang: !!r.entryFilter?.jianzhang,
      medalLevelThreshold: Math.max(0, Math.floor(Number(r.entryFilter?.medalLevelThreshold) || 0)),
    },
    // 阈值允许为 0（0 = 不限制），只有非法/负数才回退默认值
    giftPriceThreshold:
      typeof r.giftPriceThreshold === "number" &&
      Number.isFinite(r.giftPriceThreshold) &&
      r.giftPriceThreshold >= 0
        ? r.giftPriceThreshold
        : d.giftPriceThreshold,
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
      intervalSec:
        typeof r.danmaku?.intervalSec === "number" &&
        Number.isFinite(r.danmaku.intervalSec) &&
        r.danmaku.intervalSec >= 1
          ? Math.floor(r.danmaku.intervalSec)
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