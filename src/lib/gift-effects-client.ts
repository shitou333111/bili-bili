/**
 * 礼物特效客户端模块
 * - Tauri 模式：读取统一本地礼物数据仓（gift-local-store，12h 自动刷新），直连 B站 配置 JSON
 * - Web 模式：通过服务器 /api/gift-effects 代理
 */

import { serverApiUrl } from "./server-api";
import { getPlatform } from "@/lib/platform";
import { ensureGiftDataLoaded, getGiftEffectsMap } from "./gift-local-store";

type EffectJsonConfig = {
  info: {
    aFrame: [number, number, number, number];
    rgbFrame: [number, number, number, number];
    f: number;
    fps: number;
    videoW: number;
    videoH: number;
    w: number;
    h: number;
    scale: number;
    align: number;
    custom: number;
    v: number;
  };
};

export type GiftEffectResult = {
  found: boolean;
  web_mp4?: string;
  web_mp4_json?: string;
  effect_config?: EffectJsonConfig | null;
};

/** 检查是否在 Tauri 环境 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

// ====== Tauri 模式：读取本地礼物数据仓 ======

async function fetchEffectJson(webMp4Json: string): Promise<EffectJsonConfig | null> {
  // 首次冷连接（App 刚启动/DNS/TLS 未就绪 + 并发建连）可能瞬时失败，重试一次即可命中热路径
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<EffectJsonConfig>("fetch_json", { url: webMp4Json });
    } catch (e) {
      if (attempt === 1) {
        console.error("[GiftEffects] JSON获取失败:", webMp4Json.substring(0, 60), e);
        return null;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return null;
}

async function fetchFromBili(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  // 1. 确保本地数据仓已加载（TTL 12h；缺失或过期自动重新下载）
  const platform = await getPlatform();
  await ensureGiftDataLoaded(platform);

  // 2. 从本地完整特效绑定表构建 gift_id -> effect 映射
  const effectMap = getGiftEffectsMap();

  // 3. 为每个 gift_id 获取 web_mp4_json 配置
  const results: Record<number, GiftEffectResult> = {};
  const jsonFetches: Promise<void>[] = [];

  for (const giftId of giftIds) {
    const effect = effectMap[giftId];
    if (effect) {
      results[giftId] = {
        found: true,
        web_mp4: effect.web_mp4,
        web_mp4_json: effect.web_mp4_json,
      };
      jsonFetches.push(
        fetchEffectJson(effect.web_mp4_json).then((config) => {
          results[giftId].effect_config = config;
        }),
      );
    } else {
      results[giftId] = { found: false };
    }
  }

  await Promise.all(jsonFetches);
  return results;
}

/**
 * 返回全量特效绑定表：gift_id -> { web_mp4, web_mp4_json }。
 * Tauri：读本地礼物数据仓（12h 自动刷新）；Web：服务器 /api/gift-effects?list=1。
 * 供模拟器等需要完整特效映射的场景使用（配置 JSON 由调用方自行按 URL 去重拉取）。
 */
export async function getEffectsMap(): Promise<Record<number, { web_mp4: string; web_mp4_json: string }>> {
  if (isTauri()) {
    const platform = await getPlatform();
    await ensureGiftDataLoaded(platform);
    return getGiftEffectsMap();
  }
  const resp = await fetch(serverApiUrl("/api/gift-effects?list=1"));
  const data = await resp.json();
  return data?.data?.effects || {};
}

// ====== Web 模式：通过服务器代理 ======

async function fetchFromServer(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  const resp = await fetch(serverApiUrl(`/api/gift-effects?gift_ids=${giftIds.join(",")}`));
  const data = await resp.json();
  return data.code === 0 && data.data ? data.data : {};
}

// ====== 统一导出 ======

/**
 * 获取礼物特效配置
 * - Tauri 环境：读本地礼物数据仓（12h 自动刷新）
 * - Web 环境：通过服务器代理
 */
export async function fetchGiftEffects(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  if (isTauri()) {
    return fetchFromBili(giftIds);
  }
  return fetchFromServer(giftIds);
}
