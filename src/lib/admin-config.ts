import { promises as fs } from "fs";
import path from "path";
import type { SynthesisActivityConfig, SynthesisActivityType } from "./config";

const CONFIG_FILE = path.join(process.cwd(), ".data", "admin-config.json");
const DEFAULT_CONFIG_FILE = path.join(process.cwd(), ".data", "admin-config.default.json");

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

export type AdminConfig = {
  current_activity_blind_box_ids: number[];
  blind_boxes: BlindBoxItem[];
  synthesis_activities: SynthesisActivityConfig[];
  /** 推荐主播列表（管理员配置） */
  recommended_anchors?: RecommendedAnchor[];
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

const VALID_ACTIVITY_TYPES: SynthesisActivityType[] = ["slot_draw", "material_package", "card_flip"];

export function validateActivityType(type: string): type is SynthesisActivityType {
  return VALID_ACTIVITY_TYPES.includes(type as SynthesisActivityType);
}

export function getValidActivityTypes(): string[] {
  return VALID_ACTIVITY_TYPES;
}
