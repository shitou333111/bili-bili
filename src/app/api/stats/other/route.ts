import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { readPayRecords, getAccumulatedTianxuanGiftIds, getAccumulatedRedPocketGiftIds } from "@/lib/user-data";
import { fetchTianxuanGiftList, fetchRedPocketGiftList } from "@/lib/bilibili/gift-api";
import { isOffline } from "@/lib/offline";
import type { RawGiftRecord } from "@/lib/revenue";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

// 星愿水晶球单价（电池），用于判断"天选之子"头衔
const CRYSTAL_BALL_PRICE = 1000;

type GiftEntry = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  totalNum: number;
  totalValue: number;
  unitPrice: number;
};

type GiftStats = {
  gifts: GiftEntry[];
  totalCount: number;
  totalValue: number;
  hasLuckyTitle: boolean;
};

type DayStats = {
  totalDays: number;
  maxConsecutiveDays: number;
  maxConsecutiveStart: string;
  maxConsecutiveEnd: string;
  maxDaysInYear: number;
  maxDaysInYearRange: { start: string; end: string };
};

type RoomStat = {
  ruid: number;
  rname: string;
  totalDays: number;
  maxConsecutiveDays: number;
  maxConsecutiveStart: string;
  maxConsecutiveEnd: string;
  maxDaysInYear: number;
  maxDaysInYearRange: { start: string; end: string };
};

type OtherStatsResponse = {
  giftStats: GiftStats;
  dayStats: DayStats;
  roomStats: RoomStat[];
  dateRange: { start: string; end: string } | null;
  antiKill: AntiKillStats;
};

/** 防氪记录统计：只追踪最近 30 天消费，提醒用户理性消费 */
type AntiKillStats = {
  totalBattery: number; // 近30天真实消费电池（不封顶）
  noSpendDays: number; // 30 天内未消费的天数
  over1000Days: number; // 30 天内单日消费超过 1000 电池的天数
  value: number; // 防氪值：10000 - 近30天累计封顶电池（单日超 1000 按 1000 计），最低为 0
};

/** 计算防氪记录（records 需为已剔除"已退回"的记录） */
function computeAntiKill(records: RawGiftRecord[]): AntiKillStats {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;
  const CAP_PER_DAY = 1000;
  const FULL_SCORE = 10000;
  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS;

  const dayMap = new Map<string, number>();
  let totalBattery = 0;
  for (const r of records) {
    if (!r.timestamp) continue;
    if (r.timestamp * 1000 < cutoff) continue; // 不在最近 30 天内
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, "")) || 0;
    if (coins <= 0) continue;
    const date = getDateStr(r.timestamp);
    dayMap.set(date, (dayMap.get(date) || 0) + coins);
    totalBattery += coins;
  }

  let over1000Days = 0;
  let cappedSum = 0;
  for (const daily of dayMap.values()) {
    if (daily > CAP_PER_DAY) over1000Days++;
    cappedSum += Math.min(daily, CAP_PER_DAY);
  }

  return {
    totalBattery,
    noSpendDays: Math.max(0, WINDOW_DAYS - dayMap.size),
    over1000Days,
    value: Math.max(0, FULL_SCORE - cappedSum),
  };
}

/** 计算最长连续天数和起止日期 */
function calcMaxConsecutive(sortedDates: string[]): { max: number; start: string; end: string } {
  if (sortedDates.length === 0) return { max: 0, start: "", end: "" };

  let maxLen = 1;
  let maxStart = sortedDates[0];
  let maxEnd = sortedDates[0];
  let curLen = 1;
  let curStart = sortedDates[0];

  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]);
    const cur = new Date(sortedDates[i]);
    const diffDays = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      curLen++;
    } else {
      if (curLen > maxLen) {
        maxLen = curLen;
        maxStart = curStart;
        maxEnd = sortedDates[i - 1];
      }
      curLen = 1;
      curStart = sortedDates[i];
    }
  }
  if (curLen > maxLen) {
    maxLen = curLen;
    maxStart = curStart;
    maxEnd = sortedDates[sortedDates.length - 1];
  }

  return { max: maxLen, start: maxStart, end: maxEnd };
}

/** 计算任意365天内的最大活跃天数及起止日期 */
function calcMaxDaysInYear(sortedDates: string[]): { max: number; start: string; end: string } {
  if (sortedDates.length === 0) return { max: 0, start: "", end: "" };

  let maxCount = 1;
  let maxStart = sortedDates[0];
  let maxEnd = sortedDates[0];

  // 双指针滑动窗口
  let left = 0;
  for (let right = 0; right < sortedDates.length; right++) {
    const leftDate = new Date(sortedDates[left]);
    const rightDate = new Date(sortedDates[right]);
    const diffDays = Math.round((rightDate.getTime() - leftDate.getTime()) / 86400000);

    while (diffDays > 365) {
      left++;
      const newLeftDate = new Date(sortedDates[left]);
      const newDiff = Math.round((rightDate.getTime() - newLeftDate.getTime()) / 86400000);
      if (newDiff <= 365) break;
    }

    const count = right - left + 1;
    if (count > maxCount) {
      maxCount = count;
      maxStart = sortedDates[left];
      maxEnd = sortedDates[right];
    }
  }

  return { max: maxCount, start: maxStart, end: maxEnd };
}

function getDateStr(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  console.log("[OtherStats] sid:", sid);
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    console.log("[OtherStats] 未登录，需要重新登录");
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  const offline = isOffline(url);

  // 离线模式：跳过 B 站凭证校验与天选/红包列表抓取，直接基于本地缓存计算
  if (!offline) {
    const credentialResult = await ensureValidCredential(session);
    if (!credentialResult.valid) {
      return NextResponse.json<ApiResponse<null>>(
        { code: 401, message: "needs-relogin", data: null },
        { status: 401 },
      );
    }
  }

  try {
    // 获取天选和红包礼物ID列表（离线时跳过 B 站抓取，仅用本地累积的 ID）
    let tianxuanGiftIds: number[] = [];
    const tianxuanGifts = offline ? [] : await fetchTianxuanGiftList("").catch(() => []);
    tianxuanGiftIds = await getAccumulatedTianxuanGiftIds(tianxuanGifts.map(g => g.id));

    let redPocketGiftIds: number[] = [];
    const redPocketGifts = offline ? [] : await fetchRedPocketGiftList("").catch(() => []);
    redPocketGiftIds = await getAccumulatedRedPocketGiftIds(redPocketGifts.map(g => g.id));

    const records = await readPayRecords(session.mid, session.uname || "");

    if (records.length === 0) {
      const empty: OtherStatsResponse = {
        giftStats: { gifts: [], totalCount: 0, totalValue: 0, hasLuckyTitle: false },
        dayStats: { totalDays: 0, maxConsecutiveDays: 0, maxConsecutiveStart: "", maxConsecutiveEnd: "", maxDaysInYear: 0, maxDaysInYearRange: { start: "", end: "" } },
        roomStats: [],
        dateRange: null,
        antiKill: computeAntiKill([]),
      };
      return NextResponse.json<ApiResponse<OtherStatsResponse>>(
        { code: 0, message: "empty", data: empty },
        { status: 200 },
      );
    }

    // 天选+红包合并ID集合
    const luckyGiftIds = new Set([...tianxuanGiftIds, ...redPocketGiftIds]);

    // 1. 天选/红包礼物统计
    const giftMap = new Map<number, { gift_id: number; gift_name: string; gift_img: string; totalNum: number; totalValue: number; unitPrice: number }>();
    for (const r of records) {
      if (r.status_msg === "已退回") continue;
      if (!luckyGiftIds.has(r.gift_id)) continue;

      const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, "")) || 0;
      const existing = giftMap.get(r.gift_id);
      if (existing) {
        existing.totalNum += r.gift_num;
        existing.totalValue += coins;
      } else {
        const unitPrice = r.gift_num > 0 ? Math.round(coins / r.gift_num) : coins;
        giftMap.set(r.gift_id, {
          gift_id: r.gift_id,
          gift_name: r.gift_name,
          gift_img: r.gift_img || "",
          totalNum: r.gift_num,
          totalValue: coins,
          unitPrice,
        });
      }
    }

    const gifts = Array.from(giftMap.values()).sort((a, b) => b.totalValue - a.totalValue);
    const totalCount = gifts.reduce((sum, g) => sum + g.totalNum, 0);
    const totalValue = gifts.reduce((sum, g) => sum + g.totalValue, 0);
    const hasLuckyTitle = gifts.some(g => g.unitPrice >= CRYSTAL_BALL_PRICE);

    // 2. 送礼天数统计（所有礼物都算）
    const allDateSet = new Set<string>();
    const allRecords = records.filter(r => r.status_msg !== "已退回" && r.timestamp);
    for (const r of allRecords) {
      allDateSet.add(getDateStr(r.timestamp));
    }
    const allSortedDates = Array.from(allDateSet).sort();
    const allConsecutive = calcMaxConsecutive(allSortedDates);
    const allYearMax = calcMaxDaysInYear(allSortedDates);

    const dayStats: DayStats = {
      totalDays: allSortedDates.length,
      maxConsecutiveDays: allConsecutive.max,
      maxConsecutiveStart: allConsecutive.start,
      maxConsecutiveEnd: allConsecutive.end,
      maxDaysInYear: allYearMax.max,
      maxDaysInYearRange: { start: allYearMax.start, end: allYearMax.end },
    };

    // 3. 每个主播的送礼天数统计
    const roomMap = new Map<number, { rname: string; dateSet: Set<string>; allTianxuan: boolean }>();
    for (const r of allRecords) {
      // 天选礼物：主播给自己发的红包，r_uname 为空、ruid=0，需特殊命名
      // 归到当前登录账号（session.mid）显示为"自己发天选"
      const isTianxuan = tianxuanGiftIds.includes(r.gift_id) || (r.ruid === 0 && !r.r_uname);
      const ruid = (r.ruid === 0 && !r.r_uname) ? session.mid : r.ruid;
      const existing = roomMap.get(ruid);
      if (existing) {
        // 优先使用非空的真实主播名
        if (!existing.rname && r.r_uname) existing.rname = r.r_uname;
        // 只要存在非天选记录，就不是"给自己发天选"
        if (!isTianxuan) existing.allTianxuan = false;
        existing.dateSet.add(getDateStr(r.timestamp));
      } else {
        roomMap.set(ruid, {
          rname: r.r_uname,
          dateSet: new Set([getDateStr(r.timestamp)]),
          allTianxuan: isTianxuan,
        });
      }
    }

    const roomStats: RoomStat[] = [];
    for (const [ruid, { rname, dateSet, allTianxuan }] of roomMap) {
      const sortedDates = Array.from(dateSet).sort();
      const consecutive = calcMaxConsecutive(sortedDates);
      const yearMax = calcMaxDaysInYear(sortedDates);
      const resolvedName = rname || (allTianxuan ? "自己发天选" : `主播${ruid}`);
      roomStats.push({
        ruid,
        rname: resolvedName,
        totalDays: sortedDates.length,
        maxConsecutiveDays: consecutive.max,
        maxConsecutiveStart: consecutive.start,
        maxConsecutiveEnd: consecutive.end,
        maxDaysInYear: yearMax.max,
        maxDaysInYearRange: { start: yearMax.start, end: yearMax.end },
      });
    }
    roomStats.sort((a, b) => b.totalDays - a.totalDays);

    // 日期范围
    const dateRange = allSortedDates.length > 0
      ? { start: allSortedDates[0], end: allSortedDates[allSortedDates.length - 1] }
      : null;

    const data: OtherStatsResponse = { giftStats: { gifts, totalCount, totalValue, hasLuckyTitle }, dayStats, roomStats, dateRange, antiKill: computeAntiKill(allRecords) };

    return NextResponse.json<ApiResponse<OtherStatsResponse>>(
      { code: 0, message: "ok", data },
      { status: 200 },
    );
  } catch (err) {
    console.error("[OtherStats] 统计失败:", err);
    return NextResponse.json<ApiResponse<null>>(
      { code: 500, message: "统计失败", data: null },
      { status: 500 },
    );
  }
}