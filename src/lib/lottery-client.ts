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
    // status 可能是 1（进行中可参与）或 2（已参与）。只要存在天选都返回，由调用方决定是否 join
    if (!anchor || !anchor.id) return null;
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

// ===== 直播间在场连接（维持"账号在直播间"的在线状态） =====

// B站 判定"是否在直播间/在线"靠的是弹幕 WebSocket 长连接（认证 + 心跳）。
// roomEntryAction 实测无效（返回 data:null，不产生任何在场凭证），因此不再调用它，
// 而是复用展示模块已验证可用的 bili-live-listener（getConf 取 token + BiliLive 弹幕长连接）
// 对目标房间建立弹幕连接，心跳持续在线，账号才算"在直播间"，这是开奖能否中奖的关键。
//
// 支持同时在多个直播间保持在线（各房开奖时间不同，需要并行在场）。每个房间一条连接，
// 幂等复用：同房间只延长断开时间、不重复建连；连接在该房间所有抽奖（天选/红包）
// 结束后 3 秒自动断开，避免长时间占用触发风控。

type PresenceConn = {
  live: any;
  room: number;
  /** 断开时间戳（ms）：该房间最后一个抽奖开奖后 3 秒 */
  deadline: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 是否已被主动关闭（主动关闭不触发重连） */
  closed: boolean;
};

const presenceMap = new Map<number, PresenceConn>();
/** 单条连接意外断开后的最大重连次数，避免被风控持续拒绝时无限重试 */
const MAX_PRESENCE_RETRY = 3;

/** 断开指定房间（不传则全部）的弹幕在场连接 */
export function closeRoomPresence(roomId?: number) {
  const destroy = (conn: PresenceConn) => {
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
    try { conn.live?.close(); } catch {}
  };
  if (roomId == null) {
    for (const conn of presenceMap.values()) destroy(conn);
    presenceMap.clear();
    return;
  }
  const conn = presenceMap.get(roomId);
  if (conn) { presenceMap.delete(roomId); destroy(conn); }
}

/** 该房间当前是否已保持在弹幕在线连接 */
export function hasRoomPresence(roomId: number): boolean {
  return presenceMap.has(roomId);
}

/** 按截止时间安排断开（房间所有抽奖结束后 3 秒） */
function schedulePresenceClose(conn: PresenceConn, deadline: number) {
  if (conn.timer) clearTimeout(conn.timer);
  conn.deadline = deadline;
  conn.timer = setTimeout(() => closeRoomPresence(conn.room), Math.max(0, deadline - Date.now()));
}

/**
 * 建立一条弹幕在场连接（不做幂等判断，调用方负责登记）。
 * 连接被意外中断（非主动关闭）时，在截止时间前自动重连并重新登记，保证开奖时仍在线。
 */
async function createPresence(platform: Platform, roomId: number, deadline: number, retries = 0): Promise<PresenceConn | null> {
  try {
    const session = await resolveSession(platform);
    if (!session || session.source === "server") return null;
    const cred = await ensureValidCredentialClient(platform, session);
    if (!cred.valid) return null;
    const uid = Number(cred.cookie.match(/DedeUserID=(\d+)/i)?.[1] ?? 0);
    if (!uid) return null;
    const reqCookie = await ensureBuvidCookie(platform, cred.cookie);
    // 弹幕服务器 token：getConf 已在客户端验证可避开 getDanmuInfo 的浏览器风控（同展示模块弹幕服务）
    const conf = await platform.fetchBilibiliJson<{ code: number; data?: { token: string } }>({
      url: `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
      cookie: reqCookie,
      live: true,
    });
    if (conf?.code !== 0 || !conf?.data?.token) {
      console.warn(`[Lottery] getConf 失败 room=${roomId} code=${conf?.code}`);
      return null;
    }
    const { BiliLive } = (await import("bili-live-listener")) as {
      BiliLive: new (roomId: number, opts: { key: string; uid: number; isBrowser: boolean }) => any;
    };
    const live = new BiliLive(roomId, { key: conf.data.token, uid, isBrowser: true });
    const conn: PresenceConn = { live, room: roomId, deadline, timer: null, closed: false };
    // 等待认证通过（onLive）后再返回：调用方"先建在场连接再参与抽奖"的顺序才真正生效，
    // 否则参与请求可能早于在线状态生效而失败。最长等待 5 秒，超时也照常返回，不阻塞参与。
    const ready = new Promise<void>((resolve) => {
      live.onLive(() => {
        console.log(`[Lottery] 弹幕在场连接已建立 room=${roomId}（认证通过，账号计为在线）`);
        resolve();
      });
      setTimeout(resolve, 5000);
    });
    live.onError((e: any) => console.warn(`[Lottery] 弹幕在场连接异常 room=${roomId}`, e?.message || e));
    live.onClose(() => {
      // 主动关闭（到点断开/停止）不重连
      if (conn.closed) return;
      // 已被新连接取代时不再处理
      if (presenceMap.get(roomId) !== conn) return;
      presenceMap.delete(roomId);
      if (conn.timer) { clearTimeout(conn.timer); conn.timer = null; }
      if (Date.now() >= deadline || retries >= MAX_PRESENCE_RETRY) return;
      console.log(`[Lottery] 弹幕在场连接中断，重连 room=${roomId}（第 ${retries + 1} 次）`);
      createPresence(platform, roomId, deadline, retries + 1).then((c) => {
        if (c && !c.closed) presenceMap.set(roomId, c);
      });
    });
    schedulePresenceClose(conn, deadline);
    await ready;
    return conn;
  } catch (e) {
    console.warn("[Lottery] 建立弹幕在场连接失败", e);
    return null;
  }
}

/**
 * 建立/延长指定房间的弹幕在场连接。
 * - 幂等：同一房间已连接时只延长断开时间，不重复建连
 * - untilTsSec：该房间最后一个抽奖（天选/红包）的开奖时间（秒），连接在结束后 3 秒断开
 * 失败静默返回 false，不影响参与抽奖
 */
async function ensureRoomPresence(platform: Platform, roomId: number, untilTsSec: number): Promise<boolean> {
  const deadline = untilTsSec * 1000 + 3000;
  const existing = presenceMap.get(roomId);
  if (existing) {
    if (deadline > existing.deadline) {
      schedulePresenceClose(existing, deadline);
      console.log(`[Lottery] 弹幕在场连接已延长 room=${roomId} 至 ${new Date(deadline).toLocaleTimeString()}`);
    }
    return true;
  }
  const conn = await createPresence(platform, roomId, deadline);
  if (!conn) return false;
  presenceMap.set(roomId, conn);
  return true;
}

/**
 * Tauri 直连：在直播间保持在线（弹幕 WS 长连接）
 * @param untilTsSec 该房间最后一个抽奖的开奖时间（秒），连接在结束后 3 秒断开
 */
export async function enterRoomNative(platform: Platform, roomId: number, untilTsSec?: number): Promise<ApiResult> {
  const until = untilTsSec ?? Math.floor(Date.now() / 1000);
  const ok = await ensureRoomPresence(platform, roomId, until);
  console.log(`[Lottery] enterRoom room=${roomId} presence=${ok ? "已建立弹幕在线" : "未建立在场"}`);
  return ok ? { code: 0 } : { code: -1, message: "建立弹幕在场连接失败" };
}

/**
 * Web 模式进入直播间（走服务器代理）
 */
export async function enterRoomServer(roomId: number): Promise<ApiResult> {
  return serverPost<ApiResult>("/api/lottery/enter-room", { room_id: roomId });
}

/**
 * 统一入口：在直播间保持在线。
 * @param untilTsSec 该房间最后一个抽奖的开奖时间（秒），连接在结束后 3 秒自动断开
 */
export async function enterRoom(roomId: number, untilTsSec: number): Promise<boolean> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    const r = await enterRoomNative(platform, roomId, untilTsSec);
    return r.code === 0;
  }
  const r = await enterRoomServer(roomId);
  return r?.code === 0;
}

// ===== 红包（人气红包）检测与参与 =====

/** 红包奖品 */
export type RedPocketAward = {
  gift_id: number;
  num: number;
  gift_name: string;
  gift_pic: string;
};

/** 红包信息（RedPocketActiveList 列表项） */
export type RedPocketInfo = {
  lot_id: number;
  awards: RedPocketAward[];
  end_time: number;
  current_time: number;
  lot_status: number;
  user_status: number;
  /** 红包类型：0=礼物 3=电池 4=亲密度（不抢不显示），另有上舰红包 */
  rp_type?: number;
  /** 总价值（分），电池红包需 /100 */
  total_price?: number;
  /** 红包发送者 UID */
  sender_uid?: number;
  icon_url?: string;
  need_follow?: boolean;
};

/** 红包房间（含倒计时信息） */
export type RedPocketRoom = {
  roomid: number;
  uname: string;
  redPocket: RedPocketInfo;
  end_time: number;
};

/** 客户端红包参与使用的固定 statistics 参数（Android App 9.8.0） */
const RED_POCKET_STATISTICS = JSON.stringify({ appId: 1, version: "9.8.0", abtest: "", platform: 3 });

/** 从活跃列表里筛出所有进行中的红包（lot_status=1） */
function pickActiveRedPockets(list: RedPocketInfo[] | undefined | null): RedPocketInfo[] {
  if (!list || list.length === 0) return [];
  // 亲密度红包（rp_type=4）不抢不显示
  return list.filter((rp) => rp.lot_status === 1 && rp.rp_type !== 4);
}

/** 取红包内数量最大的礼物（用于节省空间只显示一个） */
export function pickLargestGift(awards?: RedPocketAward[]): RedPocketAward | null {
  if (!awards || awards.length === 0) return null;
  return [...awards].sort((a, b) => b.num - a.num)[0];
}

/** 提取红包参与请求的 csrf */
function extractCsrf(cred: { cookie: string; session: { biliCookies?: string[] } }): string {
  return extractCookieValue(cred.session.biliCookies ?? [], "bili_jct")
    || cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1]
    || "";
}

/**
 * Tauri 直连检测指定房间的所有红包
 */
export async function checkRedPocketNative(platform: Platform, roomId: number): Promise<RedPocketInfo[]> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") {
    console.warn(`[RedPocket] check room=${roomId}: 未登录或服务器账号`);
    return [];
  }
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) return [];
  const csrf = extractCsrf(cred);
  if (!csrf) return [];

  // Wbi 签名（含 csrf/mobi_app/platform/room_id/statistics/web_location，同用户提供的示例）
  const signedParams = await signWbiParams(platform, {
    csrf,
    mobi_app: "android",
    platform: "android",
    room_id: String(roomId),
    statistics: RED_POCKET_STATISTICS,
    web_location: "444.248",
  });
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketActiveList?${new URLSearchParams(signedParams).toString()}`;
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);
  try {
    const data = await platform.fetchBilibiliJson<ApiResult<{ list: RedPocketInfo[] }>>({
      url,
      cookie: reqCookie,
      live: true,
    });
    const active = pickActiveRedPockets(data.data?.list);
    console.log(`[RedPocket] room=${roomId} code=${data.code} list=${active.length} statuses=${active.map((rp) => rp.user_status).join(",")} types=${active.map((rp) => rp.rp_type).join(",")} total=${active.map((rp) => rp.total_price).join(",")}`);
    if (data.code !== 0) return [];
    return active;
  } catch {
    return [];
  }
}

/**
 * Tauri 直连参与红包抽奖
 */
export async function drawRedPocketNative(platform: Platform, roomId: number, lotId: number, ruid: number): Promise<ApiResult> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") return { code: -1, message: "服务器账号无法参与红包" };
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) return { code: -1, message: "登录凭证失效" };
  const csrf = extractCsrf(cred);
  if (!csrf) return { code: -1, message: "未找到 csrf" };

  const uid = Number(cred.cookie.match(/DedeUserID=(\d+)/i)?.[1] ?? 0);

  // query：Wbi 签名参数（同抓包请求），POST body 放参与参数
  const signedParams = await signWbiParams(platform, {
    csrf,
    mobi_app: "android",
    platform: "android",
    statistics: RED_POCKET_STATISTICS,
  });
  const query = new URLSearchParams(signedParams).toString();
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketDraw?${query}`;
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);
  const buvid = reqCookie.match(/buvid3=([^;]+)/i)?.[1] ?? "";
  const body = JSON.stringify({
    uid,
    room_id: roomId,
    ruid,
    lot_id: lotId,
    spm_id: "live.live-room-detail.red-envelope.extract",
    jump_from: "27007",
    session_id: "-99998",
    statistics: JSON.stringify({ appId: 0, platform: 3, version: "9.8.0", abtest: "" }),
    live_statistics: JSON.stringify({
      pc_client: "pink",
      jumpfrom: "-99998",
      source_event: "0",
      room_category: "0",
      official_channel: "-99998",
      screen_status: "-99998",
      room_id: "-99998",
      up_id: "-99998",
      parent_area_id: "-99998",
      area_id: "-99998",
      live_status: "-99998",
      spm_id: "-99998",
      session_id: "-99998",
      launch_id: "-99998",
      simple_id: "-99998",
      av_id: "-99998",
      flow_extend: "-99998",
      bussiness_extend: "-99998",
      data_extend: "-99998",
      trackid: "-99998",
      action_id: "-99998",
      user_status: "2",
      buvid,
    }),
  });
  console.log(`[RedPocket] draw room=${roomId} lot=${lotId} query=${query} body=${body}`);
  const data = await platform.fetchBilibiliJson<ApiResult>({
    url,
    method: "POST",
    body,
    json: true,
    cookie: reqCookie,
    live: true,
  });
  console.log(`[RedPocket] draw room=${roomId} lot=${lotId} code=${data.code} msg=${data.message || data.msg || ""}`);
  return data;
}

/**
 * Web 模式检测红包（走服务器代理）
 */
export async function checkRedPocketServer(roomId: number): Promise<RedPocketInfo[]> {
  const r = await serverPost<ApiResult<{ red_pockets: RedPocketInfo[] }>>("/api/lottery/redpocket", {
    _action: "check",
    room_id: roomId,
  });
  if (r.code !== 0) return [];
  const list = r.data?.red_pockets ?? [];
  return list.filter((rp) => rp.lot_status === 1);
}

/**
 * Web 模式参与红包（走服务器代理）
 */
export async function drawRedPocketServer(roomId: number, lotId: number, ruid: number): Promise<ApiResult> {
  return serverPost<ApiResult>("/api/lottery/redpocket", {
    _action: "draw",
    room_id: roomId,
    lot_id: lotId,
    ruid,
  });
}

/**
 * 统一入口：检测指定房间的所有红包
 */
export async function checkRedPocket(roomId: number): Promise<RedPocketInfo[]> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) return checkRedPocketNative(platform, roomId);
  return checkRedPocketServer(roomId);
}

/**
 * 统一入口：参与红包抽奖
 */
export async function drawRedPocket(roomId: number, lotId: number, ruid: number): Promise<ApiResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) return drawRedPocketNative(platform, roomId, lotId, ruid);
  return drawRedPocketServer(roomId, lotId, ruid);
}

/** 计算红包开奖时间戳（秒） */
export function calcRedPocketEndTime(rp: RedPocketInfo): number {
  return rp.end_time;
}

// ===== 工具函数 =====

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 计算开奖时间戳（秒）
 */
export function calcEndTime(lottery: LotteryInfo): number {
  // 已参与(status=2)时 B站 可能不返回剩余秒 time，取 0 保证仍能算出时间戳用于显示
  return (lottery.current_time || 0) + (lottery.time || 0);
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
