"use client";

/**
 * 活动（山海工坊）本地状态持久化
 *
 * 保存两块内容到 <appDataDir>/data/activity-state.json：
 *  - slot_state：各槽位已抽取的材料（key=槽位号，value=材料序号），用于下次打开还原抽取状态
 *  - bag_gifts：合成得到的礼物（放入礼物栏"包裹"选项卡），含数量，用于下次打开还原包裹
 *
 * 读写通过平台抽象层（Tauri 原生文件系统）；浏览器环境无原生文件系统，读写会静默失败。
 */

import type { Gift } from "./types";
import { getPlatform } from "@/lib/platform";

/** 包裹礼物：礼物信息 + 数量 */
export interface BagGift extends Gift {
  count: number;
}

export interface ActivityState {
  slot_state: Record<string, number>;
  bag_gifts: BagGift[];
}

const FILE_NAME = "activity-state.json";

async function getStatePath(): Promise<string> {
  const platform = await getPlatform();
  return `${await platform.getDataDir()}/${FILE_NAME}`;
}

/** 读取活动本地状态（失败或不存在时返回空状态） */
export async function readActivityState(): Promise<ActivityState> {
  try {
    const platform = await getPlatform();
    const p = await getStatePath();
    if (await platform.exists(p)) {
      const raw = await platform.readFile(p);
      const parsed = JSON.parse(raw) as Partial<ActivityState>;
      return {
        slot_state:
          parsed.slot_state && typeof parsed.slot_state === "object"
            ? parsed.slot_state
            : {},
        bag_gifts: Array.isArray(parsed.bag_gifts) ? (parsed.bag_gifts as BagGift[]) : [],
      };
    }
  } catch (e) {
    console.warn("[ActivityState] 读取活动状态失败:", e);
  }
  return { slot_state: {}, bag_gifts: [] };
}

/** 写入活动本地状态 */
export async function writeActivityState(state: ActivityState): Promise<void> {
  try {
    const platform = await getPlatform();
    const p = await getStatePath();
    await platform.writeFile(p, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn("[ActivityState] 写入活动状态失败:", e);
  }
}
