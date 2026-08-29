/**
 * 直播间自动点赞 - 客户端
 *
 * 平台差异：
 * - Tauri（原生）：直接连 B站 接口（带登录 Cookie + CSRF + App 签名）
 * - Web：受浏览器 CORS 限制，走服务器代理 /api/like/*
 *
 * 接口：
 *   关注列表：GET https://api.live.bilibili.com/xlive/web-ucenter/user/following?page=1&page_size=9&ignoreRecord=1&hit_ab=true
 *   点赞上报：POST https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3
 *   （POST，body 为 application/x-www-form-urlencoded；用 GET 会返回 405）
 *   参数：click_time（点赞次数，上限 1000）、room_id、uid（当前登录账号 UID）、anchor_id（主播 uid）、
 *         web_location=444.8、csrf（bili_jct）、w_rid（md5 签名）、wts（unix 秒）
 *
 * 补充：当前登录账号若也是主播（自己不能关注自己，列表不含自己），
 *   通过 getRoomInfoOld?mid=<uid> 检测是否有直播间且正在开播，有则排到列表最上面。
 */

import { getPlatform, type Platform } from "./platform";
import { resolveSession } from "./stats-client";
import {
  ensureValidCredentialClient,
  extractCookieValue,
} from "./bilibili/cookie-refresh-client";
import { serverFetch, serverPost } from "./server-api";
import { md5 } from "./md5";

/** 关注列表中的主播 */
export type LikeAnchor = {
  uid: number;
  roomid: number;
  uname: string;
  face: string;
  title: string;
};

/** B站 点赞接口返回结构 */
export type LikeResult = {
  code: number;
  message?: string;
  msg?: string;
  data?: unknown;
};

/** likeReportV3 专属签名密钥（与 payRecord 的 DEFAULT_APP_SECRET 不同，已用官方示例精确验证） */
const LIKE_APP_SECRET = "ea1db124af3c7062474693fa704f4ff8";

/** 每位主播每日点赞量（B站 同一账号同一直播间单场直播最多 1000 有效赞） */
export const LIKES_PER_ANCHOR = 1000;
/** 单批点赞数（B站 建议单次点赞不要过高，200 以下更不易触发风控） */
const BATCH_LIKE_COUNT = 200;
/** 每位主播分几批点完 1000 赞 */
const BATCH_COUNT = LIKES_PER_ANCHOR / BATCH_LIKE_COUNT;
/** 批与批之间的间隔，避免密集请求触发 B站 限流（-352） */
const BATCH_INTERVAL_MS = 2000;

/** 每日点赞上限：每账号每天最多 5000 有效赞，即最多 5 位主播（每位 1000 赞） */
export const DAILY_ANCHOR_LIMIT = 5;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ===== 每日点赞状态（localStorage 按账号存储，跨天自动重置） =====

/** 获取本地日期 YYYY-MM-DD */
export function getTodayDate(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type LikeDailyState = {
  date: string;
  liked: number[]; // 今日已完成 1000 赞的主播 uid
};

function dailyKey(mid: number): string {
  return `like-daily:${mid}`;
}

/** 读取今日已完成点赞的主播 uid 集合（跨天自动重置） */
export function loadLikedAnchorsToday(mid: number): Set<number> {
  try {
    const raw = localStorage.getItem(dailyKey(mid));
    if (!raw) return new Set();
    const st = JSON.parse(raw) as LikeDailyState;
    if (st.date !== getTodayDate()) return new Set();
    return new Set(Array.isArray(st.liked) ? st.liked : []);
  } catch {
    return new Set();
  }
}

/** 记录某主播今日已完成 1000 赞 */
export function markAnchorLikedToday(mid: number, anchorUid: number): void {
  try {
    const set = loadLikedAnchorsToday(mid);
    set.add(anchorUid);
    localStorage.setItem(dailyKey(mid), JSON.stringify({ date: getTodayDate(), liked: Array.from(set) }));
  } catch {
    // 存储失败不影响点赞结果展示
  }
}

/** 确保 Cookie 携带 buvid3 设备指纹（B站 风控/个性化要求）；获取失败时返回原 cookie */
async function ensureBuvidCookie(platform: Platform, cookie: string): Promise<string> {
  try {
    if (/buvid3\s*=/i.test(cookie)) return cookie;
    const buvidCookie = await platform.getBuvidCookie();
    return buvidCookie ? `${buvidCookie}; ${cookie}` : cookie;
  } catch {
    return cookie;
  }
}

/** 关注列表响应结构 */
type FollowingResponse = {
  code: number;
  message?: string;
  data?: {
    list?: Array<{
      uid: number;
      roomid: number;
      uname: string;
      face: string;
      title: string;
      live_status: number;
    }>;
  };
};

/** 仅保留正在开播（live_status=1）且有直播间的主播 */
function isAnchorLive(a: { roomid: number; live_status: number }): boolean {
  return a.live_status === 1 && a.roomid > 0;
}

/** getRoomInfoOld 响应结构（检测自己是否有直播间/是否开播） */
type RoomInfoOldResponse = {
  code: number;
  message?: string;
  data?: {
    roomid: number;
    liveStatus: number;
    title?: string;
  } | null;
};

/** 获取正在直播的常看关注主播（第一页前 9 位）；失败时抛出带 message 的 Error */
export async function fetchFollowingAnchors(): Promise<LikeAnchor[]> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return fetchFollowingAnchorsNative(platform);
  }
  // Web：走服务器代理
  try {
    const r = await serverFetch<FollowingResponse>("/api/like/following");
    if (r.code === 0 && Array.isArray(r.data?.list)) {
      return r.data.list.filter(isAnchorLive);
    }
    throw new Error(r.message || "获取关注列表失败");
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("获取关注列表失败");
  }
}

/** Tauri 直连获取关注列表 */
async function fetchFollowingAnchorsNative(platform: Platform): Promise<LikeAnchor[]> {
  try {
    const session = await resolveSession(platform);
    if (!session) throw new Error("未登录，无法获取关注列表");
    if (session.source === "server") {
      throw new Error("该功能需要登录凭证，服务器账号无法使用");
    }
    const cred = await ensureValidCredentialClient(platform, session);
    if (!cred.valid) throw new Error("登录凭证失效，请重新登录");
    const url =
      "https://api.live.bilibili.com/xlive/web-ucenter/user/following?page=1&page_size=9&ignoreRecord=1&hit_ab=true";
    const data = await platform.fetchBilibiliJson<FollowingResponse>({
      url,
      cookie: await ensureBuvidCookie(platform, cred.cookie),
      live: true,
    });
    if (data.code !== 0 || !Array.isArray(data.data?.list)) {
      throw new Error(data.message || "获取关注列表失败");
    }
    const list: LikeAnchor[] = data.data.list.filter(isAnchorLive);
    // 当前登录账号若也是主播且正在开播，则排到列表最上面（自己不能关注自己，列表不含自己）
    const own = await fetchOwnLiveRoomNative(platform, cred.cookie, session);
    if (own) list.unshift(own);
    return list;
  } catch (err) {
    console.error("[Like] 直连获取关注列表失败:", err);
    throw err instanceof Error ? err : new Error("获取关注列表失败");
  }
}

/** 检测当前登录账号自己的直播间：有房且正在开播时返回主播信息，否则 null */
async function fetchOwnLiveRoomNative(
  platform: Platform,
  cookie: string,
  session: { mid: number; uname: string; face?: string },
): Promise<LikeAnchor | null> {
  try {
    const data = await platform.fetchBilibiliJson<RoomInfoOldResponse>({
      url: `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${session.mid}`,
      cookie,
      live: true,
    });
    if (data.code === 0 && data.data && data.data.roomid > 0 && data.data.liveStatus === 1) {
      return {
        uid: session.mid,
        roomid: data.data.roomid,
        uname: session.uname,
        face: session.face ?? "",
        title: data.data.title ?? "",
      };
    }
    return null;
  } catch (err) {
    console.error("[Like] 检测自己直播间失败:", err);
    return null;
  }
}

/**
 * 为指定主播点赞（每位固定 1000 赞 = 5 批 × 200 赞，批间间隔 BATCH_INTERVAL_MS 避免触发风控）。
 * 逐位串行处理：任一单批失败即停止该主播（避免无效耗光每日额度），不中断其他主播。
 * onProgress(done, total) 每成功一批回调一次，done 为该主播已累计点赞数、total=1000。
 */
export async function likeAnchors(
  anchors: { uid: number; roomid: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<LikeResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return likeAnchorsNative(platform, anchors, onProgress);
  }
  // Web：逐批走服务器代理
  try {
    let ok = 0;
    let failed = 0;
    let firstMsg = "";
    for (const a of anchors) {
      let liked = 0;
      let anchorOk = true;
      for (let b = 0; b < BATCH_COUNT; b++) {
        if (b > 0) await sleep(BATCH_INTERVAL_MS);
        try {
          const r = await serverPost<LikeResult>("/api/like/report", {
            room_id: a.roomid,
            anchor_id: a.uid,
            click_time: BATCH_LIKE_COUNT,
          });
          if (!r || r.code !== 0) {
            throw new Error(r?.message || r?.msg || "点赞失败");
          }
          liked += BATCH_LIKE_COUNT;
          onProgress?.(liked, LIKES_PER_ANCHOR);
        } catch (err) {
          anchorOk = false;
          if (!firstMsg) firstMsg = err instanceof Error ? err.message : "点赞失败";
          break;
        }
      }
      if (anchorOk) ok++;
      else failed++;
    }
    if (ok === 0) return { code: -1, message: firstMsg || "点赞失败" };
    const tail = failed > 0 ? `，${failed} 位失败` : "";
    return { code: 0, message: `已为 ${ok} 位主播点赞 ${LIKES_PER_ANCHOR} 赞${tail}` };
  } catch {
    return { code: -1, message: "点赞失败，请检查网络" };
  }
}

/** 构建 likeReportV3 带签名 POST body（application/x-www-form-urlencoded） */
function buildLikeBody(
  roomId: number,
  anchorId: number,
  uid: number,
  csrf: string,
  clickTime: number,
): string {
  const params: Record<string, string> = {
    click_time: String(clickTime),
    room_id: String(roomId),
    uid: String(uid),
    anchor_id: String(anchorId),
    web_location: "444.8",
    csrf,
    wts: String(Math.floor(Date.now() / 1000)),
  };
  // w_rid = md5(除 w_rid 外全部参数按 key 排序、join 成 k=v&...（值不 URL 编码）+ 密钥)
  const sorted = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  params.w_rid = md5(sorted + LIKE_APP_SECRET);
  return new URLSearchParams(params).toString();
}

/** Tauri 直连点赞（每位 1000 赞 = 5 批 × 200，批间间隔防风控） */
async function likeAnchorsNative(
  platform: Platform,
  anchors: { uid: number; roomid: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<LikeResult> {
  try {
    const session = await resolveSession(platform);
    if (!session) return { code: -1, message: "未登录，无法点赞" };
    if (session.source === "server") {
      return { code: -1, message: "该功能需要登录凭证，服务器账号无法使用" };
    }
    const cred = await ensureValidCredentialClient(platform, session);
    if (!cred.valid) return { code: -1, message: "登录凭证失效，请重新登录" };
    // 点赞为写操作，B站 风控要求 Cookie 携带 buvid3 设备指纹；缺失则补齐（同 Cookie 刷新流程做法）
    const likeCookie = await ensureBuvidCookie(platform, cred.cookie);
    const csrf =
      extractCookieValue(cred.session.biliCookies ?? [], "bili_jct") ||
      cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] ||
      "";
    if (!csrf) return { code: -1, message: "未找到登录凭证(csrf)，请重新登录" };
    const uid = session.mid;
    let ok = 0;
    let failed = 0;
    let firstMsg = "";
    for (const a of anchors) {
      let liked = 0;
      let anchorOk = true;
      for (let b = 0; b < BATCH_COUNT; b++) {
        if (b > 0) await sleep(BATCH_INTERVAL_MS);
        try {
          const data = await platform.fetchBilibiliJson<LikeResult>({
            url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3",
            method: "POST",
            body: buildLikeBody(a.roomid, a.uid, uid, csrf, BATCH_LIKE_COUNT),
            cookie: likeCookie,
            live: true,
          });
          if (!data || data.code !== 0) {
            throw new Error(data?.message || data?.msg || "点赞失败");
          }
          liked += BATCH_LIKE_COUNT;
          onProgress?.(liked, LIKES_PER_ANCHOR);
        } catch (err) {
          console.error("[Like] 单批点赞失败:", err);
          anchorOk = false;
          if (!firstMsg) firstMsg = err instanceof Error ? err.message : "点赞失败，请检查网络";
          break;
        }
      }
      if (anchorOk) ok++;
      else failed++;
    }
    if (ok === 0) return { code: -1, message: firstMsg || "点赞失败" };
    const tail = failed > 0 ? `，${failed} 位失败` : "";
    return { code: 0, message: `已为 ${ok} 位主播点赞 ${LIKES_PER_ANCHOR} 赞${tail}` };
  } catch (err) {
    console.error("[Like] 直连点赞失败:", err);
    return { code: -1, message: "点赞失败，请检查网络" };
  }
}
