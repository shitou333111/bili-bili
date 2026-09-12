/**
 * 自动抢天选福袋 - 客户端逻辑
 *
 * 功能：
 * 1. 检测直播间是否有天选福袋（需要登录）
 * 2. 参与天选抽奖（需要登录）
 * 3. 进入直播间（需要登录，中奖条件）
 *
 * 仅 Tauri（原生）实现：直接连 B站 接口（需传入 platform），Web 端不提供该功能。
 */

import { getPlatform, type Platform } from "./platform";
import { resolveSession } from "./stats-client";
import {
  ensureValidCredentialClient,
  extractCookieValue,
} from "./bilibili/cookie-refresh-client";
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

// B站 对 getLotteryInfo 存在基于请求频率的风控：一次扫描集中请求大量房间后，
// 后续请求会持续返回 -352（即用户反馈的"前期还好、后期全是 -352"）。
// 这里做客户端自适应限流：
// 1) 相邻请求保持最小间隔，避免突发流量；
// 2) 命中 -352 时指数退避进入冷却，冷却期内直接跳过、不再发请求；
// 3) 请求成功后立即清零退避，恢复正常速率。
const LOTTERY_MIN_INTERVAL_MS = 400;
const LOTTERY_BACKOFF_BASE_MS = 5000;
const LOTTERY_BACKOFF_MAX_MS = 60000;

/** 下一次允许发起天选请求的最早时间戳（ms） */
let lotteryNextAllowedAt = 0;
/** 限流冷却截止时间戳（ms）：冷却期内跳过请求 */
let lotteryBlockedUntil = 0;
/** 连续命中 -352 的次数，用于指数退避 */
let lotteryBlockedStreak = 0;
/** 累计命中 -352 的次数，供调用方判断扫描期间是否被限流 */
let lotteryBlockedCount = 0;

/** 累计被天选接口风控（-352）拦截的次数 */
export function getLotteryBlockedCount(): number {
  return lotteryBlockedCount;
}

/** 等待到下一个允许发送天选请求的时间点，并占位下一次请求时刻 */
async function acquireLotterySlot(): Promise<void> {
  const wait = lotteryNextAllowedAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lotteryNextAllowedAt = Date.now() + LOTTERY_MIN_INTERVAL_MS;
}

/**
 * Tauri 直连检测指定房间是否有天选福袋
 */
export async function checkLotteryNative(platform: Platform, roomId: number): Promise<LotteryInfo | null> {
  const session = await resolveSession(platform);
  if (!session || session.source === "server") {
    console.warn(`[Lottery] checkLottery room=${roomId}: 未登录或服务器账号`);
    return null;
  }
  // 处于限流冷却期：直接跳过，避免继续触发风控
  if (Date.now() < lotteryBlockedUntil) return null;
  const cred = await ensureValidCredentialClient(platform, session);
  if (!cred.valid) {
    console.warn(`[Lottery] checkLottery room=${roomId}: 登录凭证失效`);
    return null;
  }

  // 使用非 Web 版 getLotteryInfo：Web 版 getLotteryInfoWeb 已被 B站 按接口维度风控
  // （无论 cookie/签名/Referer 如何都固定返回 -352），该接口无需 wbi 签名 /
  // need_guard / web_location，返回的 data.anchor 字段与 LotteryInfo 结构兼容。
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfo?roomid=${roomId}`;
  // B站 风控要求 Cookie 携带 buvid3 设备指纹（同 like-client.ts 做法）
  const reqCookie = await ensureBuvidCookie(platform, cred.cookie);
  try {
    // 限流：相邻请求保持最小间隔
    await acquireLotterySlot();
    const data = await platform.fetchBilibiliJson<ApiResult<{ anchor: LotteryInfo | null }>>({
      url,
      cookie: reqCookie,
      live: true,
    });
    console.log(`[Lottery] room=${roomId} code=${data.code} anchor=${data.data?.anchor ? "有" : "无"} status=${data.data?.anchor?.status}`);
    if (data.code === -352) {
      // 命中风控：指数退避冷却，冷却期内后续请求直接跳过
      lotteryBlockedStreak += 1;
      lotteryBlockedCount += 1;
      const backoff = Math.min(LOTTERY_BACKOFF_MAX_MS, LOTTERY_BACKOFF_BASE_MS * 2 ** (lotteryBlockedStreak - 1));
      lotteryBlockedUntil = Date.now() + backoff;
      lotteryNextAllowedAt = Math.max(lotteryNextAllowedAt, lotteryBlockedUntil);
      console.warn(`[Lottery] room=${roomId} 触发风控 -352，冷却 ${Math.round(backoff / 1000)}s（连续第 ${lotteryBlockedStreak} 次）`);
      return null;
    }
    if (data.code !== 0) return null;
    // 成功：清零退避，恢复正常速率
    lotteryBlockedStreak = 0;
    lotteryBlockedUntil = 0;
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
 * 统一入口：检测指定房间是否有天选福袋（仅客户端支持）
 */
export async function checkLottery(roomId: number): Promise<LotteryInfo | null> {
  const platform: Platform = await getPlatform();
  if (!platform.isNative) return null;
  return checkLotteryNative(platform, roomId);
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
 * 统一入口：参与天选抽奖（仅客户端支持）
 */
export async function joinLottery(lotteryId: number, roomId: number): Promise<ApiResult> {
  const platform: Platform = await getPlatform();
  if (!platform.isNative) return { code: -1, message: "该功能仅支持客户端" };
  return joinLotteryNative(platform, lotteryId, roomId);
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
 * 统一入口：在直播间保持在线（仅客户端支持）。
 * @param untilTsSec 该房间最后一个抽奖的开奖时间（秒），连接在结束后 3 秒自动断开
 */
export async function enterRoom(roomId: number, untilTsSec: number): Promise<boolean> {
  const platform: Platform = await getPlatform();
  if (!platform.isNative) return false;
  const r = await enterRoomNative(platform, roomId, untilTsSec);
  return r.code === 0;
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
 * 携带完整反风控头和真实直播间参数，模仿 Android 客户端人工操作行为
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

  // 从 cookie 提取 guestid（_uuid 或 buvid 的 32 位形式），回退用 buvid
  const guestid = reqCookie.match(/guest_id[=:]([^;]+)/i)?.[1]
    ?? reqCookie.match(/_uuid=([^;]+)/i)?.[1]
    ?? buvid.replace(/-/g, "");
  // fingerprint：取 buvid 去连字符 + 随机填充到 64 位 hex，模拟 fp_local/fp_remote
  const fpRaw = buvid.replace(/-/g, "") + Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const fp = fpRaw.slice(0, 64);
  // session_id 从 referer 中提取（红包弹窗 URL 里的 sessionId），回退 -99998
  const refererSessionId = "-99998";
  const actionId = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const simpleId = platform.randomUUID();
  const sessionId = `ea${Date.now().toString(36)}`;

  // 反风控头：模仿 Android 客户端真实请求特征
  const antiFraudHeaders: Record<string, string> = {
    "app-key": "android64",
    "bili-http-engine": "ignet",
    "buvid": buvid,
    "env": "prod",
    "fp_local": fp,
    "fp_remote": fp,
    "guestid": guestid,
    "native_api_from": "h5",
    "session_id": sessionId,
    "Referer": `https://live.bilibili.com/p/html/live-app-red-envelope/popularity.html?lotteryId=${lotId}&pop_type=2&anchorId=${ruid}&roomId=${roomId}&jumpFrom=30000`,
    "User-Agent": `Mozilla/5.0 (Linux; Android 14; 25102RKBEC Build/UQ1A.240205.08180011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/146.0.7680.119 Mobile Safari/537.36 os/android model/25102RKBEC build/9080300 osVer/14 sdkInt/34 network/2 BiliApp/9080300 mobi_app/android channel/bili Buvid/${buvid} sessionID/${sessionId} innerVer/9080310 c_locale/zh-Hans_CN s_locale/zh_CN disable_rcmd/0 themeId/1 sh/24 timezone/Asia/Shanghai utcOffset/+08:00 isDaylightTime/0 alwaysTranslate/0`,
    "x-bili-locale-bin": "Cg4KAnpoEgRIYW5zGgJDThIICgJ6aBoCQ04iDUFzaWEvU2hhbmdoYWkqBiswODowMA==",
    "x-bili-metadata-ip-region": "CN",
    "x-bili-metadata-legal-region": "CN",
    "x-bili-mid": String(uid),
    "x-bili-network-bin": "CAEqEQ0AAIA/EOCf3AQYl8aD/Yg0",
    "x-bili-redirect": "1",
  };

  const body = JSON.stringify({
    uid,
    room_id: roomId,
    ruid,
    lot_id: lotId,
    spm_id: "live.live-room-detail.red-envelope.extract",
    jump_from: "30000",
    session_id: refererSessionId,
    statistics: JSON.stringify({ appId: 0, platform: 3, version: "9.8.0", abtest: "" }),
    live_statistics: JSON.stringify({
      pc_client: "pink",
      jumpfrom: "30000",
      source_event: "0",
      room_category: "0",
      official_channel: refererSessionId,
      screen_status: "2",
      room_id: String(roomId),
      up_id: String(ruid),
      parent_area_id: "1",
      area_id: "21",
      live_status: "live",
      spm_id: refererSessionId,
      session_id: refererSessionId,
      launch_id: refererSessionId,
      simple_id: simpleId,
      av_id: refererSessionId,
      flow_extend: JSON.stringify({ position: "1", s_position: "1", slide_direction: refererSessionId }),
      bussiness_extend: JSON.stringify({ broadcast_type: "0", stream_scale: "2", watch_ui_type: "2" }),
      data_extend: JSON.stringify({
        from_launch_id: refererSessionId,
        from_session_id: refererSessionId,
        live_key: String(Math.floor(Date.now() / 1000)),
        sub_session_key: `${Math.floor(Date.now() / 1000)}sub_time:${Math.floor(Date.now() / 1000)}`,
      }),
      trackid: refererSessionId,
      action_id: actionId,
      user_status: "-99998",
      buvid,
    }),
  });
  const data = await platform.fetchBilibiliJson<ApiResult>({
    url,
    method: "POST",
    body,
    json: true,
    cookie: reqCookie,
    live: true,
    extraHeaders: antiFraudHeaders,
  });
  console.log(`[RedPocket] draw room=${roomId} lot=${lotId} code=${data.code} msg=${data.message || data.msg || ""}`);
  return data;
}

/**
 * 统一入口：检测指定房间的所有红包（仅客户端支持）
 */
export async function checkRedPocket(roomId: number): Promise<RedPocketInfo[]> {
  const platform: Platform = await getPlatform();
  if (!platform.isNative) return [];
  return checkRedPocketNative(platform, roomId);
}

/**
 * 统一入口：参与红包抽奖（仅客户端支持）
 */
export async function drawRedPocket(roomId: number, lotId: number, ruid: number): Promise<ApiResult> {
  const platform: Platform = await getPlatform();
  if (!platform.isNative) return { code: -1, message: "该功能仅支持客户端" };
  return drawRedPocketNative(platform, roomId, lotId, ruid);
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
  if (!platform.isNative) return null;
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

// ===== 本地持久化（Tauri → JSON 文件） =====

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
    if (!platform.isNative) return [];
    const state = await platform.getSessionState();
    const session = state.sessions.find((s) => s.sid === state.currentSid);
    if (!session) return [];
    const filePath = `${await platform.getDataDir()}/uid_${session.mid}/${LOTTERY_ROOMS_KEY}.json`;
    if (!(await platform.exists(filePath))) return [];
    const raw = await platform.readFile(filePath);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function saveLotteryRooms(rooms: SavedRoom[]): Promise<void> {
  try {
    const platform: Platform = await getPlatform();
    if (!platform.isNative) return;
    const state = await platform.getSessionState();
    const session = state.sessions.find((s) => s.sid === state.currentSid);
    if (!session) return;
    const dir = `${await platform.getDataDir()}/uid_${session.mid}`;
    await platform.mkdir(dir);
    await platform.writeFile(`${dir}/${LOTTERY_ROOMS_KEY}.json`, JSON.stringify(rooms, null, 2));
  } catch { /* 写入失败不影响使用 */ }
}

// ===== 热门直播间列表（客户端直连，绕过服务器 IP 风控） =====

export const HOT_ROOM_PARTITIONS = [
  { id: 1, name: "娱乐" }, { id: 2, name: "网游" }, { id: 3, name: "手游" },
  { id: 5, name: "电台" }, { id: 6, name: "单机游戏" }, { id: 9, name: "虚拟主播" },
  { id: 10, name: "生活" }, { id: 11, name: "知识" }, { id: 13, name: "赛事" },
  { id: 14, name: "聊天室" }, { id: 15, name: "互动玩法" }, { id: 16, name: "购物" },
  { id: 301, name: "帮我玩" },
];

export type HotRoomRaw = {
  roomid: number; uid: number; title: string; uname: string;
  online: number; face: string; parent_id: number; area_id: number; area_name: string;
};

export type HotPartitionResult = { partition: { id: number; name: string }; rooms: HotRoomRaw[] };

/** 每分区最多抓取的页数：列表按人气(online)倒序，前几页即热门直播间；
 *  该接口有效页数远超 15 页，限制页数可显著减少请求量、降低风控概率 */
const HOT_ROOM_MAX_PAGES = 3;
/** 每页条数（该接口 page_size 实测上限为 30） */
const HOT_ROOM_PAGE_SIZE = 30;

/** room/v1/area/getRoomList 单条记录 */
type GetRoomListEntry = {
  roomid: number; uid: number; title: string; uname: string;
  online: number; face: string;
  parent_id?: number; area_id?: number; area_name?: string;
  area_v2_parent_id?: number; area_v2_id?: number; area_v2_name?: string;
};

/** room/v1/area/getRoomList 响应：data 直接是数组 */
type GetRoomListResponse = {
  code: number; message?: string; data?: GetRoomListEntry[];
};

/** 将 getRoomList 记录映射为统一的 HotRoomRaw（字段名沿用旧接口，兼容调用方） */
function mapHotRoom(r: GetRoomListEntry): HotRoomRaw {
  return {
    roomid: r.roomid, uid: r.uid, title: r.title, uname: r.uname,
    online: r.online, face: r.face,
    parent_id: r.area_v2_parent_id ?? r.parent_id ?? 0,
    area_id: r.area_v2_id ?? r.area_id ?? 0,
    area_name: r.area_v2_name ?? r.area_name ?? "",
  };
}

/**
 * 抓取某分区某一页：sort_type 依次尝试 online → income → 不传，全部失败返回 null。
 * 与项目内其它接口一致，统一走 platform.fetchBilibiliJson({ live: true })。
 */
async function fetchHotRoomPage(
  platform: Platform,
  parentAreaId: number,
  page: number,
  cookie?: string,
): Promise<GetRoomListEntry[] | null> {
  for (const sort of ["online", "income", undefined] as const) {
    const params = new URLSearchParams({
      parent_area_id: String(parentAreaId),
      area_id: "0",
      page: String(page),
      page_size: String(HOT_ROOM_PAGE_SIZE),
    });
    if (sort) params.set("sort_type", sort);
    const url = `https://api.live.bilibili.com/room/v1/area/getRoomList?${params.toString()}`;
    try {
      const res = await platform.fetchBilibiliJson<GetRoomListResponse>({ url, cookie, live: true });
      if (res.code === 0 && Array.isArray(res.data)) return res.data;
      console.warn(`[HotRooms] 分区 ${parentAreaId} 第 ${page} 页 sort=${sort ?? "(无)"} code=${res.code} ${res.message ?? ""}`);
    } catch (err) {
      console.warn(`[HotRooms] 分区 ${parentAreaId} 第 ${page} 页 sort=${sort ?? "(无)"} 异常: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

/**
 * 客户端直连获取所有分区热门直播间（Tauri 原生 HTTP，无 IP 风控）。
 *
 * 说明：原 `xlive/web-interface/v1/second/getList` 整族接口已退役——无论是否携带
 * cookie / wbi 签名 / w_webid 都固定返回 -352（已实测排除参数原因），故改用同样
 * 无需登录的 `room/v1/area/getRoomList`。为防被风控，这里不携带登录 cookie，
 * 仅通过项目已有的 getBuvidCookie() 补设备指纹 buvid3（非登录凭证）。
 */
export async function fetchHotRoomsNative(): Promise<HotPartitionResult[]> {
  const platform = await getPlatform();
  // 只补设备指纹 buvid3，不携带登录凭证，避免被风控
  const buvidCookie = await platform.getBuvidCookie();
  const cookie = buvidCookie || undefined;

  const results: HotPartitionResult[] = [];
  for (const partition of HOT_ROOM_PARTITIONS) {
    const rooms: HotRoomRaw[] = [];
    for (let page = 1; page <= HOT_ROOM_MAX_PAGES; page++) {
      const list = await fetchHotRoomPage(platform, partition.id, page, cookie);
      if (!list || list.length === 0) break;
      for (const item of list) rooms.push(mapHotRoom(item));
      // 不满一页说明已到最后一页
      if (list.length < HOT_ROOM_PAGE_SIZE) break;
    }
    console.log(`[HotRooms] 分区 ${partition.name}(${partition.id}): ${rooms.length} 个直播间`);
    results.push({ partition, rooms });
  }
  return results;
}

// ===== 人气直播间列表（xlive/web-interface/v1/index/getHotRankList，需 Wbi 签名） =====

/** getHotRankList 单条记录 */
type HotRankListEntry = {
  roomid: number; uid: number; uname: string; face: string; title: string;
  online?: number;
  area_v2_id?: number; area_v2_name?: string; area_v2_parent_id?: number;
};

/** getHotRankList 响应：data.list 为数组 */
type HotRankListResponse = {
  code: number; message?: string; data?: { list?: HotRankListEntry[] };
};

/**
 * 客户端直连获取人气直播间列表（getHotRankList，需 Wbi 签名）。
 * 无翻页、无分区，单次请求即返回全部数据。
 */
export async function fetchHotRankListNative(): Promise<HotRoomRaw[]> {
  const platform = await getPlatform();
  // 只补设备指纹 buvid3，不携带登录凭证，避免被风控
  const buvidCookie = await platform.getBuvidCookie();
  const cookie = buvidCookie || undefined;
  try {
    const signed = await signWbiParams(platform, { web_location: "444.7" });
    const params = new URLSearchParams(signed);
    const url = `https://api.live.bilibili.com/xlive/web-interface/v1/index/getHotRankList?${params.toString()}`;
    const res = await platform.fetchBilibiliJson<HotRankListResponse>({ url, cookie, live: true });
    if (res.code !== 0) {
      console.warn(`[HotRank] code=${res.code} ${res.message ?? ""}`);
      return [];
    }
    const list = res.data?.list ?? [];
    const rooms = list.map((r) => ({
      roomid: r.roomid, uid: r.uid, title: r.title, uname: r.uname,
      online: r.online ?? 0, face: r.face,
      parent_id: r.area_v2_parent_id ?? 0,
      area_id: r.area_v2_id ?? 0,
      area_name: r.area_v2_name ?? "",
    }));
    console.log(`[HotRank] 人气直播间: ${rooms.length} 个`);
    return rooms;
  } catch (err) {
    console.warn(`[HotRank] 获取失败: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
