/**
 * 官方入场提示 · 本地资源缓存（Tauri）
 *
 * 为什么需要：官方入场动画被所有进场用户频繁触发，若每次都从 B站 CDN 拉取 mp4 + json，
 * 既受网络波动影响（首帧黑屏/超时），也会让每次入场都重复下载同一份资源。
 *
 * 缓存策略（首次选择该选项时下载，之后一律读本地）：
 *  - 目录：<dataDir>/entry-effects/<视频文件名>/
 *      video.mp4   特效视频（RGB 画面区 + 透明区 + 模板遮罩带，原样保存）
 *      config.json 配套 JSON（info 动画/透明度 + src/frame 模板）
 *  - 命中即返回本地地址：/api/video?p=<绝对路径>（Tauri 本地服务器的 Range 视频路由，
 *    画布（浏览器源）与主窗口同源可直接播放，且不跨域污染 canvas）
 *  - 下载走 platform.fetchArrayBuffer（Tauri plugin-http，绕过 CORS，带 B站 Referer）
 *  - 并发去重：同一视频的重复触发共享同一个下载 Promise；进程内再加一层内存缓存
 *
 * 只缓存"原始素材"，不预合成透明视频：昵称/头像每个用户都不同，无法预先烘焙进视频；
 * 且逐帧合成（540×120 量级）本身开销很小（见 EntryOfficialEffect.renderFrame）。
 */
import { getPlatform } from "@/lib/platform";
import type { EntryEffectConfig, EntryOfficialPayload, OfficialEntryStyle } from "./types";

const DIR = "entry-effects";

/** 进程内缓存：视频地址 → 已解析的资源（避免每次入场都查盘） */
const mem = new Map<string, EntryOfficialPayload>();
/** 并发去重：视频地址 → 进行中的解析 */
const inflight = new Map<string, Promise<EntryOfficialPayload>>();

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 由视频地址取稳定的缓存目录名（B站 CDN 文件名本身就是内容哈希） */
function cacheName(style: OfficialEntryStyle): string {
  const seg = style.video.split("?")[0].split("/").pop() || "";
  const base = seg.replace(/\.[a-z0-9]+$/i, "");
  return (base || `style_${style.id}`).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** 校验并解析配套 JSON（必须有 info 段；src/frame 模板段可缺省） */
function parseConfig(text: string): EntryEffectConfig | null {
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && j.info ? (j as EntryEffectConfig) : null;
  } catch {
    return null;
  }
}

async function load(style: OfficialEntryStyle): Promise<EntryOfficialPayload> {
  // 非 Tauri（Web 预览）：没有本地目录与 /api/video，直接用 CDN 地址，JSON 由组件自行拉取
  const fallback: EntryOfficialPayload = { style, video: style.video, config: null };
  if (!isTauri()) return fallback;

  const p = await getPlatform();
  try {
    const dir = `${await p.getDataDir()}/${DIR}/${cacheName(style)}`;
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.mkdir(dir, { recursive: true });
    const videoPath = `${dir}/video.mp4`;
    const jsonPath = `${dir}/config.json`;

    const hasVideo = await fs.exists(videoPath);
    const hasJson = await fs.exists(jsonPath);

    if (!hasVideo) {
      const buf = await p.fetchArrayBuffer(style.video);
      await fs.writeFile(videoPath, new Uint8Array(buf));
    }

    let config: EntryEffectConfig | null = null;
    if (hasJson) {
      config = parseConfig(await fs.readTextFile(jsonPath));
    } else {
      const buf = await p.fetchArrayBuffer(style.json);
      const text = new TextDecoder().decode(new Uint8Array(buf));
      config = parseConfig(text);
      if (config) await fs.writeFile(jsonPath, new TextEncoder().encode(text)); // 非法 JSON 不落盘，下次重试
    }

    const payload: EntryOfficialPayload = {
      style,
      // 本地服务器视频路由（支持 Range）；占位后由画布/主窗口直接播放
      video: `/api/video?p=${encodeURIComponent(videoPath)}`,
      config,
    };
    mem.set(style.video, payload);
    return payload;
  } catch {
    return fallback; // 下载/落盘失败：退回 CDN 直链（功能可用，只是每次走网络）
  }
}

/** 解析某项官方入场动画的实际资源（本地缓存优先，缺则首次下载并落盘）。 */
export async function resolveEntryStyleAssets(style: OfficialEntryStyle): Promise<EntryOfficialPayload> {
  const hit = mem.get(style.video);
  if (hit) return hit;
  const running = inflight.get(style.video);
  if (running) return running;
  const job = load(style).finally(() => inflight.delete(style.video));
  inflight.set(style.video, job);
  return job;
}
