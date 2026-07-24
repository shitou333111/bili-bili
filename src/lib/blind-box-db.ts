import { promises as fs } from "fs";
import path from "path";

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

/** 获取所有盲盒信息 */
export async function getAllBlindBoxInfo(_mid: number, _uname: string): Promise<Record<number, BlindBoxInfo>> {
  await ensureDir(BLIND_BOX_INFO_DIR);
  const result: Record<number, BlindBoxInfo> = {};
  try {
    const files = await fs.readdir(BLIND_BOX_INFO_DIR);
    for (const file of files) {
      const match = file.match(/^(\d+)\.json$/);
      if (match) {
        const blindBoxId = parseInt(match[1]);
        const info = await getBlindBoxInfo(0, "", blindBoxId);
        if (info) {
          result[blindBoxId] = info;
        }
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