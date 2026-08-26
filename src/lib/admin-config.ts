import { promises as fs } from "fs";
import path from "path";
import type { SynthesisActivityConfig } from "./config";

const CONFIG_FILE = path.join(process.cwd(), ".data", "admin-config.json");
const DEFAULT_CONFIG_FILE = path.join(process.cwd(), "public", "admin-config.default.json");

export type BlindBoxItem = {
  id: number;
  name: string;
  icon: string;
};

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
  /** 真实 H5 页面 URL 模板，含 {roomId} / {uid} 占位符 */
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

export type AdminConfig = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  synthesis_activities: SynthesisActivityConfig[];
  /** 推荐主播列表（管理员配置） */
  recommended_anchors?: RecommendedAnchor[];
  /** 黑抽（真实合成活动）页面 URL 模板，包含 {roomId} 和 {uid} 占位符；为空则禁用黑抽入口 */
  real_activity_url?: string;
  /** 模拟器页面活动入口配置（可热更新的玩法算法） */
  simulator_activities?: SimulatorActivityConfig[];
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
    return parsed as AdminConfig;
  } catch {
    return readDefaultConfig();
  }
}

/** 读取仓库内置的默认配置模板（admin-config.default.json） */
async function readDefaultConfig(): Promise<AdminConfig | null> {
  try {
    const raw = await fs.readFile(DEFAULT_CONFIG_FILE, "utf8");
    return JSON.parse(raw) as AdminConfig;
  } catch {
    return null;
  }
}

export async function writeAdminConfig(config: AdminConfig) {
  await ensureConfigFile();
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}
