import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBlindBoxDrawStream, checkBlindBox } from "@/lib/bilibili/gift-api";
import { getBlindBoxInfo, saveBlindBoxInfo, type BlindBoxGift } from "@/lib/blind-box-db";
import { BLIND_BOX_CONFIG } from "@/lib/config";
import { getEffectiveBlindBoxConfig } from "@/lib/config-override";
import { saveGiftsToDb, getGiftImg } from "@/lib/gift-db";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// 盲盒抽取记录存储类型（字段名与API返回一致）
type BlindBoxDrawRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  original_gift_id: number;
  original_gift_name: string;
  gift_img: string;
  timestamp: string; // API返回的时间字段
  ruid: number;
  rname: string;
};

// 城堡统计类型
type CastleStat = {
  ruid: number;
  rname: string;
  totalCount: number;
  dates: Array<{ date: string; count: number }>;
};

// 盲盒盈亏结果类型
type BlindBoxProfitResult = {
  blindBoxId: number;
  blindBoxName: string;
  blindBoxImg: string;
  blindPrice: number;
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  recordCount: number;
  /** 全部记录的时间范围 */
  dateRange: { start: string; end: string } | null;
  /** 全部记录的主播列表（按送出个数降序） */
  anchors: Array<{ ruid: number; rname: string; count: number }>;
  /** 当前筛选条件 */
  filter: { ruid: number | null; dateRange: string };
  gifts: Array<{
    gift_id: number;
    gift_name: string;
    gift_img: string;
    unitPrice: number;
    count: number;
    totalValue: number;
  }>;
  /** 城堡统计（仅心动盲盒） */
  castleStats: CastleStat[];
  /** 城堡礼物信息 */
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
};

// 数据存储目录
const DATA_DIR = path.join(process.cwd(), ".data");

// 浪漫城堡 gift_id
const CASTLE_ID = 32132;

// 计算城堡统计
function calculateCastleStats(
  drawRecords: BlindBoxDrawRecord[],
  blindBoxEntry: { price: number; gift_name: string; gift_img: string; blind_box_gifts?: BlindBoxGift[] } | null,
): { castleStats: CastleStat[]; castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null } {
  const castleGift = blindBoxEntry?.blind_box_gifts?.find((g) => g.gift_id === CASTLE_ID) ?? null;

  const castleRecords = drawRecords.filter((r) => r.gift_id === CASTLE_ID);
  if (castleRecords.length === 0) {
    return { castleStats: [], castleGift: castleGift ? { gift_id: castleGift.gift_id, gift_name: castleGift.gift_name, gift_img: castleGift.gift_img, price: castleGift.price } : null };
  }

  const anchorMap = new Map<number, { rname: string; totalCount: number; dates: Map<string, number> }>();

  for (const record of castleRecords) {
    const date = record.timestamp.split(" ")[0];
    let anchor = anchorMap.get(record.ruid);
    if (!anchor) {
      anchor = { rname: record.rname, totalCount: 0, dates: new Map() };
      anchorMap.set(record.ruid, anchor);
    }
    anchor.totalCount += record.gift_num;
    anchor.dates.set(date, (anchor.dates.get(date) ?? 0) + record.gift_num);
  }

  const castleStats: CastleStat[] = Array.from(anchorMap.entries()).map(([ruid, anchor]) => ({
    ruid,
    rname: anchor.rname,
    totalCount: anchor.totalCount,
    dates: Array.from(anchor.dates.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  }));

  castleStats.sort((a, b) => b.totalCount - a.totalCount);

  return {
    castleStats,
    castleGift: castleGift ? { gift_id: castleGift.gift_id, gift_name: castleGift.gift_name, gift_img: castleGift.gift_img, price: castleGift.price } : null,
  };
}

function getBlindBoxRecordsDir(mid: number, uname: string): string {
  const safeName = uname.replace(/[\\/:*?"<>|]/g, "_");
  return path.join(DATA_DIR, `uid_${mid}_${safeName}`);
}

// 确保目录存在
async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // 目录已存在
  }
}

// 在目录中查找匹配前缀和后缀的文件
async function findFileByPrefix(dir: string, prefix: string, suffix: string): Promise<string | null> {
  try {
    const files = await fs.readdir(dir);
    const match = files.find(f => f.startsWith(prefix) && f.endsWith(suffix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

// 清理文件名中的非法字符
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

// 获取北京时间字符串
function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

// 读取已存储的盲盒记录
async function readBlindBoxRecords(mid: number, uname: string, blindBoxId: number): Promise<BlindBoxDrawRecord[]> {
  await ensureDir(DATA_DIR);
  const dir = getBlindBoxRecordsDir(mid, uname);
  await fs.mkdir(dir, { recursive: true });
  const filePath = await findFileByPrefix(dir, `blind-box-${blindBoxId}`, "-records.json");
  if (!filePath) return [];
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

// 获取已存储记录的最新时间戳
function getLatestTimestamp(records: BlindBoxDrawRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  let latest = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return latest;
}

// 保存盲盒记录
async function saveBlindBoxRecords(mid: number, uname: string, blindBoxId: number, records: BlindBoxDrawRecord[], blindBoxName?: string) {
  await ensureDir(DATA_DIR);
  const dir = getBlindBoxRecordsDir(mid, uname);
  await fs.mkdir(dir, { recursive: true });
  const safeName = blindBoxName ? sanitizeFileName(blindBoxName) : "";
  const fileName = safeName
    ? `blind-box-${blindBoxId}-${safeName}-records.json`
    : `blind-box-${blindBoxId}-records.json`;
  const filePath = path.join(dir, fileName);

  // 删除旧文件
  if (safeName) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`blind-box-${blindBoxId}`) && f.endsWith("-records.json") && f !== fileName) {
          await fs.unlink(path.join(dir, f));
          console.log(`[BlindBoxRecords] 删除旧文件: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = {
    exportedAt: getBeijingTime(),
    records,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// 合并新旧记录，去重
function mergeRecords(existing: BlindBoxDrawRecord[], newRecords: BlindBoxDrawRecord[]): BlindBoxDrawRecord[] {
  const sortedExisting = [...existing].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const sortedNew = [...newRecords].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  if (sortedExisting.length === 0) {
    return sortedNew;
  }

  const existingLatestTime = sortedExisting[0].timestamp;
  let overlapIndex = -1;

  for (let i = 0; i < sortedNew.length; i++) {
    if (sortedNew[i].timestamp === existingLatestTime) {
      overlapIndex = i;
      break;
    }
  }

  if (overlapIndex === -1) {
    const newLatestTime = sortedNew[0].timestamp;
    if (new Date(newLatestTime).getTime() > new Date(existingLatestTime).getTime()) {
      return [...sortedNew, ...sortedExisting];
    }
    return sortedExisting;
  }

  const newRecordsToAdd = sortedNew.slice(0, overlapIndex);
  return [...newRecordsToAdd, ...sortedExisting];
}

// 日期筛选函数
function getDateRangeFilter(type: string): { start: Date; end: Date } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (type) {
    case "today": {
      const end = new Date(today);
      end.setDate(end.getDate() + 1);
      return { start: today, end };
    }
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayEnd = new Date(today);
      return { start: yesterday, end: yesterdayEnd };
    }
    case "thisWeek": {
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }
    case "thisMonth": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { start, end };
    }
    default:
      return null; // "all" - 不筛选
  }
}

// 过滤记录
function filterRecords(
  records: BlindBoxDrawRecord[],
  ruid: number | null,
  dateRange: string,
): BlindBoxDrawRecord[] {
  let filtered = records;

  // 主播筛选
  if (ruid !== null) {
    filtered = filtered.filter((r) => r.ruid === ruid);
  }

  // 日期筛选
  const range = getDateRangeFilter(dateRange);
  if (range) {
    filtered = filtered.filter((r) => {
      const t = new Date(r.timestamp).getTime();
      return t >= range.start.getTime() && t < range.end.getTime();
    });
  }

  return filtered;
}

// 构建主播列表（按送出个数降序）
function buildAnchorList(records: BlindBoxDrawRecord[]): Array<{ ruid: number; rname: string; count: number }> {
  const map = new Map<number, { rname: string; count: number }>();
  for (const r of records) {
    const existing = map.get(r.ruid) ?? { rname: r.rname, count: 0 };
    existing.count += r.gift_num;
    map.set(r.ruid, existing);
  }
  return Array.from(map.entries())
    .map(([ruid, v]) => ({ ruid, rname: v.rname, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

// 计算时间范围
function getDateRange(records: BlindBoxDrawRecord[]): { start: string; end: string } | null {
  if (records.length === 0) return null;
  let earliest = records[0].timestamp;
  let latest = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp < earliest) earliest = r.timestamp;
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return { start: earliest, end: latest };
}

// 构建模拟的盲盒统计数据（未登录时返回）
function buildMockBlindBoxStats(): BlindBoxProfitResult[] {
  const results: BlindBoxProfitResult[] = [];

  // 心动盲盒模拟数据
  const XINDONG_ID = 32251;
  const xindongGifts = [
    { gift_id: 32132, gift_name: "浪漫城堡", gift_img: "", unitPrice: 12450, count: 200, totalValue: 2490000 },
    { gift_id: 31231, gift_name: "星愿水晶球", gift_img: "", unitPrice: 1000, count: 300, totalValue: 300000 },
    { gift_id: 32252, gift_name: "心动信笺", gift_img: "", unitPrice: 50, count: 1500, totalValue: 75000 },
    { gift_id: 32253, gift_name: "樱花雨", gift_img: "", unitPrice: 100, count: 800, totalValue: 80000 },
    { gift_id: 32254, gift_name: "星空奶茶", gift_img: "", unitPrice: 200, count: 600, totalValue: 120000 },
    { gift_id: 32255, gift_name: "棒棒糖", gift_img: "", unitPrice: 10, count: 3000, totalValue: 30000 },
    { gift_id: 32256, gift_name: "小心心", gift_img: "", unitPrice: 5, count: 5000, totalValue: 25000 },
  ];
  const xindongDrawCount = xindongGifts.reduce((s, g) => s + g.count, 0);
  const xindongBlindPrice = 150;
  const xindongTotalSpent = xindongDrawCount * xindongBlindPrice;
  const xindongTotalEarned = xindongGifts.reduce((s, g) => s + g.totalValue, 0);

  results.push({
    blindBoxId: XINDONG_ID,
    blindBoxName: "心动盲盒",
    blindBoxImg: "",
    blindPrice: xindongBlindPrice,
    totalSpent: xindongTotalSpent,
    totalEarned: xindongTotalEarned,
    profit: xindongTotalEarned - xindongTotalSpent,
    drawCount: xindongDrawCount,
    recordCount: xindongDrawCount,
    dateRange: { start: "2025-07-10 10:00:00", end: "2026-07-20 22:30:00" },
    anchors: [
      { ruid: 100000001, rname: "模拟主播-星辰", count: 2800 },
      { ruid: 100000002, rname: "模拟主播-月华", count: 2300 },
      { ruid: 100000003, rname: "模拟主播-清风", count: 1900 },
      { ruid: 100000004, rname: "模拟主播-小鹿", count: 1500 },
      { ruid: 100000005, rname: "模拟主播-月月", count: 1200 },
      { ruid: 100000006, rname: "模拟主播-晓晓", count: 900 },
      { ruid: 100000007, rname: "模拟主播-阿言", count: 700 },
      { ruid: 100000008, rname: "模拟主播-糖果", count: 500 },
      { ruid: 100000009, rname: "模拟主播-小鱼", count: 300 },
      { ruid: 100000010, rname: "模拟主播-小樱", count: 200 },
    ],
    filter: { ruid: null, dateRange: "all" },
    gifts: xindongGifts,
    castleStats: [
      {
        ruid: 100000001,
        rname: "模拟主播-星辰",
        totalCount: 68,
        dates: [
          { date: "2025-07-15", count: 2 },
          { date: "2025-08-10", count: 3 },
          { date: "2025-09-15", count: 5 },
          { date: "2025-10-20", count: 4 },
          { date: "2025-11-25", count: 3 },
          { date: "2025-12-31", count: 6 },
          { date: "2026-01-15", count: 4 },
          { date: "2026-02-14", count: 8 },
          { date: "2026-03-20", count: 5 },
          { date: "2026-04-10", count: 3 },
          { date: "2026-05-20", count: 7 },
          { date: "2026-06-15", count: 6 },
          { date: "2026-07-15", count: 12 },
        ],
      },
      {
        ruid: 100000002,
        rname: "模拟主播-月华",
        totalCount: 45,
        dates: [
          { date: "2025-08-08", count: 2 },
          { date: "2025-09-20", count: 3 },
          { date: "2025-10-15", count: 4 },
          { date: "2025-12-25", count: 6 },
          { date: "2026-01-20", count: 3 },
          { date: "2026-02-14", count: 5 },
          { date: "2026-03-30", count: 4 },
          { date: "2026-05-01", count: 5 },
          { date: "2026-06-01", count: 7 },
          { date: "2026-07-10", count: 6 },
        ],
      },
      {
        ruid: 100000003,
        rname: "模拟主播-清风",
        totalCount: 32,
        dates: [
          { date: "2025-08-20", count: 2 },
          { date: "2025-10-10", count: 3 },
          { date: "2025-12-05", count: 2 },
          { date: "2026-01-25", count: 3 },
          { date: "2026-03-15", count: 4 },
          { date: "2026-04-10", count: 5 },
          { date: "2026-05-25", count: 6 },
          { date: "2026-06-30", count: 3 },
          { date: "2026-07-05", count: 4 },
        ],
      },
      {
        ruid: 100000004,
        rname: "模拟主播-小鹿",
        totalCount: 24,
        dates: [
          { date: "2025-09-05", count: 1 },
          { date: "2025-11-11", count: 2 },
          { date: "2026-01-01", count: 3 },
          { date: "2026-02-22", count: 2 },
          { date: "2026-04-15", count: 4 },
          { date: "2026-05-30", count: 5 },
          { date: "2026-07-01", count: 3 },
          { date: "2026-07-18", count: 4 },
        ],
      },
      {
        ruid: 100000005,
        rname: "模拟主播-月月",
        totalCount: 18,
        dates: [
          { date: "2025-10-01", count: 2 },
          { date: "2025-12-12", count: 1 },
          { date: "2026-01-18", count: 3 },
          { date: "2026-03-08", count: 2 },
          { date: "2026-04-22", count: 3 },
          { date: "2026-05-30", count: 4 },
          { date: "2026-06-25", count: 2 },
          { date: "2026-07-20", count: 1 },
        ],
      },
      {
        ruid: 100000006,
        rname: "模拟主播-晓晓",
        totalCount: 12,
        dates: [
          { date: "2025-11-05", count: 1 },
          { date: "2026-02-10", count: 2 },
          { date: "2026-04-01", count: 2 },
          { date: "2026-05-15", count: 3 },
          { date: "2026-06-20", count: 2 },
          { date: "2026-07-12", count: 2 },
        ],
      },
    ],
    castleGift: { gift_id: 32132, gift_name: "浪漫城堡", gift_img: "", price: 12450 },
  });

  // 活动盲盒模拟数据（如果配置了）
  const activityId = BLIND_BOX_CONFIG.current_activity_blind_box_id ?? null;
  if (activityId && activityId !== XINDONG_ID) {
    const activityGifts = [
      { gift_id: 35685, gift_name: "星辉碎片", gift_img: "", unitPrice: 500, count: 200, totalValue: 100000 },
      { gift_id: 35686, gift_name: "月光宝盒", gift_img: "", unitPrice: 200, count: 300, totalValue: 60000 },
      { gift_id: 35687, gift_name: "小星星", gift_img: "", unitPrice: 50, count: 800, totalValue: 40000 },
      { gift_id: 35688, gift_name: "彩虹糖", gift_img: "", unitPrice: 20, count: 1200, totalValue: 24000 },
      { gift_id: 35689, gift_name: "气球", gift_img: "", unitPrice: 10, count: 2000, totalValue: 20000 },
    ];
    const activityDrawCount = activityGifts.reduce((s, g) => s + g.count, 0);
    const activityBlindPrice = 100;
    const activityTotalSpent = activityDrawCount * activityBlindPrice;
    const activityTotalEarned = activityGifts.reduce((s, g) => s + g.totalValue, 0);

    results.push({
      blindBoxId: activityId,
      blindBoxName: "活动盲盒（模拟）",
      blindBoxImg: "",
      blindPrice: activityBlindPrice,
      totalSpent: activityTotalSpent,
      totalEarned: activityTotalEarned,
      profit: activityTotalEarned - activityTotalSpent,
      drawCount: activityDrawCount,
      recordCount: activityDrawCount,
      dateRange: { start: "2026-06-15 14:00:00", end: "2026-07-20 21:00:00" },
      anchors: [
        { ruid: 100000001, rname: "模拟主播-星辰", count: 800 },
        { ruid: 100000002, rname: "模拟主播-月华", count: 600 },
        { ruid: 100000004, rname: "模拟主播-小鹿", count: 450 },
        { ruid: 100000006, rname: "模拟主播-晓晓", count: 350 },
        { ruid: 100000007, rname: "模拟主播-阿言", count: 250 },
        { ruid: 100000008, rname: "模拟主播-糖果", count: 180 },
      ],
      filter: { ruid: null, dateRange: "all" },
      gifts: activityGifts,
      castleStats: [],
      castleGift: null,
    });
  }

  return results;
}

// 计算盲盒盈亏
function calculateProfit(
  blindBoxId: number,
  blindBoxEntry: { price: number; gift_name: string; gift_img: string; blind_box_gifts?: BlindBoxGift[] } | null,
  drawRecords: BlindBoxDrawRecord[],
): BlindBoxProfitResult {
  const blindPrice = blindBoxEntry?.price ?? 0;
  const blindBoxName = blindBoxEntry?.gift_name ?? `盲盒_${blindBoxId}`;
  const blindBoxImg = blindBoxEntry?.gift_img ?? getGiftImg(blindBoxId) ?? "";

  // 构建 gift_id -> {price, img} 映射表
  const giftInfoMap = new Map<number, { price: number; img: string }>();
  if (blindBoxEntry?.blind_box_gifts) {
    for (const g of blindBoxEntry.blind_box_gifts) {
      giftInfoMap.set(g.gift_id, { price: g.price, img: g.gift_img });
    }
  }

  // 统计每种爆出礼物的数量和价值
  const giftStats = new Map<number, { gift_name: string; count: number; totalValue: number }>();

  for (const record of drawRecords) {
    const existing = giftStats.get(record.gift_id) ?? {
      gift_name: record.gift_name,
      count: 0,
      totalValue: 0,
    };
    existing.count += record.gift_num;
    const info = giftInfoMap.get(record.gift_id);
    const giftPrice = info?.price ?? 0;
    existing.totalValue += giftPrice * record.gift_num;
    giftStats.set(record.gift_id, existing);
  }

  let totalEarned = 0;
  for (const record of drawRecords) {
    const info = giftInfoMap.get(record.gift_id);
    totalEarned += (info?.price ?? 0) * record.gift_num;
  }

  const drawCount = drawRecords.reduce((sum, r) => sum + r.gift_num, 0);
  const totalSpent = drawCount * blindPrice;

  const gifts = Array.from(giftStats.entries()).map(([gift_id, stats]) => {
    const info = giftInfoMap.get(gift_id);
    return {
      gift_id,
      gift_name: stats.gift_name,
      gift_img: info?.img ?? "",
      unitPrice: info?.price ?? 0,
      count: stats.count,
      totalValue: stats.totalValue,
    };
  });

  return {
    blindBoxId,
    blindBoxName,
    blindBoxImg,
    blindPrice,
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    recordCount: drawRecords.length,
    dateRange: { start: "", end: "" },
    anchors: [],
    filter: { ruid: null, dateRange: "all" },
    gifts,
    castleStats: [],
    castleGift: null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    // 未登录时返回模拟的盲盒统计数据
    const mockData = buildMockBlindBoxStats();
    return NextResponse.json<ApiResponse<BlindBoxProfitResult[]>>(
      { code: 0, message: "mock", data: mockData },
      { status: 200 },
    );
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则返回需要重新登录（离线时跳过校验）
  const offline = isOffline(url);
  if (!offline) {
    const credentialResult = await ensureValidCredential(session);
    if (!credentialResult.valid) {
      return NextResponse.json<ApiResponse<null>>(
        { code: 401, message: "needs-relogin", data: null },
        { status: 401 },
      );
    }
  }

  const validSession = session;

  // 解析筛选参数（支持按盲盒ID分别筛选：ruid_32251=xxx, dateRange_32251=thisMonth）

  try {
    const biliCookie = "";

    const effectiveBlindBoxConfig = await getEffectiveBlindBoxConfig();
    const currentIds = effectiveBlindBoxConfig.current_activity_blind_box_ids ?? [];

    // 只包含在 admin 中勾选的盲盒
    const blindBoxIds = currentIds.filter((id) => id > 0);
    if (blindBoxIds.length === 0) {
      // 如果没有勾选任何盲盒，返回空结果
      return NextResponse.json({ code: 0, message: "ok", data: { blindBoxes: [], totalProfit: 0, hasActivityBlindBox: false } });
    }

    const results: BlindBoxProfitResult[] = [];

    for (const blindBoxId of blindBoxIds) {
      try {
        // 解析该盲盒的筛选参数
        const filterRuid = url.searchParams.get(`ruid_${blindBoxId}`);
        const filterDateRange = url.searchParams.get(`dateRange_${blindBoxId}`) ?? "all";
        const ruid = filterRuid ? Number(filterRuid) : null;

        // 读取已存储的记录（先读取，用于增量获取）
        const existingRecords = await readBlindBoxRecords(validSession.mid, validSession.uname, blindBoxId);

        // 获取已存储记录的最新时间戳，用于增量获取
        const latestTimestamp = getLatestTimestamp(existingRecords);

        // 增量获取新记录（离线时跳过，仅用本地缓存）
        const newRecords = offline
          ? []
          : await fetchBlindBoxDrawStream(blindBoxId, biliCookie, latestTimestamp);

        // 合并记录
        const mergedRecords = newRecords.length > 0
          ? [...newRecords, ...existingRecords]
          : existingRecords;

        // 获取盲盒名称（用于文件名）
        let blindBoxNameForFile: string | undefined;
        try {
          const existingInfo = await getBlindBoxInfo(validSession.mid, validSession.uname, blindBoxId);
          blindBoxNameForFile = existingInfo?.blind_box_name;
        } catch { /* ignore */ }

        // 保存（只有有新记录时才保存）
        if (newRecords.length > 0) {
          await saveBlindBoxRecords(validSession.mid, validSession.uname, blindBoxId, mergedRecords, blindBoxNameForFile);
        }

        console.log(`[BlindBoxStats] 盲盒 ${blindBoxId}: 新记录 ${newRecords.length} 条, 已存储 ${existingRecords.length} 条, 合并后 ${mergedRecords.length} 条`);

        // 获取盲盒信息（只在本地没有时才请求API，离线时跳过B站请求）
        let blindBoxInfo = await getBlindBoxInfo(validSession.mid, validSession.uname, blindBoxId);
        if (!blindBoxInfo && !offline) {
          const checkResult = await checkBlindBox(blindBoxId, biliCookie);
          if (checkResult) {
            await saveBlindBoxInfo(session.mid, session.uname, blindBoxId, {
              gift_name: checkResult.blindGiftName,
              gift_img: "",
              price: checkResult.blindPrice,
              gifts: checkResult.gifts,
            });
            blindBoxInfo = await getBlindBoxInfo(validSession.mid, validSession.uname, blindBoxId);
          }
        }

        // 将盲盒内礼物信息保存到 gift-db，供消费记录显示礼物图片
        if (blindBoxInfo?.gifts) {
          await saveGiftsToDb(blindBoxInfo.gifts.map(g => ({
            gift_id: g.gift_id,
            name: g.gift_name,
            img: g.gift_img,
          })));
        }

        // 从全部记录构建元数据
        const dateRange = getDateRange(mergedRecords);
        const anchors = buildAnchorList(mergedRecords);

        // 按筛选条件过滤记录
        const filteredRecords = filterRecords(mergedRecords, ruid, filterDateRange);

        // 计算盈亏
        const entry = blindBoxInfo ? {
          price: blindBoxInfo.blind_price,
          gift_name: blindBoxInfo.blind_box_name,
          gift_img: blindBoxInfo.blind_box_img,
          blind_box_gifts: blindBoxInfo.gifts,
        } : null;
        const profit = calculateProfit(blindBoxId, entry, filteredRecords);

        // 填充元数据
        profit.dateRange = dateRange;
        profit.anchors = anchors;
        profit.filter = { ruid, dateRange: filterDateRange };

        // 计算城堡统计（仅心动盲盒）
        if (blindBoxId === 32251) {
          const { castleStats, castleGift } = calculateCastleStats(mergedRecords, entry);
          profit.castleStats = castleStats;
          profit.castleGift = castleGift;
        }

        results.push(profit);
      } catch (err) {
        console.error(`[BlindBoxStats] 处理盲盒 ${blindBoxId} 失败:`, err);
      }
    }

    return NextResponse.json<ApiResponse<BlindBoxProfitResult[]>>(
      { code: 0, message: "ok", data: results },
      { status: 200 },
    );
  } catch (err) {
    console.error("[BlindBoxStats] 统计失败:", err);
    return NextResponse.json<ApiResponse<null>>(
      { code: 500, message: "统计失败", data: null },
      { status: 500 },
    );
  }
}