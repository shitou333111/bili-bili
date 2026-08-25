/**
 * B站礼物相关API调用
 * 包括：盲盒检测、盲盒记录、天选礼物列表、合成活动信息
 */
import { fetchBilibiliJson } from "@/lib/bilibili/client";
import { BLIND_BOX_API, TIANXUAN_CONFIG, RED_POCKET_CONFIG } from "@/lib/config";
import type { BlindBoxGift } from "@/lib/blind-box-db";
import { getCachedName, setCachedAnchorInfo, getCachedFace, setCachedFanInfo } from "@/lib/user-data";

// ====== 盲盒检测响应类型 ======
type BlindFirstWinResponse = {
  code: number;
  message: string;
  data: {
    note_text: string;
    blind_price: number;
    gifts: Array<{
      gift_id: number;
      price: number;
      gift_name: string;
      gift_img: string;
      is_win_gift: number;
      chance: string;
    }>;
    blind_gift_name: string;
    is_first: boolean;
  } | null;
};

// ====== 盲盒抽取记录响应类型 ======
type BlindBoxDrawResponse = {
  code: number;
  message: string;
  data: {
    list: Array<{
      gift_id: number;
      gift_name: string;
      gift_num: number;
      original_gift_id: number;
      original_gift_name: string;
      gift_img: string;
      timestamp: string; // "2026-07-10 23:51:07"
      ruid: number;
      rname: string;
      [key: string]: unknown;
    }>;
    params?: {
      next_id: number;
      next_inner_id: number;
      year: number;
      have_more: boolean;
      year_month: string;
    };
    isMore?: string | number; // "1"/"0"
    has_more?: number;
    total_count?: number;
  } | null;
};

// ====== 天选礼物列表响应类型 ======
type TianxuanGiftPanelResponse = {
  code: number;
  message: string;
  data: {
    list: Array<{
      id: number;
      name: string;
      img: string;
      price: number;
    }>;
  } | null;
};

// ====== 盲盒检测结果 ======
export type BlindBoxCheckResult = {
  isBlindBox: boolean;
  blindPrice: number;
  blindGiftName: string;
  gifts: BlindBoxGift[];
};

// ====== 盲盒抽取记录 ======
export type BlindBoxDrawRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  original_gift_id: number;
  original_gift_name: string;
  gift_img: string;
  timestamp: string;
  ruid: number;
  rname: string;
};

// ====== 天选礼物 ======
export type TianxuanGift = {
  id: number;
  name: string;
  img: string;
  price: number;
};

// ====== 盲盒检测 ======

/**
 * 检测一个礼物是否为盲盒（需要登录态Cookie）
 * 调用 blindFirstWin/getInfo 接口
 * 如果返回 code=0 且有 gifts 数据，说明是盲盒
 * 如果返回 code=200006（道具不存在），说明不是盲盒或已过期
 */
export async function checkBlindBox(giftId: number, cookie: string): Promise<BlindBoxCheckResult | null> {
  try {
    const url = `${BLIND_BOX_API.blindFirstWin}?gift_id=${giftId}`;
    const response = await fetchBilibiliJson<BlindFirstWinResponse>({
      url,
      cookie,
      mobile: false,
    });

    if (response.code === 0 && response.data?.gifts && response.data.gifts.length > 0) {
      return {
        isBlindBox: true,
        blindPrice: Math.round(response.data.blind_price / 100),
        blindGiftName: response.data.blind_gift_name,
        gifts: response.data.gifts.map((g) => ({
          gift_id: g.gift_id,
          price: Math.round(g.price / 100),
          gift_name: g.gift_name,
          gift_img: g.gift_img,
          is_win_gift: g.is_win_gift,
          chance: g.chance,
        })),
      };
    }

    // code=200006 或其他错误码表示不是盲盒或已过期
    return null;
  } catch (error) {
    console.error(`[BlindBox] 检测礼物 ${giftId} 失败:`, error);
    return null;
  }
}

// ====== 盲盒抽取记录 ======

/**
 * 获取盲盒抽取记录（需要登录态Cookie）
 * 返回该盲盒的所有历史抽取记录，包含每次爆出的礼物
 * 分页逻辑：根据响应中的 have_more/isMore 字段判断是否还有更多数据
 * @param latestTimestamp 上次获取的最新记录时间戳，用于增量获取（可选）
 */
export async function fetchBlindBoxDrawStream(
  giftId: number,
  cookie: string,
  latestTimestamp?: string,
): Promise<BlindBoxDrawRecord[]> {
  const allRecords: BlindBoxDrawRecord[] = [];
  let page = 1;
  const MAX_PAGES = 100;
  let nextParams: Record<string, unknown> | undefined;
  const rawPages: Array<{ page: number; response: unknown }> = [];

  try {
    while (page <= MAX_PAGES) {
      let url = `${BLIND_BOX_API.drawStream}?gift_id=${giftId}&page_size=50`;
      if (nextParams) {
        for (const [key, value] of Object.entries(nextParams)) {
          if (key === "have_more") continue;
          if (value !== undefined) {
            url += `&${key}=${encodeURIComponent(String(value))}`;
          }
        }
      }

      const response = await fetchBilibiliJson<BlindBoxDrawResponse>({
        url,
        cookie,
        mobile: false,
      });

      rawPages.push({ page, response: { code: response.code, data: response.data } });

      if (response.code !== 0 || !response.data?.list) {
        break;
      }

      const list = response.data.list;
      if (list.length === 0) {
        break;
      }

      let hasOverlap = false;
      for (const item of list) {
        if (latestTimestamp && item.timestamp <= latestTimestamp) {
          hasOverlap = true;
          break;
        }
        allRecords.push({
          gift_id: item.gift_id,
          gift_name: item.gift_name,
          gift_num: item.gift_num,
          original_gift_id: item.original_gift_id,
          original_gift_name: item.original_gift_name,
          gift_img: item.gift_img,
          timestamp: item.timestamp,
          ruid: item.ruid,
          rname: item.rname,
        });
      }

      if (hasOverlap) {
        console.log(`[BlindBox] 盲盒 ${giftId} 与已有数据重叠，停止翻页（最新时间戳=${latestTimestamp}）`);
        break;
      }

      nextParams = response.data.params as Record<string, unknown> | undefined;

      const params = response.data.params;
      const isMore = response.data.isMore;
      let haveMore = false;
      if (params?.have_more !== undefined) {
        haveMore = params.have_more;
      } else if (isMore !== undefined) {
        haveMore = isMore === "1" || isMore === 1;
      } else if (response.data.has_more !== undefined) {
        haveMore = response.data.has_more === 1;
      }

      if (!haveMore) {
        break;
      }

      page++;
    }

    console.log(`[BlindBox] 获取盲盒 ${giftId} 抽取记录 ${allRecords.length} 条 (共${page}页)`);
    return allRecords;
  } catch (error) {
    console.error(`[BlindBox] 获取盲盒 ${giftId} 抽取记录失败:`, error);
    return allRecords;
  }
}

// ====== 天选礼物列表 ======

/**
 * 获取天选礼物列表（需要登录态Cookie）
 */
export async function fetchTianxuanGiftList(cookie: string): Promise<TianxuanGift[]> {
  try {
    const response = await fetchBilibiliJson<TianxuanGiftPanelResponse>({
      url: TIANXUAN_CONFIG.url,
      cookie,
      mobile: false,
    });

    if (response.code === 0 && response.data?.list) {
      const gifts = response.data.list.map((g) => ({
        id: g.id,
        name: g.name,
        img: g.img,
        price: g.price,
      }));
      console.log(`[fetchTianxuanGiftList] 获取到 ${gifts.length} 个天选礼物:`, gifts.map(g => `id:${g.id} name:${g.name}`));
      return gifts;
    }

    return [];
  } catch (error) {
    console.error("[Tianxuan] 获取天选礼物列表失败:", error);
    return [];
  }
}

// ====== 红包礼物列表 ======

export type RedPocketGift = {
  id: number;
  name: string;
};

/**
 * 获取红包礼物列表
 * API 响应结构: data.item[].award_info[].award_id/award_name
 */
export async function fetchRedPocketGiftList(cookie: string): Promise<RedPocketGift[]> {
  try {
    const url = `${RED_POCKET_CONFIG.url}?room_id=23915535&ruid=488750234&platform=pc&rp_type=1`;
    const response = await fetchBilibiliJson<{
      code: number;
      message: string;
      data: {
        item?: Array<{
          award_info?: Array<{
            award_id: number;
            award_name: string;
          }>;
        }>;
      } | null;
    }>({
      url,
      cookie,
      mobile: false,
    });

    if (response.code === 0 && response.data?.item) {
      const giftMap = new Map<number, string>();
      for (const item of response.data.item) {
        if (item.award_info) {
          for (const award of item.award_info) {
            if (award.award_id && !giftMap.has(award.award_id)) {
              giftMap.set(award.award_id, award.award_name);
            }
          }
        }
      }
      const gifts: RedPocketGift[] = Array.from(giftMap.entries()).map(([id, name]) => ({ id, name }));
      console.log(`[fetchRedPocketGiftList] 获取到 ${gifts.length} 个红包礼物:`, gifts.map(g => `id:${g.id} name:${g.name}`));
      return gifts;
    }

    console.log(`[fetchRedPocketGiftList] API返回无数据, code=${response.code}, message=${response.message}`);
    return [];
  } catch (error) {
    console.error("[RedPocket] 获取红包礼物列表失败:", error);
    return [];
  }
}

// ====== 包裹礼物列表 ======

export type BagGiftItem = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  is_locked: boolean;
  locked_text: string;
  /** 单价（元） */
  price: number;
  img: string;
};

type BagListResponse = {
  code: number;
  message: string;
  data: {
    list?: Array<{
      bag_id: number;
      gift_id: number;
      gift_name: string;
      gift_num: number;
      is_locked: boolean;
      locked_text: string;
    }>;
    gift_config?: Array<{ id: number; name: string; price: number; img_basic: string }>;
  } | null;
};

/**
 * 获取包裹礼物列表（需要登录态Cookie）
 * 合成礼物在未送出前会暂存于包裹中，不出现于消费记录，
 * 因此需要访问本接口与消费记录互补，构成完整的合成产出礼物列表。
 */
export async function fetchBagList(cookie: string): Promise<BagGiftItem[]> {
  try {
    const url = `https://api.live.bilibili.com/xlive/web-room/v1/gift/bag_list?room_id=23915535`;
    const response = await fetchBilibiliJson<BagListResponse>({ url, cookie, live: true });
    if (response.code !== 0 || !response.data?.list) {
      return [];
    }
    // gift_config 是数组，按 gift_id 建立索引后再匹配价格与图标
    const configMap = new Map<number, { name: string; price: number; img_basic: string }>();
    for (const c of response.data.gift_config ?? []) {
      configMap.set(c.id, c);
    }
    const items = response.data.list.map((item) => {
      const cfg = configMap.get(item.gift_id);
      return {
        gift_id: item.gift_id,
        gift_name: item.gift_name,
        gift_num: item.gift_num,
        is_locked: item.is_locked,
        locked_text: item.locked_text || "",
        // 礼物列表中的 price 是分（百分为 1 电池），除以 100 换算成电池单价
        price: cfg ? Math.round(cfg.price / 100) : 0,
        img: cfg?.img_basic || "",
      };
    });
    console.log(`[fetchBagList] 获取到 ${items.length} 个包裹礼物`);
    return items;
  } catch (error) {
    console.error("[BagList] 获取包裹礼物列表失败:", error);
    return [];
  }
}

type UserInfoResponse = {
  code: number;
  message: string;
  data: {
    card: {
      mid: string;
      name: string;
      face: string;
    };
  } | null;
};

export async function fetchUserNameByUid(mid: number): Promise<string | null> {
  try {
    const url = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
      },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as UserInfoResponse;
    if (data.code === 0 && data.data?.card?.name) {
      return data.data.card.name;
    }
    return null;
  } catch {
    return null;
  }
}

const userNameCache = new Map<number, string>();

export async function getUserNameByUid(mid: number, requesterMid?: number, requesterUname?: string): Promise<string> {
  if (userNameCache.has(mid)) {
    return userNameCache.get(mid)!;
  }

  // 从用户的主播列表文件读取
  if (requesterMid) {
    const cached = await getCachedName(requesterMid, requesterUname || "", mid);
    if (cached) {
      userNameCache.set(mid, cached);
      return cached;
    }
  }

  const name = await fetchUserNameByUid(mid);
  if (name) {
    userNameCache.set(mid, name);
    // 写入用户的主播列表文件
    if (requesterMid) {
      await setCachedAnchorInfo(requesterMid, requesterUname || "", mid, name, "");
    }
    return name;
  }
  return `主播${mid}`;
}

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

const userInfoCache = new Map<number, { name: string; face: string }>();

const NOFACE_PATTERN = /\/noface\.jpg$/;

function normalizeFace(face: string): string {
  if (!face) return "";
  if (NOFACE_PATTERN.test(face)) return "";
  return face;
}

export function clearUserInfoCache(uid?: number) {
  if (uid !== undefined) {
    userInfoCache.delete(uid);
  } else {
    userInfoCache.clear();
  }
}

async function fetchUserInfoWithRetry(mid: number, retries = 3): Promise<{ name: string; face: string } | null> {
  const url = `https://api.live.bilibili.com/live_user/v1/card/card_up?uid=${mid}&browser=0`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
      const data = await fetchBilibiliJson<LiveCardResponse>({ url, live: true });
      if (data.code === 0 && data.data) {
        return {
          name: data.data.uname || `用户${mid}`,
          face: normalizeFace(data.data.face),
        };
      } else {
        console.warn(`[getUserInfo] mid=${mid} attempt=${attempt+1} API错误: code=${data.code} msg=${data.message || data.msg}`);
      }
    } catch (err) {
      console.warn(`[getUserInfo] mid=${mid} attempt=${attempt+1} 请求异常:`, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

export async function getUserInfoByUid(mid: number, forceRefresh = false, requesterMid?: number, requesterUname?: string): Promise<{ name: string; face: string }> {
  if (!forceRefresh && userInfoCache.has(mid)) {
    return userInfoCache.get(mid)!;
  }

  // 从用户的文件读取缓存
  if (!forceRefresh && requesterMid) {
    const cachedName = await getCachedName(requesterMid, requesterUname || "", mid);
    const cachedFace = await getCachedFace(requesterMid, requesterUname || "", mid);
    if (cachedFace) {
      const info = { name: cachedName || `用户${mid}`, face: cachedFace };
      userInfoCache.set(mid, info);
      return info;
    }
  }

  const result = await fetchUserInfoWithRetry(mid);

  if (result && result.face) {
    userInfoCache.set(mid, result);
    // 写入用户的粉丝列表文件
    if (requesterMid) {
      await setCachedFanInfo(requesterMid, requesterUname || "", mid, result.name, result.face);
    }
    return result;
  }

  // Fallback: 尝试web-interface/card接口
  try {
    const cardUrl = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
    const cardData = await fetchBilibiliJson<UserInfoResponse>({ url: cardUrl });
    if (cardData.code === 0 && cardData.data?.card?.face) {
      const info = {
        name: cardData.data.card.name || `用户${mid}`,
        face: normalizeFace(cardData.data.card.face),
      };
      userInfoCache.set(mid, info);
      if (requesterMid) {
        await setCachedFanInfo(requesterMid, requesterUname || "", mid, info.name, info.face);
      }
      return info;
    }
  } catch {
    // ignore
  }

  const fallback = { name: `用户${mid}`, face: "" };
  userInfoCache.set(mid, fallback);
  return fallback;
}
