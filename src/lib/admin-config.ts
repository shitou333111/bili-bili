import { promises as fs } from "fs";
import path from "path";
import type { SynthesisActivityConfig } from "./config";

const CONFIG_FILE = path.join(process.cwd(), ".data", "admin-config.json");
const DEFAULT_CONFIG_FILE = path.join(process.cwd(), "public", "admin-config.default.json");

/** 盲盒内单个礼物（admin 配置的完整信息；过期盲盒不再依赖 B站 接口） */
export type BlindBoxGiftItem = {
  /** 礼物 gift_id（过期奖励礼物可能拿不到 id，可为 0，此时按名称匹配） */
  gift_id: number;
  /** 礼物名称（自由文本，允许不在礼物目录中） */
  gift_name: string;
  /** 电池单价（爆出时计入的价值） */
  price: number;
  /** 图标链接（可选） */
  gift_img?: string;
  /** true = 额外奖励礼物：只计入爆出价值，不计抽数/成本 */
  is_reward?: boolean;
};

export type BlindBoxItem = {
  id: number;
  name: string;
  icon: string;
  /** 盲盒单价（电池）；0/缺失时回退礼物目录 */
  blind_price?: number;
  /** 盲盒礼物列表（含额外奖励礼物） */
  gifts?: BlindBoxGiftItem[];
};

/** 归一化单个盲盒礼物（容错任意输入；幂等、不抛错） */
export function normalizeBlindBoxGift(raw: unknown): BlindBoxGiftItem {
  const g = (raw ?? {}) as Record<string, unknown>;
  const isReward = g.is_reward === true;
  return {
    gift_id: Number(g.gift_id) || 0,
    gift_name: String(g.gift_name ?? "").trim(),
    price: Number(g.price) || 0,
    gift_img: g.gift_img ? String(g.gift_img) : undefined,
    is_reward: isReward || undefined,
  };
}

/** 归一化单个盲盒条目（兼容仅含 {id,name,icon} 的旧配置） */
export function normalizeBlindBoxItem(raw: unknown): BlindBoxItem {
  const b = (raw ?? {}) as Record<string, unknown>;
  const rawGifts = Array.isArray(b.gifts) ? b.gifts : [];
  const seen = new Set<number>();
  const gifts: BlindBoxGiftItem[] = [];
  for (const rg of rawGifts) {
    const gift = normalizeBlindBoxGift(rg);
    // 丢弃完全空行；重复 gift_id（>0）去重，gift_id=0 的奖励礼物按名称保留
    if (!gift.gift_name && !gift.gift_id) continue;
    if (gift.gift_id > 0) {
      if (seen.has(gift.gift_id)) continue;
      seen.add(gift.gift_id);
    }
    gifts.push(gift);
  }
  const blindPrice = Number(b.blind_price);
  return {
    id: Number(b.id) || 0,
    name: String(b.name ?? ""),
    icon: String(b.icon ?? ""),
    blind_price: Number.isFinite(blindPrice) && blindPrice > 0 ? blindPrice : undefined,
    gifts,
  };
}

/** 归一化 admin 配置（仅重写 blind_boxes，其余字段原样保留） */
export function normalizeAdminConfig(raw: AdminConfig): AdminConfig {
  if (!raw || typeof raw !== "object") return raw;
  return {
    ...raw,
    blind_boxes: Array.isArray(raw.blind_boxes) ? raw.blind_boxes.map(normalizeBlindBoxItem) : [],
  };
}

export type RecommendedAnchor = {
  /** 主播 UID */
  uid: number;
  /** 主播昵称（冗余存一份，避免每次渲染都查） */
  uname: string;
  /** 主播头像 URL */
  face?: string;
  /** 主播直播间号 */
  room_id: number;
  /** 是否在帮助页显示 */
  visible: boolean;
  /** 排序（升序，越小越靠前） */
  order: number;
  /** 全局点击次数（所有用户共享，用户点击主播时递增） */
  click_count?: number;
};

/** 算法类型专属参数（随 mock 配置注入 shim，由对应算法解释；无固定结构） */
export type SimulatorAlgorithmParams = Record<string, unknown>;

/**
 * 模拟器页面的活动入口配置（管理员在 admin 页维护）。
 *
 * 玩法可热更新：算法类型 algorithmType 对应前端 algorithms.ts 注册表里的一套 mock 算法，
 * 新活动若属于已有算法类型，只需新增一条配置并选择对应类型即可；
 * 全新玩法则在实现新算法后通过前端热更新推送（无需原生包更新）。
 */
export type SimulatorActivityConfig = {
  /** 活动唯一 ID（如 fans-autumn-2026） */
  id: string;
  /** 活动标题（展示用） */
  title: string;
  /** 入口卡片图片（外部 URL） */
  entryImage: string;
  /** 真实 H5 页面 URL 模板，含 {room_id} / {uid} 占位符 */
  urlTemplate: string;
  /** 目标直播间 room_id（实际运行时会被当前主播信息覆盖） */
  roomId: number;
  /** 目标主播 uid（实际运行时会被当前主播信息覆盖） */
  uid: number;
  /** 是否启用（在模拟器页面显示该活动入口） */
  enabled: boolean;
  /** 算法类型：对应 activities/algorithms.ts 注册表中的键 */
  algorithmType: string;
  /** 算法类型专属参数（透传给 mock-shim 的 CONFIG） */
  algorithmParams?: SimulatorAlgorithmParams;
};

/** 帮助页「常见问题」条目（管理员在 admin 页维护） */
export type FaqItem = {
  /** 问题 */
  q: string;
  /** 回答（支持换行） */
  a: string;
};

export type AdminConfig = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  /** 盲盒盈亏查询配置：可被查询盈亏的盲盒 id 列表（主播页"全部盲盒"卡片 + 弹幕查询） */
  blind_box_profit_ids?: number[];
  synthesis_activities: SynthesisActivityConfig[];
  /** 推荐主播列表（管理员配置） */
  recommended_anchors?: RecommendedAnchor[];
  /** 黑抽（真实合成活动）页面 URL 模板，包含 {room_id} 和 {uid} 占位符；为空则禁用黑抽入口 */
  real_activity_url?: string;
  /** 模拟器页面活动入口配置（可热更新的玩法算法） */
  simulator_activities?: SimulatorActivityConfig[];
  /** 帮助页顶部公告内容（管理员在 admin 页编辑，为空则不显示公告卡片） */
  announcement?: string;
  /** 帮助页「常见问题」列表（管理员在 admin 页编辑，为空则不显示该卡片） */
  faq?: FaqItem[];
};

async function ensureConfigFile() {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(null, null, 2), "utf8");
  }
}

export async function readAdminConfig(): Promise<AdminConfig | null> {
  await ensureConfigFile();
  const raw = await fs.readFile(CONFIG_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      // 主文件无效 → 回退到默认模板
      return readDefaultConfig();
    }
    // 归一化 blind_boxes，兼容仅含 {id,name,icon} 的旧文件
    return normalizeAdminConfig(parsed as AdminConfig);
  } catch {
    return readDefaultConfig();
  }
}

/** 读取仓库内置的默认配置模板（admin-config.default.json） */
async function readDefaultConfig(): Promise<AdminConfig | null> {
  try {
    const raw = await fs.readFile(DEFAULT_CONFIG_FILE, "utf8");
    return normalizeAdminConfig(JSON.parse(raw) as AdminConfig);
  } catch {
    return null;
  }
}

export async function writeAdminConfig(config: AdminConfig) {
  await ensureConfigFile();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
