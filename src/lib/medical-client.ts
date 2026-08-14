/**
 * 医药费 - 客户端数据获取
 *
 * 平台差异：
 * - Tauri（原生）：通过 platform.fetchBilibiliJson 直连 B站，不经过服务器
 * - Web：受浏览器 CORS 限制，走服务器代理（/api/medical/...）
 *
 * 所有接口均为 B站公开接口，仅需 UID，不需要任何登录凭证。
 */

import { serverFetch } from "./server-api";
import { getPlatform, type Platform } from "./platform";
import { buildCookie, resolveSession } from "./stats-client";

// 缓存的访客 buvid cookie（只取一次）
let buvidPromise: Promise<string> | null = null;
function getBuvid(): Promise<string> {
  if (buvidPromise) return buvidPromise;
  buvidPromise = (async () => {
    try {
      const platform: Platform = await getPlatform();
      return await platform.getBuvidCookie();
    } catch {
      return "";
    }
  })();
  return buvidPromise;
}

/**
 * 获取用于访问接力信息的 B站 cookie。
 * - 若 app 当前已登录 B站账号，优先复用该登录会话的完整 cookie（能通过 -101 登录校验）
 * - 否则退回访客 buvid（可能仍被拦截）
 */
async function resolveAccessCookie(platform: Platform): Promise<string> {
  try {
    if (platform.isNative) {
      const session = await resolveSession(platform);
      if (session && (session.biliCookies?.length || session.biliSessdata)) {
        return buildCookie(session);
      }
    }
  } catch {
    // 忽略，退回访客
  }
  return getBuvid();
}

// ==================== 类型 ====================

export type MedicalRoomIdResult = {
  code: number;
  message?: string;
  data?: { roomid?: number } | null;
};

export type MedicalUniversalMember = {
  uid: number;
  uname: string;
  face: string;
  position: number;
  room_id: number;
  joined?: boolean;
  biz_extra_data?: {
    multi_conn?: { price?: number; price_text?: string };
  };
};

export type MedicalUniversalData = {
  biz_session_id?: string;
  members?: MedicalUniversalMember[];
  channel_users?: Array<string | number>;
};

export type MedicalUniversalResult = {
  code: number;
  message?: string;
  data?: MedicalUniversalData | null;
};

export type MedicalUnameResult = {
  code: number;
  message?: string;
  data?: { uid: number; uname: string } | null;
};

// ==================== 获取 room_id ====================

/**
 * 通过 UID 获取直播间 room_id
 * GET https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=...
 */
export async function fetchMedicalRoomId(mid: number): Promise<MedicalRoomIdResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    try {
      const buvid = await getBuvid();
      const data = await platform.fetchBilibiliJson<MedicalRoomIdResult>({
        url: `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${mid}`,
        cookie: buvid,
        live: true,
      });
      if (data?.code !== 0 || !data?.data?.roomid) {
        return { code: data?.code ?? -1, message: data?.message ?? "未获取到房间号", data: null };
      }
      return { code: 0, data: { roomid: data.data.roomid } };
    } catch (err) {
      console.error("[MedicalClient] 直连获取房间号失败:", err);
      return { code: -1, message: "直连获取房间号失败", data: null };
    }
  }
  // Web：走服务器代理
  try {
    const r = (await serverFetch(`/api/medical/room-id?mid=${mid}`)) as MedicalRoomIdResult;
    return r;
  } catch {
    return { code: -1, message: "获取房间号失败", data: null };
  }
}

// ==================== 获取接力实时信息 ====================

/**
 * 获取直播间当前多人接力 PK 实时信息
 * GET https://api.live.bilibili.com/xlive/web-room/v2/universalInteract/UniversalInfoForAudience?room_id=...&anchor_uid=...
 */
export async function fetchMedicalUniversal(
  roomId: number,
  anchorUid: number,
): Promise<MedicalUniversalResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    const cookie = await resolveAccessCookie(platform);
    // 直连偶发网络错误（error sending request），加少量重试
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await platform.fetchBilibiliJson<MedicalUniversalResult>({
          url: `https://api.live.bilibili.com/xlive/web-room/v2/universalInteract/UniversalInfoForAudience?room_id=${roomId}&anchor_uid=${anchorUid}`,
          cookie,
          live: true,
        });
        return data;
      } catch (err) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
          continue;
        }
        console.error("[MedicalClient] 直连获取接力信息失败:", err);
        return { code: -1, message: "直连获取接力信息失败", data: null };
      }
    }
    return { code: -1, message: "直连获取接力信息失败", data: null };
  }
  // Web：走服务器代理
  try {
    const r = (await serverFetch(
      `/api/medical/universal?room_id=${roomId}&anchor_uid=${anchorUid}`,
    )) as MedicalUniversalResult;
    return r;
  } catch {
    return { code: -1, message: "获取接力信息失败", data: null };
  }
}

// ==================== 获取用户昵称 ====================

/**
 * 通过 UID 查询昵称（用于页面顶部徽章）
 * GET https://api.bilibili.com/x/web-interface/card?mid=...&photo=false
 */
export async function fetchMedicalUname(mid: number): Promise<MedicalUnameResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    const cookie = await getBuvid();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await platform.fetchBilibiliJson<{
          code: number;
          message?: string;
          data?: { card?: { name?: string } } | null;
        }>({
          url: `https://api.bilibili.com/x/web-interface/card?mid=${mid}&photo=false`,
          cookie,
        });
        if (data?.code === 0 && data?.data?.card?.name) {
          return { code: 0, data: { uid: mid, uname: data.data.card.name } };
        }
        return { code: data?.code ?? -1, message: data?.message ?? "未找到用户", data: null };
      } catch (err) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
          continue;
        }
        console.error("[MedicalClient] 直连查询昵称失败:", err);
        return { code: -1, message: "直连查询昵称失败", data: null };
      }
    }
    return { code: -1, message: "直连查询昵称失败", data: null };
  }
  // Web：走服务器代理
  try {
    const r = (await serverFetch(`/api/medical/uname?mid=${mid}`)) as MedicalUnameResult;
    return r;
  } catch {
    return { code: -1, message: "查询昵称失败", data: null };
  }
}