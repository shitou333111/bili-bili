/**
 * 礼物特效客户端模块
 * - Tauri 模式：直连 B站 API，12小时 localStorage 缓存
 * - Web 模式：通过服务器 /api/gift-effects 代理
 */

const BILI_EFFECTS_API =
  "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2?platform=pc";
const CACHE_KEY = "bili_gift_effects_cache";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12小时

type EffectConfItem = {
  type: number;
  web_mp4: string;
  web_mp4_json: string;
  id: number;
  bind_gift_ids: number[];
};

type GiftEffectsList = {
  code: number;
  message: string;
  data?: {
    full_sc_resource: {
      conf_list: EffectConfItem[];
    };
  };
};

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

// ====== Tauri 模式：直连 B站 API ======

function getCachedList(): GiftEffectsList | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, timestamp } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function setCachedList(data: GiftEffectsList): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch {}
}

async function fetchEffectsListFromBili(): Promise<GiftEffectsList | null> {
  try {
    // 使用 Tauri HTTP 插件（Rust reqwest），绕过 CORS
    // 添加完整浏览器请求头以通过 B站 CDN 反爬检测
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const resp = await tauriFetch(BILI_EFFECTS_API, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://live.bilibili.com/",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      },
    });
    console.log("[GiftEffects] B站API响应状态:", resp.status, resp.ok);
    if (!resp.ok) return null;
    const data: GiftEffectsList = await resp.json();
    console.log("[GiftEffects] B站API code:", data.code, "conf_list数量:", data.data?.full_sc_resource?.conf_list?.length);
    return data.code === 0 ? data : null;
  } catch (e) {
    console.error("[GiftEffects] B站API请求失败:", e);
    return null;
  }
}

async function fetchEffectJson(webMp4Json: string): Promise<EffectJsonConfig | null> {
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const resp = await tauriFetch(webMp4Json, { method: "GET" });
    console.log("[GiftEffects] JSON获取:", webMp4Json.substring(0, 80), "状态:", resp.status, resp.ok);
    if (!resp.ok) return null;
    const data = await resp.json();
    console.log("[GiftEffects] JSON解析成功, 有info:", !!data?.info);
    return data;
  } catch (e) {
    console.error("[GiftEffects] JSON获取失败:", webMp4Json.substring(0, 80), e);
    return null;
  }
}

async function fetchFromBili(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  console.log("[GiftEffects] Tauri直连, giftIds:", giftIds);
  // 1. 获取特效列表（缓存优先）
  let list = getCachedList();
  if (!list) {
    list = await fetchEffectsListFromBili();
    if (list) setCachedList(list);
  }
  console.log("[GiftEffects] 特效列表:", list ? `有 ${list.data?.full_sc_resource?.conf_list?.length} 条` : "无");

  // 2. 构建 gift_id → effect 映射
  const effectMap = new Map<number, { web_mp4: string; web_mp4_json: string }>();
  if (list?.data?.full_sc_resource?.conf_list) {
    for (const item of list.data.full_sc_resource.conf_list) {
      if (!item.web_mp4 || !item.web_mp4_json) continue;
      for (const gid of item.bind_gift_ids) {
        if (gid === 0) continue;
        effectMap.set(gid, { web_mp4: item.web_mp4, web_mp4_json: item.web_mp4_json });
      }
    }
  }

  // 3. 为每个 gift_id 获取 web_mp4_json 配置
  const results: Record<number, GiftEffectResult> = {};
  const jsonFetches: Promise<void>[] = [];

  for (const giftId of giftIds) {
    const effect = effectMap.get(giftId);
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
  console.log("[GiftEffects] 最终结果:", Object.entries(results).map(([id, r]) => `${id}: found=${r.found} config=${!!r.effect_config}`).join(", "));
  return results;
}

// ====== Web 模式：通过服务器代理 ======

async function fetchFromServer(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  const resp = await fetch(`/api/gift-effects?gift_ids=${giftIds.join(",")}`);
  const data = await resp.json();
  return data.code === 0 && data.data ? data.data : {};
}

// ====== 统一导出 ======

/**
 * 获取礼物特效配置
 * - Tauri 环境：直连 B站 API，12小时 localStorage 缓存
 * - Web 环境：通过服务器代理
 */
export async function fetchGiftEffects(giftIds: number[]): Promise<Record<number, GiftEffectResult>> {
  console.log("[GiftEffects] fetchGiftEffects 被调用, isTauri:", isTauri(), "giftIds:", giftIds);
  if (isTauri()) {
    return fetchFromBili(giftIds);
  }
  return fetchFromServer(giftIds);
}