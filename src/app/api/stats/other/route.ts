import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { readPayRecords, getAccumulatedTianxuanGiftIds, getAccumulatedRedPocketGiftIds } from "@/lib/user-data";
import { fetchTianxuanGiftList, fetchRedPocketGiftList } from "@/lib/bilibili/gift-api";
import type { RawGiftRecord } from "@/lib/revenue";
import type { ApiResponse } from "@/lib/bilibili/types";

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
};

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

function buildMockOtherStats(): OtherStatsResponse {
  return {
    giftStats: {
      gifts: [
        { gift_id: 34003, gift_name: "天选福袋", gift_img: "", totalNum: 15, totalValue: 1500, unitPrice: 100 },
        { gift_id: 34016, gift_name: "天选之星", gift_img: "", totalNum: 8, totalValue: 800, unitPrice: 100 },
      ],
      totalCount: 23,
      totalValue: 2300,
      hasLuckyTitle: true,
    },
    dayStats: {
      totalDays: 150,
      maxConsecutiveDays: 45,
      maxConsecutiveStart: "2026-01-15",
      maxConsecutiveEnd: "2026-03-01",
      maxDaysInYear: 200,
      maxDaysInYearRange: { start: "2025-08-01", end: "2026-07-23" },
    },
    roomStats: [
      {
        ruid: 100000001,
        rname: "模拟主播-星辰",
        totalDays: 80,
        maxConsecutiveDays: 35,
        maxConsecutiveStart: "2026-03-01",
        maxConsecutiveEnd: "2026-04-05",
        maxDaysInYear: 180,
        maxDaysInYearRange: { start: "2025-09-01", end: "2026-07-23" },
      },
    ],
    dateRange: { start: "2025-06-01", end: "2026-07-23" },
  };
}

export async function GET(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  const sid = sidMatch?.[1] ?? null;
  console.log("[OtherStats] sid:", sid);
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    console.log("[OtherStats] 未登录，返回模拟数据");
    return NextResponse.json<ApiResponse<OtherStatsResponse>>(
      { code: 0, message: "mock", data: buildMockOtherStats() },
      { status: 200 },
    );
  }

  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    return NextResponse.json<ApiResponse<null>>(
      { code: 401, message: "needs-relogin", data: null },
      { status: 401 },
    );
  }

  try {
    const biliCookie = credentialResult.cookie;

    // 获取天选和红包礼物ID列表
    let tianxuanGiftIds: number[] = [];
    try {
      const tianxuanGifts = await fetchTianxuanGiftList(biliCookie);
      tianxuanGiftIds = await getAccumulatedTianxuanGiftIds(tianxuanGifts.map(g => g.id));
    } catch (err) {
      console.error("[OtherStats] 获取天选礼物列表失败:", err);
    }

    let redPocketGiftIds: number[] = [];
    try {
      const redPocketGifts = await fetchRedPocketGiftList(biliCookie);
      redPocketGiftIds = await getAccumulatedRedPocketGiftIds(redPocketGifts.map(g => g.id));
    } catch (err) {
      console.error("[OtherStats] 获取红包礼物列表失败:", err);
    }

    const records = await readPayRecords(credentialResult.session.mid, credentialResult.session.uname || "");

    if (records.length === 0) {
      return NextResponse.json<ApiResponse<OtherStatsResponse>>(
        { code: 0, message: "ok", data: buildMockOtherStats() },
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
    const roomMap = new Map<number, { rname: string; dateSet: Set<string> }>();
    for (const r of allRecords) {
      const existing = roomMap.get(r.ruid);
      if (existing) {
        existing.dateSet.add(getDateStr(r.timestamp));
      } else {
        roomMap.set(r.ruid, { rname: r.r_uname, dateSet: new Set([getDateStr(r.timestamp)]) });
      }
    }

    const roomStats: RoomStat[] = [];
    for (const [ruid, { rname, dateSet }] of roomMap) {
      const sortedDates = Array.from(dateSet).sort();
      const consecutive = calcMaxConsecutive(sortedDates);
      const yearMax = calcMaxDaysInYear(sortedDates);
      roomStats.push({
        ruid,
        rname,
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

    const data: OtherStatsResponse = { giftStats: { gifts, totalCount, totalValue, hasLuckyTitle }, dayStats, roomStats, dateRange };

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
