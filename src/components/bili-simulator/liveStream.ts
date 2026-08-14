/**
 * B站直播流获取工具
 *
 * 通过 B站公开 API 获取直播间信息与 HLS 流地址：
 * 1. UID → room_id/昵称/头像：get_status_info_by_uids
 * 2. room_id → HLS 流地址：playUrl (platform=h5)
 *
 * API 调用通过 Tauri 的 fetch_json 命令（避免 CORS），
 * 浏览器环境降级为直接 fetch。
 */

export interface StreamerInfo {
  uid: number;
  roomId: number;
  uname: string;
  face: string;
  liveStatus: number; // 0=未开播, 1=直播中, 2=轮播
  title: string;
}

/** 历史记录条目 */
export interface HistoryEntry {
  uid: number;
  roomId: number;
  uname: string;
  face: string;
}

const HISTORY_KEY = "bili_sim_history";
const MAX_HISTORY = 10;

/** 历史记录的 badge 颜色池 */
export const BADGE_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#FFA07A", "#98D8C8",
  "#F7DC6F", "#BB8FCE", "#85C1E2", "#F8B739", "#52BE80",
];

/** 获取历史记录列表（从新到旧） */
export function getHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** 添加历史记录（去重、从新到旧、最多 MAX_HISTORY 条） */
export function addHistory(entry: HistoryEntry): HistoryEntry[] {
  let list = getHistory().filter((e) => e.uid !== entry.uid);
  list.unshift(entry);
  if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {}
  return list;
}

/** 获取 badge 颜色（按 uid 取模分配稳定颜色） */
export function getBadgeColor(uid: number): string {
  return BADGE_COLORS[uid % BADGE_COLORS.length];
}

/** 通过 Tauri fetch_json 或浏览器 fetch 获取 JSON */
async function fetchJSON(url: string): Promise<any> {
  // Tauri 环境：用 fetch_json 命令避免 CORS
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke("fetch_json", { url });
    } catch (e) {
      console.error("fetch_json error:", e);
      throw e;
    }
  }
  // 浏览器环境：直接 fetch
  const resp = await fetch(url);
  return resp.json();
}

/**
 * 通过 UID 获取主播直播间信息
 * API: get_status_info_by_uids
 */
export async function getStreamerInfoByUid(uid: number): Promise<StreamerInfo> {
  const url = `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${uid}`;
  const data = await fetchJSON(url);
  if (data.code !== 0) throw new Error(`获取主播信息失败: ${data.message || data.msg}`);
  const info = data.data[String(uid)];
  if (!info) throw new Error("未找到该UID对应的主播信息");
  return {
    uid,
    roomId: info.room_id,
    uname: info.uname,
    face: info.face,
    liveStatus: info.live_status,
    title: info.title,
  };
}

/**
 * 通过 room_id 获取 HLS 直播流地址
 * API: playUrl (platform=h5 返回 HLS/m3u8)
 * @returns HLS 流 URL，未开播时返回 null
 */
export async function getLiveStreamUrl(roomId: number): Promise<string | null> {
  const url = `https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${roomId}&platform=h5&qn=0`;
  const data = await fetchJSON(url);
  if (data.code !== 0) throw new Error(`获取直播流失败: ${data.message || data.msg}`);
  const durl = data.data?.durl;
  if (!durl || !durl.length) return null;
  return durl[0].url;
}
