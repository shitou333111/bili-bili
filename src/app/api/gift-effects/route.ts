import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

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

const DATA_DIR = path.join(process.cwd(), ".data");
const EFFECTS_FILE = path.join(DATA_DIR, "gift_effects.json");
const BILI_API = "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2?platform=pc";

// ==================== 存储操作（仅作为网络失败时的兜底） ====================

async function readEffectsFile(): Promise<GiftEffectsResponse | null> {
  try {
    const raw = await fs.readFile(EFFECTS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
    // 后台异步保存到本地文件（不阻塞响应），作为下次网络失败时的兜底
    fs.writeFile(EFFECTS_FILE, JSON.stringify(data, null, 2), "utf-8").catch(() => {});
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
    // 优先从 B站 API 拉取最新特效列表（确保 web_mp4_json 地址是最新的）；
    // 失败则回退到本地缓存文件。
    let effectsData = await fetchEffectsFromBili();
    if (!effectsData) {
      console.log("[GiftEffects] 网络获取失败，使用本地缓存文件");
      effectsData = await readEffectsFile();
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
