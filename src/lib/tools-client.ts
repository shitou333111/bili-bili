/**
 * Tauri 客户端 - 工具类功能
 * 在 Tauri 环境下，直接调用 B站 API 实现粉丝/勋章/用户信息等工具功能
 *
 * 逻辑与以下 server route 对应，但运行在客户端：
 * - src/app/api/tools/fans/route.ts
 * - src/app/api/tools/medals/route.ts
 * - src/app/api/tools/user-info/route.ts
 * - src/app/api/tools/remove-fan/route.ts
 * - src/app/api/tools/delete-medal/route.ts
 */

import type { Platform } from "./platform/types";
import type { AuthSession } from "./auth/session";

// ==================== 会话/Cookie 辅助 ====================

/** 从会话构建 B站 cookie header */
function buildCookie(session: AuthSession): string {
  if (session.biliCookies?.length) {
    return session.biliCookies.join("; ");
  }
  return `SESSDATA=${session.biliSessdata}`;
}

/** 从 cookie header 中提取 bili_jct (CSRF token) */
function extractCsrf(cookie: string): string {
  return cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] || "";
}

/** 获取当前会话；未登录返回 null */
async function resolveSession(
  platform: Platform,
): Promise<AuthSession | null> {
  const state = await platform.getSessionState();
  const sid = state.currentSid;
  if (!sid) return null;
  const session = state.sessions.find((s) => s.sid === sid);
  return session ?? null;
}

// ==================== 粉丝列表 ====================

type BiliFan = {
  mid: number;
  uname: string;
  face: string;
  sign: string;
  attribute: number; // 0:未关注 2:已关注 6:互粉
  mtime: number;
  special: number;
  vip: { vipType: number; vipDueDate: number };
  official_verify: { type: number; desc: string };
};

type BiliFansResponse = {
  code: number;
  message: string;
  data: {
    total: number;
    list: BiliFan[];
    offset?: string;
  };
};

export type FanListResult = {
  code: number;
  message: string;
  data: {
    total: number;
    list: Array<{ mid: number; uname: string; face: string; attribute: number; mtime: number }>;
    pn: number;
    ps: number;
  } | null;
};

/**
 * 获取粉丝列表
 * GET https://api.bilibili.com/x/relation/fans?vmid=&pn=&ps=&order=desc
 */
export async function fetchFans(
  platform: Platform,
  pn = 1,
  ps = 50,
): Promise<FanListResult> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: -101, message: "未登录", data: null };
  }
  const cookie = buildCookie(session);
  if (!cookie) {
    return { code: -101, message: "登录凭证已失效，请重新扫码登录", data: null };
  }

  try {
    const result = await platform.fetchBilibiliJson<BiliFansResponse>({
      url: `https://api.bilibili.com/x/relation/fans?vmid=${session.mid}&pn=${pn}&ps=${ps}&order=desc`,
      cookie,
    });

    if (result.code !== 0) {
      return { code: result.code, message: result.message, data: null };
    }

    const fans = (result.data.list || []).map((f) => ({
      mid: f.mid,
      uname: f.uname,
      face: f.face,
      attribute: f.attribute,
      mtime: f.mtime,
    }));

    return {
      code: 0,
      message: "0",
      data: {
        total: result.data.total,
        list: fans,
        pn,
        ps,
      },
    };
  } catch (err) {
    console.error("[ToolsClient.fetchFans] error:", err);
    return { code: -1, message: "请求失败", data: null };
  }
}

// ==================== 勋章列表 ====================

type BiliMedalResponse = {
  code: number;
  message: string;
  data?: {
    list: Record<string, unknown>[];
    special_list: Record<string, unknown>[];
    page_info: { current_page: number; has_more: boolean; next_page: number; total_page: number; number: number };
    total_number: number;
  };
};

/**
 * 获取勋章列表
 * GET https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=&page_size=10
 */
export async function fetchMedals(
  platform: Platform,
  page = 1,
): Promise<{ code: number; message: string; data?: BiliMedalResponse["data"] | null }> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: -101, message: "未登录", data: null };
  }
  const cookie = buildCookie(session);
  if (!cookie) {
    return { code: -101, message: "登录凭证已失效，请重新扫码登录", data: null };
  }

  try {
    const result = await platform.fetchBilibiliJson<BiliMedalResponse>({
      url: `https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=10`,
      cookie,
      live: true,
    });

    return result;
  } catch (err) {
    console.error("[ToolsClient.fetchMedals] error:", err);
    return { code: -1, message: "请求失败", data: null };
  }
}

// ==================== 用户信息（批量） ====================

type LiveCardResponse = {
  code: number;
  message?: string;
  msg?: string;
  data?: {
    uid: number;
    uname: string;
    face: string;
  } | null;
};

type UserCardResponse = {
  code: number;
  message?: string;
  data?: {
    card?: {
      name: string;
      face: string;
    };
  } | null;
};

const NOFACE_PATTERN = /\/noface\.jpg$/;

function normalizeFace(face: string): string {
  if (!face) return "";
  if (NOFACE_PATTERN.test(face)) return "";
  return face;
}

// 客户端内存缓存（对应服务器 userInfoCache）
const userInfoCache = new Map<number, { name: string; face: string }>();

/** 通过 live card_up 接口获取用户信息（带重试） */
async function fetchUserInfoWithRetry(
  platform: Platform,
  mid: number,
  retries = 3,
): Promise<{ name: string; face: string } | null> {
  const url = `https://api.live.bilibili.com/live_user/v1/card/card_up?uid=${mid}&browser=0`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
      const data = await platform.fetchBilibiliJson<LiveCardResponse>({
        url,
        live: true,
      });
      if (data.code === 0 && data.data) {
        return {
          name: data.data.uname || `用户${mid}`,
          face: normalizeFace(data.data.face),
        };
      }
      console.warn(
        `[ToolsClient.getUserInfo] mid=${mid} attempt=${attempt + 1} API错误: code=${data.code} msg=${data.message || data.msg}`,
      );
    } catch (err) {
      console.warn(
        `[ToolsClient.getUserInfo] mid=${mid} attempt=${attempt + 1} 请求异常:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return null;
}

/** 通过 web-interface/card 接口获取用户信息（备选） */
async function fetchUserInfoByCard(
  platform: Platform,
  mid: number,
): Promise<{ name: string; face: string } | null> {
  try {
    const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
    const cardData = await platform.fetchBilibiliJson<UserCardResponse>({ url: cardUrl });
    if (cardData.code === 0 && cardData.data?.card?.face) {
      return {
        name: cardData.data.card.name || `用户${mid}`,
        face: normalizeFace(cardData.data.card.face),
      };
    }
  } catch {
    // ignore
  }
  return null;
}

export type UserInfoResult = {
  code: number;
  data: Record<number, { name: string; face: string }>;
};

// 有界并发：同时最多向 B站 API 发起 CONCURRENCY 个请求。
// 原先逐个 uid 串行 + 200ms 固定延迟，首屏头像获取需数分钟；并行后大幅缩短。
const CONCURRENCY = 10;

/** 以固定并发数处理一批 uid，全部完成后 resolve */
async function runPool<T>(items: number[], worker: (uid: number) => Promise<T>): Promise<void> {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  }
  const count = Math.min(CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: count }, next));
}

/**
 * 批量获取用户信息
 * 对应 GET /api/tools/user-info?uids=a,b[&refresh=1]
 * 以有界并发并行请求，返回 { uid: { name, face } }
 */
export async function fetchUserInfo(
  platform: Platform,
  uids: number[],
  refresh = false,
): Promise<UserInfoResult> {
  if (!uids || uids.length === 0) {
    return { code: 0, data: {} };
  }

  const results: Record<number, { name: string; face: string }> = {};

  await runPool(uids, async (uid) => {
    // 非强制刷新时命中缓存
    if (!refresh && userInfoCache.has(uid)) {
      results[uid] = userInfoCache.get(uid)!;
      return;
    }

    let info: { name: string; face: string } = { name: `用户${uid}`, face: "" };

    // 先尝试 live card_up
    const result = await fetchUserInfoWithRetry(platform, uid);
    if (result && result.face) {
      info = result;
    } else {
      // 备选：web-interface/card
      const card = await fetchUserInfoByCard(platform, uid);
      if (card && card.face) {
        info = card;
      }
    }

    userInfoCache.set(uid, info);
    results[uid] = info;
  });

  return { code: 0, data: results };
}

// ==================== 移除粉丝 ====================

type BiliModifyResponse = {
  code: number;
  message: string;
};

export type RemoveFanResult = {
  code: number;
  message: string;
  data: Array<{ fid: number; success: boolean; message: string }>;
};

/**
 * 移除粉丝
 * POST /api/tools/remove-fan  body: { fids: number[] }
 * 内部调用 https://api.bilibili.com/x/relation/modify （act=7 移除粉丝）
 * 注意：act=5 是拉黑（会把粉丝加入黑名单），不能用于清理粉丝；act=2 是取关，不会移除粉丝
 */
export async function removeFan(
  platform: Platform,
  body: { fids: number[] },
): Promise<RemoveFanResult> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: -101, message: "未登录", data: [] };
  }

  const fids: number[] = body.fids;
  if (!Array.isArray(fids) || fids.length === 0) {
    return { code: -1, message: "参数错误：需要 fids 数组", data: [] };
  }

  const cookie = buildCookie(session);
  const csrf = extractCsrf(cookie);
  if (!csrf) {
    return { code: -1, message: "缺少 csrf token，请重新登录", data: [] };
  }

  const mid = session.mid;

  async function modifyRelation(fid: number, act: number): Promise<{ code: number; message: string }> {
    const stats = encodeURIComponent(JSON.stringify({ appId: 100, platform: 5 }));
    const deviceReq = encodeURIComponent(JSON.stringify({ platform: "web", device: "pc", spmid: "333.1387" }));
    const url = `https://api.bilibili.com/x/relation/modify?statistics=${stats}&x-bili-device-req-json=${deviceReq}`;

    try {
      const result = await platform.fetchBilibiliJson<BiliModifyResponse>({
        url,
        cookie,
        method: "POST",
        body: `fid=${fid}&act=${act}&re_src=11&csrf=${csrf}`,
      });
      return { code: result.code, message: result.message };
    } catch (err) {
      console.error(`[ToolsClient.removeFan] fid=${fid} act=${act} 请求异常:`, err);
      return { code: -1, message: "网络请求失败" };
    }
  }

  const results: { fid: number; success: boolean; message: string }[] = [];

  for (let i = 0; i < fids.length; i++) {
    const fid = fids[i];
    try {
      // 移除粉丝 (act=7)。act=5 是拉黑，会把粉丝加入黑名单，绝不能用于清理粉丝
      const result = await modifyRelation(fid, 7);

      if (result.code !== 0) {
        console.log(`[ToolsClient.removeFan] fid=${fid} remove failed: code=${result.code} msg=${result.message}`);
      }

      results.push({
        fid,
        success: result.code === 0,
        message: result.code === 0 ? "ok" : `${result.code}: ${result.message}`,
      });

      // 每次请求间隔 500ms 避免触发风控
      if (i < fids.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`[ToolsClient.removeFan] fid=${fid} error:`, err);
      results.push({ fid, success: false, message: "网络请求失败" });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  return {
    code: 0,
    message: `完成：${successCount}/${fids.length} 成功`,
    data: results,
  };
}

// ==================== 删除勋章 ====================

export type DeleteMedalResult = {
  code: number;
  message: string;
  data?: unknown;
};

/**
 * 删除勋章
 * POST /api/tools/delete-medal  body: { medal_id: number }
 * 内部调用 https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/web_room/del_medal
 */
export async function deleteMedal(
  platform: Platform,
  body: { medal_id: number },
): Promise<DeleteMedalResult> {
  const session = await resolveSession(platform);
  if (!session) {
    return { code: -101, message: "未登录" };
  }

  const { medal_id } = body;
  if (!medal_id) {
    return { code: -1, message: "缺少 medal_id" };
  }

  const cookie = buildCookie(session);
  const csrf = extractCsrf(cookie);

  try {
    const result = await platform.fetchBilibiliJson<DeleteMedalResult>({
      url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/web_room/del_medal",
      cookie,
      method: "POST",
      body: `medal_id=${medal_id}&csrf_token=${csrf}&csrf=${csrf}`,
      live: true,
    });

    return result;
  } catch (err) {
    console.error("[ToolsClient.deleteMedal] error:", err);
    return { code: -1, message: "请求失败" };
  }
}

// ==================== 年度大会员领取 B币 并兑换电池 ====================

/** 大会员卡券状态条目 */
type VipPrivilegeItem = {
  type: number; // 1=B币券 2=会员购券 3=漫画券 ...
  state: number; // 0=未兑换 1=已兑换 2=需完成任务
  vip_type?: number; // 0=超级大会员 2=年度大会员
  period_end_unix?: number;
};

type VipPrivilegeResponse = {
  code: number;
  message: string;
  data?: {
    list?: VipPrivilegeItem[];
    vip_status?: number; // 1=是大会员
    vip_type?: number; // 2=年度及以上大会员
    vip_is_annual?: boolean;
  } | null;
};

type GoldWalletResponse = {
  code: number;
  message?: string;
  data?: { new_bp?: string | number } | null;
};

/** 年度大会员 B币 工具统一返回体（领取与兑换为两个独立步骤） */
export type YearVipBCoinResult = {
  code: number;
  message: string;
  data: {
    /** 是否为年度（及以上）大会员 */
    isYearVip: boolean;
    /** 本月 B币 权益可领取（未领取且满足条件） */
    claimable: boolean;
    /** 本月 B币 权益此前已领取 */
    alreadyClaimed: boolean;
    /** 本次实际领取成功 */
    claimed: boolean;
    /** 当前钱包内的 B币 数量 */
    bpCount: number;
    /** 是否成功执行兑换 */
    exchanged: boolean;
    /** 本次兑换得到的电池数量 */
    goldCount: number;
  };
};

const emptyYearVipData: YearVipBCoinResult["data"] = {
  isYearVip: false,
  claimable: false,
  alreadyClaimed: false,
  claimed: false,
  bpCount: 0,
  exchanged: false,
  goldCount: 0,
};

/** B币 兑换电池的 visit_id（B站格式：13 位小写字母/数字） */
function randomVisitId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 13; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** 鉴权上下文：cookie + csrf */
type YearVipCtx = { cookie: string; csrf: string } | { error: YearVipBCoinResult };

async function yearVipCtx(platform: Platform): Promise<YearVipCtx> {
  const session = await resolveSession(platform);
  if (!session) return { error: { code: -101, message: "未登录", data: { ...emptyYearVipData } } };
  const cookie = buildCookie(session);
  const csrf = extractCsrf(cookie);
  if (!csrf) {
    return { error: { code: -1, message: "缺少 csrf token，请重新登录", data: { ...emptyYearVipData } } };
  }
  return { cookie, csrf };
}

/** 查询大会员权益（B币 卡券状态：state 0=可领 1=已领 2=暂不可领） */
async function queryVipPrivilege(
  platform: Platform,
  cookie: string,
): Promise<{ code: number; message?: string; isYearVip?: boolean; state?: number | null }> {
  const privilege = await platform.fetchBilibiliJson<VipPrivilegeResponse>({
    url: "https://api.bilibili.com/x/vip/privilege/my",
    cookie,
  });
  if (privilege.code !== 0) {
    return { code: privilege.code, message: privilege.message || "获取大会员权益失败" };
  }
  const d = privilege.data ?? {};
  const isYearVip = d.vip_status === 1 && (d.vip_is_annual === true || d.vip_type === 2);
  const bcoin = (d.list ?? []).find((i) => i.type === 1);
  return { code: 0, isYearVip, state: bcoin ? bcoin.state : null };
}

/** 查询钱包 B币 数量 */
async function queryWalletBp(platform: Platform, cookie: string): Promise<number> {
  const wallet = await platform.fetchBilibiliJson<GoldWalletResponse>({
    url: "https://api.live.bilibili.com/xlive/revenue/v1/wallet/myGoldWallet?need_bp=1&need_metal=1&platform=pc&bp_with_decimal=0&ios_bp_afford_party=0",
    cookie,
    live: true,
  });
  return wallet.code === 0 ? Number(wallet.data?.new_bp ?? 0) : 0;
}

/**
 * 年度大会员 B币 工具：领取（每月赠送）与兑换（全部 B币 → 电池）拆分为两个独立步骤。
 * 对应 GET /api/tools/year-vip-bcoin?action=status
 * - 仅查询权益状态与钱包余额，无副作用
 */
export async function statusYearVipBCoin(platform: Platform): Promise<YearVipBCoinResult> {
  const ctx = await yearVipCtx(platform);
  if ("error" in ctx) return ctx.error;
  const { cookie } = ctx;
  try {
    const priv = await queryVipPrivilege(platform, cookie);
    if (priv.code !== 0) {
      return { code: priv.code, message: priv.message || "获取大会员权益失败", data: { ...emptyYearVipData } };
    }
    if (!priv.isYearVip) {
      return { code: 0, message: "当前账号不是年度大会员", data: { ...emptyYearVipData } };
    }
    if (priv.state === null) {
      return { code: 0, message: "未找到 B币 权益", data: { ...emptyYearVipData, isYearVip: true } };
    }
    const claimable = priv.state === 0;
    const alreadyClaimed = priv.state === 1;
    const bpCount = await queryWalletBp(platform, cookie);
    return {
      code: 0,
      message: alreadyClaimed
        ? "本月 B币 权益已领取"
        : claimable
          ? "本月 B币 权益可领取"
          : "本月 B币 权益暂不可领取",
      data: { ...emptyYearVipData, isYearVip: true, claimable, alreadyClaimed, bpCount },
    };
  } catch (err) {
    console.error("[ToolsClient.statusYearVipBCoin] error:", err);
    return { code: -1, message: "请求失败", data: { ...emptyYearVipData } };
  }
}

/**
 * 第一步：仅领取本月赠送的 B币（不再顺带兑换）
 * POST /api/tools/year-vip-bcoin?action=claim
 */
export async function claimYearVipBCoin(platform: Platform): Promise<YearVipBCoinResult> {
  const ctx = await yearVipCtx(platform);
  if ("error" in ctx) return ctx.error;
  const { cookie, csrf } = ctx;
  try {
    const priv = await queryVipPrivilege(platform, cookie);
    if (priv.code !== 0) {
      return { code: priv.code, message: priv.message || "获取大会员权益失败", data: { ...emptyYearVipData } };
    }
    if (!priv.isYearVip) {
      return { code: 0, message: "当前账号不是年度大会员", data: { ...emptyYearVipData } };
    }
    const claimable = priv.state === 0;
    const alreadyClaimed = priv.state === 1;

    let claimed = false;
    if (claimable) {
      const receive = await platform.fetchBilibiliJson<{ code: number; message: string }>({
        url: "https://api.bilibili.com/x/vip/privilege/receive",
        cookie,
        method: "POST",
        body: `type=1&csrf=${csrf}`,
      });
      claimed = receive.code === 0;
      if (!claimed && receive.code !== 69801) {
        return {
          code: receive.code,
          message: receive.message || "领取 B币 失败",
          data: { ...emptyYearVipData, isYearVip: true },
        };
      }
    }
    const bpCount = await queryWalletBp(platform, cookie);
    return {
      code: 0,
      message: claimed
        ? `已领取本月 B币（钱包共 ${bpCount} B币）`
        : alreadyClaimed || claimed
          ? "本月 B币 权益已领取"
          : "本月 B币 权益暂不可领取",
      data: {
        ...emptyYearVipData,
        isYearVip: true,
        claimable,
        alreadyClaimed: alreadyClaimed || claimed,
        claimed,
        bpCount,
      },
    };
  } catch (err) {
    console.error("[ToolsClient.claimYearVipBCoin] error:", err);
    return { code: -1, message: "请求失败", data: { ...emptyYearVipData } };
  }
}

/**
 * 第二步：把钱包内全部 B币 一次性兑换为电池（1 B币 = 1000 bp = 10 电池）
 * POST /api/tools/year-vip-bcoin?action=exchange
 */
export async function exchangeYearVipBCoin(platform: Platform): Promise<YearVipBCoinResult> {
  const ctx = await yearVipCtx(platform);
  if ("error" in ctx) return ctx.error;
  const { cookie, csrf } = ctx;
  try {
    const priv = await queryVipPrivilege(platform, cookie);
    if (priv.code !== 0) {
      return { code: priv.code, message: priv.message || "获取大会员权益失败", data: { ...emptyYearVipData } };
    }
    if (!priv.isYearVip) {
      return { code: 0, message: "当前账号不是年度大会员", data: { ...emptyYearVipData } };
    }
    const claimable = priv.state === 0;
    const alreadyClaimed = priv.state === 1;

    const bpCount = await queryWalletBp(platform, cookie);
    if (!bpCount || bpCount <= 0) {
      return {
        code: 0,
        message: "钱包内暂无 B币 可兑换",
        data: { ...emptyYearVipData, isYearVip: true, claimable, alreadyClaimed, bpCount: 0 },
      };
    }

    const payBp = bpCount * 1000;
    const goldCount = bpCount * 10;
    const liveStatistics = encodeURIComponent(
      JSON.stringify({ pc_client: "pcWeb", jumpfrom: "-99998", room_category: "-99998", trackid: "-999998" }),
    );
    const statistics = encodeURIComponent(JSON.stringify({ platform: 0, pc_client: "pcWeb" }));
    const order = await platform.fetchBilibiliJson<{ code: number; message: string }>({
      url: "https://api.live.bilibili.com/xlive/revenue/v1/order/createOrder",
      cookie,
      method: "POST",
      body:
        `platform=pc&pay_bp=${payBp}&context_id=1931024777&context_type=11&goods_id=1&goods_num=1&goods_type=2` +
        `&ios_bp=0&common_bp=${payBp}&live_statistics=${liveStatistics}&statistics=${statistics}` +
        `&csrf_token=${csrf}&csrf=${csrf}&visit_id=${randomVisitId()}`,
      live: true,
      extraHeaders: {
        Referer: "https://link.bilibili.com/p/center/index",
        Origin: "https://link.bilibili.com",
      },
    });
    const exchanged = order.code === 0;
    return {
      code: 0,
      message: exchanged ? `已兑换 ${goldCount} 电池` : `兑换失败：${order.message || order.code}`,
      data: {
        ...emptyYearVipData,
        isYearVip: true,
        claimable,
        alreadyClaimed,
        bpCount,
        exchanged,
        goldCount: exchanged ? goldCount : 0,
      },
    };
  } catch (err) {
    console.error("[ToolsClient.exchangeYearVipBCoin] error:", err);
    return { code: -1, message: "请求失败", data: { ...emptyYearVipData } };
  }
}
