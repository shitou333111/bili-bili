/**
 * 自动抢天选福袋 - 客户端逻辑
 *
 * 功能：
 * 1. 检测直播间是否有天选福袋（需要登录）
 * 2. 参与天选抽奖（需要登录）
 * 3. 进入直播间（需要登录，中奖条件）
 *
 * 平台差异：
 * - Tauri（原生）：直接连 B站 接口（需传入 platform）
 * - Web：走服务器代理 /api/lottery/*
 */

import { getPlatform, type Platform } from "./platform";
import { resolveSession } from "./stats-client";
import {
  ensureValidCredentialClient,
  extractCookieValue,
} from "./bilibili/cookie-refresh-client";
import { serverPost } from "./server-api";
import { md5 } from "./md5";

// ===== Wbi 签名（B站 风控要求） =====

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let cachedMixinKey: { key: string; ts: number } | null = null;

function getMixinKey(raw: string): string {
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function fetchMixinKey(platform: Platform): Promise<string> {
  if (cachedMixinKey && Date.now() - cachedMixinKey.ts < 25 * 60 * 1000) {
    return cachedMixinKey.key;
  }
  const data = await platform.fetchBilibiliJson<{
    code: number;
    data?: { wbi_img: { img_url: string; sub_url: string } };
  }>({
    url: "https://api.bilibili.com/x/web-interface/nav",
    live: true,
  });
  const imgUrl = data.data?.wbi_img?.img_url ?? "";
  const subUrl = data.data?.wbi_img?.sub_url ?? "";
  const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
  const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";
  if (!imgKey || !subKey) throw new Error("获取 Wbi 密钥失败");
  const key = getMixinKey(imgKey + subKey);
  cachedMixinKey = { key, ts: Date.now() };
  return key;
}

/** 对参数进行 Wbi 签名，返回附加 w_rid 和 wts 的参数 */
async function signWbiParams(platform: Platform, params: Record<string, string>): Promise<Record<string, string>> {
  const mixinKey = await fetchMixinKey(platform);
  const wts = String(Math.floor(Date.now() / 1000));
  const signed: Record<string, string> = { ...params, wts };
  const chrFilter = /[!'()*]/g;
  const query = Object.keys(signed)
    .sort()
    .map((k) => {
      let v = signed[k];
      if (typeof v === "string") v = v.replace(chrFilter, "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");
  const w_rid = md5(query + mixinKey);
  return { ...signed, w_rid };
}

/**
 * 确保 Cookie 携带 buvid3/buvid4 设备指纹（B站 风控要求，同 like-client.ts 做法）
 * 缺失时通过 SPI 接口补齐；获取失败时返回原 cookie
 */
async function ensureBuvidCookie(platform: Platform, cookie: string): Promise<string> {
  try {
    if (/buvid3\s*=/i.test(cookie)) return cookie;
    const buvidCookie = await platform.getBuvidCookie();
    return buvidCookie ? `${buvidCookie}; ${cookie}` : cookie;
  } catch {
    return cookie;
  }
}

// ===== 类型定义 =====

/** 天选福袋信息 */
export type LotteryInfo = {
  /** 抽奖 ID */
  id: number;
  /** 房间 ID */
  room_id: number;
  /** 状态：1=进行中 */
  status: number;
  /** 奖品名称 */
  award_name: string;
  /** 奖品数量 */
  award_num: number;
  /** 奖品图标 URL */
  award_image?: string;
  /** 弹幕要求 */
  danmu: string;
  /** 剩余倒计时（秒） */
  time: number;
  /** 服务器当前时间 */
  current_time: number;
  /** 参与条件文本 */
  require_text: string;
  /** 参与条件类型 */
  require_type: number;
  /** 关注的主播 UID */
  ruid: number;
};

/** 天选福袋房间（含倒计时信息） */
export type LotteryRoom = {
  roomid: number;
  uname: string;
  title: string;
  face: string;
  online: number;
  /** 抽奖信息 */
  lottery: LotteryInfo;
  /** 开奖时间戳（秒） */
  end_time: number;
};

/** API 通用返回 */
export type ApiResult<T = unknown> = {
  code: number;
  message?: string;
  msg?: string;
  data?: T;
};

// ===== 天选福袋检测（需要登录） =====

/**
 * Tauri 直连检测指定房间是否有天选福袋
 */
export async function checkLotteryNative(platform: Platform, roomId: number): Promise<LotteryInfo | null> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") {
    console.warn(`[Lottery] checkLottery room=${roomId}: 未登录或服务器账号`);
    return null;
  }
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) {
    console.warn(`[Lottery] checkLottery room=${roomId}: 登录凭证失效`);
    return null;
  }

  // Wbi 签名参数
  const signedParams = await signWbiParams(platform, {
    roomid: String(roomId),
    need_guard: "true",
    web_location: "444.8",
  });
  const qs = new URLSearchParams(signedParams).toString();
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?${qs}`;
  // B站 风控要求 Cookie 携带 buvid3 设备指纹（同 like-client.ts 做法）
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);
  console.log(`[Lottery] room=${roomId} signed_params:`, JSON.stringify(signedParams));
  console.log(`[Lottery] room=${roomId} cookie_len:`, reqCookie.length);
  try {
    const data = await platform.fetchBilibiliJson<ApiResult<{ anchor: LotteryInfo | null }>>({
      url,
      cookie: reqCookie,
      live: true,
    });
    console.log(`[Lottery] room=${roomId} code=${data.code} anchor=${data.data?.anchor ? "有" : "无"} status=${data.data?.anchor?.status}`);
    if (data.code !== 0) return null;
    const anchor = data.data?.anchor;
    if (!anchor || anchor.status !== 1) return null;
    return anchor;
  } catch (err) {
    console.warn(`[Lottery] room=${roomId} 异常:`, err);
    return null;
  }
}

/**
 * Web 模式检测天选（走服务器代理）
 */
export async function checkLotteryServer(roomId: number): Promise<LotteryInfo | null> {
  const r = await serverPost<ApiResult<{ anchor: LotteryInfo | null }>>("/api/lottery/check", { room_id: roomId });
  if (r.code !== 0) throw new Error(r.message || "检测天选失败");
  const anchor = r.data?.anchor;
  if (!anchor || anchor.status !== 1) return null;
  return anchor;
}

/**
 * 统一入口：检测指定房间是否有天选福袋
 */
export async function checkLottery(roomId: number): Promise<LotteryInfo | null> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return checkLotteryNative(platform, roomId);
  }
  return checkLotteryServer(roomId);
}

// ===== 参与抽奖（需要登录） =====

/**
 * Tauri 直连参与天选抽奖
 */
export async function joinLotteryNative(
  platform: Platform,
  lotteryId: number,
  roomId: number,
): Promise<ApiResult> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") {
    return { code: -1, message: "服务器账号无法参与抽奖" };
  }
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) return { code: -1, message: "登录凭证失效" };

  const csrf = extractCookieValue(cred.session.biliCookies ?? [], "bili_jct")
    || cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1]
    || "";
  if (!csrf) return { code: -1, message: "未找到 csrf" };

  const params: Record<string, string> = {
    csrf,
    follow: "true",
    id: String(lotteryId),
    jump_from_str: "",
    live_statistics: JSON.stringify({
      pc_client: "pink",
      jumpfrom: "-99998",
      room_category: "0",
      lottery_id: lotteryId,
      lottery_type: 1,
      trackid: "-99998",
    }),
    platform: "pc",
    room_id: String(roomId),
    session_id: "",
    spm_id: "444.8.interaction.anchor_draw_auto",
  };
  // Wbi 签名（签名输入包含 body 参数，w_rid/wts 放 query，同 getLotteryInfoWeb 做法）
  const wbi = await signWbiParams(platform, params);
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/Anchor/Join?w_rid=${encodeURIComponent(wbi.w_rid)}&wts=${wbi.wts}`;
  const body = new URLSearchParams(params).toString();
  // B站 风控要求 Cookie 携带 buvid3 设备指纹
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);

  const data = await platform.fetchBilibiliJson<ApiResult>({
    url,
    method: "POST",
    body,
    cookie: reqCookie,
    live: true,
  });
  return data;
}

/**
 * Web 模式参与抽奖（走服务器代理）
 */
export async function joinLotteryServer(lotteryId: number, roomId: number): Promise<ApiResult> {
  return serverPost<ApiResult>("/api/lottery/join", {
    id: lotteryId,
    room_id: roomId,
  });
}

/**
 * 统一入口：参与天选抽奖
 */
export async function joinLottery(lotteryId: number, roomId: number): Promise<ApiResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return joinLotteryNative(platform, lotteryId, roomId);
  }
  return joinLotteryServer(lotteryId, roomId);
}

// ===== 进入直播间（需要登录） =====

/**
 * Tauri 直连进入直播间（roomEntryAction）
 */
export async function enterRoomNative(platform: Platform, roomId: number): Promise<ApiResult> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") {
    return { code: -1, message: "服务器账号无法进入直播间" };
  }
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) return { code: -1, message: "登录凭证失效" };

  const csrf = extractCookieValue(cred.session.biliCookies ?? [], "bili_jct")
    || cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1]
    || "";
  // Wbi 签名（csrf/room_id/platform 参与签名，query 放 csrf+w_rid+wts，同用户提供的示例）
  const wbi = await signWbiParams(platform, {
    csrf,
    room_id: String(roomId),
    platform: "pc",
  });
  const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/roomEntryAction?csrf=${encodeURIComponent(csrf)}&w_rid=${encodeURIComponent(wbi.w_rid)}&wts=${wbi.wts}`;
  // B站 风控要求 Cookie 携带 buvid3 设备指纹
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);

  const data = await platform.fetchBilibiliJson<ApiResult>({
    url,
    method: "POST",
    body: new URLSearchParams({ room_id: String(roomId), platform: "pc" }).toString(),
    cookie: reqCookie,
    live: true,
  });
  return data;
}

/**
 * Web 模式进入直播间（走服务器代理）
 */
export async function enterRoomServer(roomId: number): Promise<ApiResult> {
  return serverPost<ApiResult>("/api/lottery/enter-room", { room_id: roomId });
}

/**
 * 统一入口：进入直播间
 */
export async function enterRoom(roomId: number): Promise<ApiResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return enterRoomNative(platform, roomId);
  }
  return enterRoomServer(roomId);
}

// ===== 工具函数 =====

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 计算开奖时间戳（秒）
 */
export function calcEndTime(lottery: LotteryInfo): number {
  return lottery.current_time + lottery.time;
}

/**
 * 过滤间隔太近的天选（< 6秒的跳过第二个）
 */
export function filterCloseLotteries(lotteries: LotteryRoom[]): LotteryRoom[] {
  if (lotteries.length <= 1) return lotteries;
  const sorted = [...lotteries].sort((a, b) => a.end_time - b.end_time);
  const result: LotteryRoom[] = [sorted[0]];
  let lastEndTime = sorted[0].end_time;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].end_time - lastEndTime;
    if (gap >= 6) {
      result.push(sorted[i]);
      lastEndTime = sorted[i].end_time;
    }
    // gap < 6: 跳过这个，不更新 lastEndTime
  }
  return result;
}

/**
 * 距离下一个整点或半点的毫秒数
 */
export function msToNextHalfHour(): number {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const ms = now.getMilliseconds();
  const offsetSeconds = minutes * 60 + seconds + ms / 1000;
  if (minutes < 30) return Math.max((30 * 60 - offsetSeconds) * 1000, 1000);
  return Math.max((60 * 60 - offsetSeconds) * 1000, 1000);
}

/** 修正头像 URL：补全 https: 前缀，过滤 noface */
function fixFaceUrl(url: string): string {
  if (!url || /\/noface\.jpg$/.test(url)) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

// ===== 通过 UID 获取房间信息 =====

/**
 * 通过 UID 获取直播间信息
 * 参照 gift-api.ts 的 getUserInfoByUid：使用 card_up API 获取昵称和头像
 */
export async function fetchRoomInfoByUid(uid: number): Promise<{ roomid: number; uname: string; title: string; face: string; online: number } | null> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    // 1. getRoomInfoOld 获取 roomid
    const roomData = await platform.fetchBilibiliJson<{
      code: number;
      data?: { roomid: number; liveStatus: number; title?: string };
    }>({
      url: `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`,
      live: true,
    });
    if (roomData.code !== 0 || !roomData.data || roomData.data.roomid <= 0) return null;
    const roomid = roomData.data.roomid;
    // 2. card_up API 获取昵称和头像（参照 gift-api.ts）
    let uname = `UID${uid}`, face = "", title = roomData.data.title ?? "", online = 0;
    try {
      const cardData = await platform.fetchBilibiliJson<{
        code: number;
        data?: { uname: string; face: string };
      }>({
        url: `https://api.live.bilibili.com/live_user/v1/card/card_up?uid=${uid}&browser=0`,
        live: true,
      });
      if (cardData.code === 0 && cardData.data) {
        uname = cardData.data.uname || uname;
        face = fixFaceUrl(cardData.data.face ?? "");
      }
    } catch {}
    // 3. getRoomBaseInfo 补充在线人数
    try {
      const baseData = await platform.fetchBilibiliJson<{
        code: number;
        data?: { by_room_ids?: Record<string, { online: number }> };
      }>({
        url: `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?room_ids=${roomid}&req_biz=web-room`,
        live: true,
      });
      const room = baseData.data?.by_room_ids?.[String(roomid)];
      if (room) online = room.online;
    } catch {}
    return { roomid, uname, title, face, online };
  }
  // Web：走服务器代理
  try {
    const { serverFetch } = await import("./server-api");
    const r = await serverFetch<ApiResult<{ roomid: number; uname: string; title: string; face: string; online: number }>>(
      `/api/lottery/check?_action=roominfo_by_uid&uid=${uid}`,
    );
    if (r.code === 0 && r.data) return r.data;
    return null;
  } catch { return null; }
}

// ===== 本地持久化：Tauri → JSON 文件，Web → localStorage =====

const LOTTERY_ROOMS_KEY = "auto-lottery-rooms";

export type SavedRoom = {
  uid: number;
  roomid: number;
  uname: string;
  title: string;
  face: string;
  online: number;
};

export async function loadSavedLotteryRooms(): Promise<SavedRoom[]> {
  try {
    const platform: Platform = await getPlatform();
    if (platform.isNative) {
      const state = await platform.getSessionState();
      const session = state.sessions.find((s) => s.sid === state.currentSid);
      if (!session) return [];
      const filePath = `${await platform.getDataDir()}/uid_${session.mid}/${LOTTERY_ROOMS_KEY}.json`;
      if (!(await platform.exists(filePath))) return [];
      const raw = await platform.readFile(filePath);
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }
    // Web：localStorage
    const raw = localStorage.getItem(LOTTERY_ROOMS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveLotteryRooms(rooms: SavedRoom[]): Promise<void> {
  try {
    const platform: Platform = await getPlatform();
    if (platform.isNative) {
      const state = await platform.getSessionState();
      const session = state.sessions.find((s) => s.sid === state.currentSid);
      if (!session) return;
      const dir = `${await platform.getDataDir()}/uid_${session.mid}`;
      await platform.mkdir(dir);
      await platform.writeFile(`${dir}/${LOTTERY_ROOMS_KEY}.json`, JSON.stringify(rooms, null, 2));
    } else {
      localStorage.setItem(LOTTERY_ROOMS_KEY, JSON.stringify(rooms));
    }
  } catch { /* 写入失败不影响使用 */ }
}
