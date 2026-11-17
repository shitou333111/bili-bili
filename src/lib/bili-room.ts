/**
 * uid -> 直播间信息（服务端专用，公开接口，无需登录凭证）。
 *
 * 主接口 getRoomInfoOld 在机房 IP 上经常被 B站风控（HTTP 412 / code -412 / -352），
 * 因此统一在这里做：buvid3/buvid4 匿名 cookie + 浏览器化请求头 + 重试 + 兜底接口。
 *
 * 兜底接口 get_status_info_by_uids 的风控策略与主接口不同（同一台服务器上实测主接口
 * 412 时它仍返回 code=0），并且自带 room_id / live_status / title，足以覆盖所有调用方。
 */

export const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const BILI_LIVE = "https://api.live.bilibili.com";

type BiliResp<T> = { code?: number; data?: T } | null;

/**
 * 匿名调用 B站接口时附带的 buvid 风控 cookie。
 * 服务器（尤其是机房 IP）不带 cookie 时更容易被风控返回 412 "request was banned"。
 * 模拟真实浏览器先取一次 buvid3/buvid4，进程内复用 6 小时。
 */
let biliCookie = "";
let biliCookieAt = 0;

export async function getBiliCookie(): Promise<string> {
  if (biliCookie && Date.now() - biliCookieAt < 6 * 3600_000) return biliCookie;
  try {
    const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
      headers: { "User-Agent": BILI_UA, Referer: "https://www.bilibili.com/" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json()) as { data?: { b_3?: string; b_4?: string } };
    const b3 = json?.data?.b_3;
    if (b3) {
      biliCookie = `buvid3=${b3}${json.data?.b_4 ? `; buvid4=${json.data.b_4}` : ""}`;
      biliCookieAt = Date.now();
    }
  } catch {
    /* 取不到就退回无 cookie 请求，不影响主流程 */
  }
  return biliCookie;
}

/** 带风控 cookie 的 B站 JSON 请求：失败（网络/非 2xx/风控码）重试一次，仍失败返回 null */
async function biliJson<T>(url: string): Promise<BiliResp<T>> {
  const cookie = await getBiliCookie();
  const headers: Record<string, string> = {
    "User-Agent": BILI_UA,
    Referer: "https://live.bilibili.com/",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (cookie) headers.Cookie = cookie;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as BiliResp<T>;
      // -412 request was banned / -352 风控校验失败：都是概率性风控，重试一次
      if (data?.code === -412 || data?.code === -352) throw new Error(`banned ${data.code}`);
      return data;
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      console.warn("[bili-room] B站接口请求失败:", url, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

export type BiliRoomInfo = {
  /** 0 = 该 UID 没有直播间 */
  roomId: number;
  /** 1 = 正在直播 */
  liveStatus: number;
  title: string;
  uname?: string;
  face?: string;
};

export type BiliRoomResult = {
  /** false = 两个接口都没拿到可信结果（风控/网络异常），与"确实没有直播间"要区分开 */
  ok: boolean;
  room: BiliRoomInfo | null;
};

/** uid -> 直播间信息：主接口 + 兜底接口，任一接口正常返回即可给出可信结论 */
export async function fetchRoomInfoByUid(uid: number): Promise<BiliRoomResult> {
  const primary = await biliJson<{ roomid?: number; liveStatus?: number; title?: string }>(
    `${BILI_LIVE}/room/v1/Room/getRoomInfoOld?mid=${uid}`,
  );
  if (primary?.code === 0) {
    const roomId = Number(primary.data?.roomid) || 0;
    return {
      ok: true,
      room: roomId
        ? {
            roomId,
            liveStatus: Number(primary.data?.liveStatus) || 0,
            title: String(primary.data?.title ?? ""),
          }
        : null,
    };
  }

  // 兜底：同一份数据 + 直播状态/标题，风控策略与主接口不同
  const fallback = await biliJson<
    Record<string, { room_id?: number; live_status?: number; title?: string; uname?: string; face?: string }>
  >(`${BILI_LIVE}/room/v1/Room/get_status_info_by_uids?uids[]=${uid}`);
  if (fallback?.code === 0) {
    const info = fallback.data?.[String(uid)];
    const roomId = Number(info?.room_id) || 0;
    return {
      ok: true,
      room: roomId
        ? {
            roomId,
            liveStatus: Number(info?.live_status) || 0,
            title: String(info?.title ?? ""),
            uname: info?.uname,
            face: info?.face,
          }
        : null,
    };
  }

  return { ok: false, room: null };
}
