import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// ==================== 类型定义 ====================

type EffectConfItem = {
  type: number;
  web_mp4: string;
  web_mp4_json: string;
  id: number;
  bind_gift_ids: number[];
};

type GiftEffectsResponse = {
  code: number;
  message: string;
  data?: {
    full_sc_resource: {
      conf_list: EffectConfItem[];
    };
  };
};

type GiftEffectInfo = {
  web_mp4: string;
  web_mp4_json: string;
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

// ==================== 常量 ====================

const BILI_API = "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2?platform=pc";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12小时缓存

// ==================== 内存缓存（公开数据，客户端直连 B站 自取自用，不落盘到 .data） ====================

let effectsCache: { data: GiftEffectsResponse; timestamp: number } | null = null;

/** 检查内存缓存是否有效（未超过12小时） */
function isCacheValid(): boolean {
  return effectsCache !== null && Date.now() - effectsCache.timestamp < CACHE_TTL_MS;
}

function readEffectsCache(): GiftEffectsResponse | null {
  return effectsCache?.data ?? null;
}

async function fetchEffectsFromBili(): Promise<GiftEffectsResponse | null> {
  console.log("[GiftEffects] 从B站API获取特效配置...");
  try {
    const response = await fetch(BILI_API, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error(`[GiftEffects] HTTP ${response.status}`);
      return null;
    }
    const data: GiftEffectsResponse = await response.json();
    if (data.code !== 0) {
      console.error(`[GiftEffects] API错误 code=${data.code}`);
      return null;
    }
    // 写入内存缓存，作为本次进程内后续请求的兜底
    effectsCache = { data, timestamp: Date.now() };
    return data;
  } catch (err) {
    console.error("[GiftEffects] 从B站获取特效列表失败:", err);
    return null;
  }
}

function buildEffectMap(data: GiftEffectsResponse): Map<number, GiftEffectInfo> {
  const map = new Map<number, GiftEffectInfo>();
  const confList = data?.data?.full_sc_resource?.conf_list;
  if (!confList) return map;

  for (const item of confList) {
    if (!item.web_mp4 || !item.web_mp4_json) continue;
    for (const giftId of item.bind_gift_ids) {
      if (giftId === 0) continue;
      map.set(giftId, { web_mp4: item.web_mp4, web_mp4_json: item.web_mp4_json });
    }
  }
  return map;
}

// 不做服务端缓存：每次 API 调用都重新拉取 web_mp4_json，
// 确保地址变更时能拿到最新配置，失败后下次前端重试即可。
async function fetchEffectJson(url: string): Promise<EffectJsonConfig | null> {
  try {
    console.log(`[GiftEffects] 获取特效JSON: ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.error(`[GiftEffects] JSON HTTP ${response.status}: ${url}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error(`[GiftEffects] JSON获取失败: ${url}`, err);
    return null;
  }
}

// ==================== GET Handler ====================

export async function GET(request: Request) {
  const url = new URL(request.url);
  const giftIdsParam = url.searchParams.get("gift_ids") ?? "";
  const forceRefresh = url.searchParams.get("force_refresh") === "1";
  const giftIds = giftIdsParam
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (giftIds.length === 0) {
    return NextResponse.json(
      { code: 400, message: "缺少 gift_ids 参数", data: null },
      { status: 400 },
    );
  }

  try {
    // 缓存策略：如果本地缓存有效（< 12小时）且未强制刷新，直接使用缓存
    let effectsData: GiftEffectsResponse | null = null;
    const cacheValid = isCacheValid();

    if (forceRefresh || !cacheValid) {
      if (!cacheValid) {
        console.log("[GiftEffects] 缓存过期或不存在，从B站API获取");
      } else {
        console.log("[GiftEffects] 强制刷新，从B站API获取");
      }
      effectsData = await fetchEffectsFromBili();
    }

    // 如果网络获取失败，回退到内存缓存
    if (!effectsData) {
      console.log("[GiftEffects] 网络获取失败，尝试使用内存缓存兜底");
      effectsData = readEffectsCache();
    }

    const effectMap = effectsData ? buildEffectMap(effectsData) : new Map<number, GiftEffectInfo>();

    // 构建结果，同时实时获取 web_mp4_json 内容（不缓存）
    const results: Record<number, {
      found: boolean;
      web_mp4?: string;
      web_mp4_json?: string;
      effect_config?: EffectJsonConfig | null;
    }> = {};

    const jsonFetchPromises: Promise<void>[] = [];

    for (const giftId of giftIds) {
      const effect = effectMap.get(giftId);
      if (effect) {
        results[giftId] = {
          found: true,
          web_mp4: effect.web_mp4,
          web_mp4_json: effect.web_mp4_json,
        };
        jsonFetchPromises.push(
          fetchEffectJson(effect.web_mp4_json).then(config => {
            results[giftId].effect_config = config;
          }),
        );
      } else {
        results[giftId] = { found: false };
      }
    }

    await Promise.all(jsonFetchPromises);

    return NextResponse.json(
      { code: 0, message: "ok", data: results },
      { status: 200 },
    );
  } catch (err: any) {
    console.error("[GiftEffects] 错误:", err);
    return NextResponse.json(
      { code: 500, message: `获取礼物特效失败: ${err?.message || String(err)}`, data: null },
      { status: 500 },
    );
  }
}