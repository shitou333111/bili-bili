import { promises as fs } from "fs";
import path from "path";
import { readAdminConfig } from "./admin-config";

/** 获取北京时间字符串 (UTC+8) */
function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

// ====== 盲盒内礼物信息 ======
export type BlindBoxGift = {
  gift_id: number;
  price: number;
  gift_name: string;
  gift_img: string;
  is_win_gift: number;
  chance: string;
};

// ====== 盲盒信息条目 ======
export type BlindBoxInfo = {
  blind_box_id: number;
  blind_box_name: string;
  blind_box_img: string;
  blind_price: number;
  gifts: BlindBoxGift[];
  updated_at: string;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const BLIND_BOX_INFO_DIR = path.join(DATA_DIR, "blindbox_info");

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // directory already exists
  }
}

function getBlindBoxInfoPath(blindBoxId: number): string {
  return path.join(BLIND_BOX_INFO_DIR, `${blindBoxId}.json`);
}

/** 获取某个盲盒的完整信息 */
export async function getBlindBoxInfo(_mid: number, _uname: string, blindBoxId: number): Promise<BlindBoxInfo | null> {
  await ensureDir(BLIND_BOX_INFO_DIR);
  const filePath = getBlindBoxInfoPath(blindBoxId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as BlindBoxInfo;
  } catch {
    return null;
  }
}

/**
 * 获取所有盲盒信息。
 * 数据源优先级：admin-config.json 的 blind_boxes（唯一数据源，含过期盲盒完整信息）
 * → 回退到 `.data/blindbox_info/*.json`（legacy，仅补齐配置缺失的盲盒/礼物）。
 */
export async function getAllBlindBoxInfo(_mid: number, _uname: string): Promise<Record<number, BlindBoxInfo>> {
  const result: Record<number, BlindBoxInfo> = {};

  // 1) admin 配置优先
  const cfg = await readAdminConfig();
  for (const box of cfg?.blind_boxes ?? []) {
    if (box.id <= 0) continue;
    result[box.id] = {
      blind_box_id: box.id,
      blind_box_name: box.name || "",
      blind_box_img: box.icon || "",
      blind_price: box.blind_price ?? 0,
      gifts: (box.gifts ?? []).map((g) => ({
        gift_id: g.gift_id,
        price: g.price,
        gift_name: g.gift_name,
        gift_img: g.gift_img ?? "",
        is_win_gift: 0,
        chance: "",
      })),
      updated_at: getBeijingTime(),
    };
  }

  // 2) legacy 文件回退：仅补齐配置中没有、或配置中 gifts 为空的盲盒
  await ensureDir(BLIND_BOX_INFO_DIR);
  try {
    const files = await fs.readdir(BLIND_BOX_INFO_DIR);
    for (const file of files) {
      const match = file.match(/^(\d+)\.json$/);
      if (!match) continue;
      const blindBoxId = parseInt(match[1]);
      const existing = result[blindBoxId];
      if (existing && existing.gifts.length > 0) continue; // 配置已提供礼物，忽略 legacy
      const info = await getBlindBoxInfo(0, "", blindBoxId);
      if (!info) continue;
      if (existing) {
        // 配置有盲盒但无礼物：名称/单价/图标以配置非空值为准，礼物列表用 legacy
        result[blindBoxId] = {
          ...info,
          blind_box_name: existing.blind_box_name || info.blind_box_name,
          blind_box_img: existing.blind_box_img || info.blind_box_img,
          blind_price: existing.blind_price || info.blind_price,
        };
      } else {
        result[blindBoxId] = info;
      }
    }
  } catch {
    // directory doesn't exist yet
  }
  return result;
}

/** 保存盲盒信息（来自 blindFirstWin/getInfo API 响应） */
export async function saveBlindBoxInfo(
  _mid: number,
  _uname: string,
  blindBoxId: number,
  apiData: {
    gift_name: string;
    gift_img: string;
    price: number;
    gifts: Array<{
      gift_id: number;
      price: number;
      gift_name: string;
      gift_img: string;
      is_win_gift: number;
      chance: string;
    }>;
  },
) {
  await ensureDir(BLIND_BOX_INFO_DIR);
  const filePath = getBlindBoxInfoPath(blindBoxId);
  const info: BlindBoxInfo = {
    blind_box_id: blindBoxId,
    blind_box_name: apiData.gift_name,
    blind_box_img: apiData.gift_img,
    blind_price: apiData.price,
    gifts: apiData.gifts,
    updated_at: getBeijingTime(),
  };
  await fs.writeFile(filePath, JSON.stringify(info, null, 2), "utf8");
}

/**
 * 保存全局盲盒信息（仅当文件不存在时写入；已存在则直接丢弃）。
 * 盲盒信息是公开数据、人人相同，用户随数据回传时无需覆盖服务器已有副本。
 */
export async function saveBlindBoxInfoIfMissing(blindBoxId: number, content: string): Promise<boolean> {
  await ensureDir(BLIND_BOX_INFO_DIR);
  const filePath = getBlindBoxInfoPath(blindBoxId);
  try {
    await fs.access(filePath);
    return false; // 已存在，丢弃
  } catch {
    // 不存在，写入
  }
  await fs.writeFile(filePath, content, "utf8");
  return true;
}