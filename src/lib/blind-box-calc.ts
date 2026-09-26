/**
 * 盲盒盈亏计算（零依赖纯函数）
 *
 * 背景：WEB 端切换盲盒筛选（主播/时间段）时，原先每次都请求服务器，
 * 而服务器每次又都要去 B站 拉取增量记录，既无必要又容易触发风控、还卡顿。
 * 解决方式：服务器/客户端在“无筛选”的一次性响应里把原始记录（精简）与元数据
 * 一并带到浏览器，之后浏览器切筛选全部本地重算，0 请求。
 *
 * 本模块即为浏览器侧的重算实现，语义必须与下列“镜像实现”保持一致：
 * - src/app/api/stats/blind-box/route.ts   （WEB 端服务器侧）
 * - src/lib/stats-client.ts 的 fetchBlindBoxStats（Tauri 端本地侧，已改为委托本模块）
 * 修改本文件时请同步检查这两处。
 */

export type BlindBoxCalcRecord = {
  gift_id: number;
  gift_num: number;
  ruid: number;
  timestamp: string;
};

export type BlindBoxGiftMeta = {
  name: string;
  img: string;
  price: number;
};

export type BlindBoxCalcCastleStat = {
  ruid: number;
  rname: string;
  totalCount: number;
  dates: Array<{ date: string; count: number }>;
};

export type BlindBoxCalcResult = {
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
  castleStats: BlindBoxCalcCastleStat[];
  /** 城堡礼物信息 */
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
};

export type BlindBoxCalcFilter = {
  ruid?: number | null;
  dateRange?: string;
};

export type BlindBoxCalcInput = {
  blindBoxId: number;
  /** 该盲盒的全部原始记录（不带筛选） */
  records: BlindBoxCalcRecord[];
  /** ruid → 主播昵称 */
  anchorNames?: Record<number, string>;
  /** gift_id → 礼物名称/图标/单价 */
  giftMeta?: Record<number, BlindBoxGiftMeta>;
  /** 盲盒单价（电池） */
  blindPrice: number;
  blindBoxName: string;
  blindBoxImg: string;
  /** 当前筛选条件（主播 + 时间段） */
  filter?: BlindBoxCalcFilter;
};

/** 心动盲盒 gift_id（含浪漫城堡统计） */
const XINDONG_ID = 32251;
/** 浪漫城堡 gift_id */
const CASTLE_ID = 32132;

function priceOf(giftMeta: Record<number, BlindBoxGiftMeta> | undefined, giftId: number): number {
  return giftMeta?.[giftId]?.price ?? 0;
}

function nameOf(giftMeta: Record<number, BlindBoxGiftMeta> | undefined, giftId: number): string {
  return giftMeta?.[giftId]?.name || `礼物_${giftId}`;
}

function imgOf(giftMeta: Record<number, BlindBoxGiftMeta> | undefined, giftId: number): string {
  return giftMeta?.[giftId]?.img ?? "";
}

function anchorNameOf(anchorNames: Record<number, string> | undefined, ruid: number): string {
  return anchorNames?.[ruid] ?? `用户${ruid}`;
}

// 日期筛选范围
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
  records: BlindBoxCalcRecord[],
  ruid: number | null,
  dateRange: string,
): BlindBoxCalcRecord[] {
  let filtered = records;

  if (ruid !== null) {
    filtered = filtered.filter((r) => r.ruid === ruid);
  }

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
function buildAnchorList(
  records: BlindBoxCalcRecord[],
  anchorNames: Record<number, string> | undefined,
): Array<{ ruid: number; rname: string; count: number }> {
  const map = new Map<number, { rname: string; count: number }>();
  for (const r of records) {
    const existing = map.get(r.ruid) ?? { rname: anchorNameOf(anchorNames, r.ruid), count: 0 };
    existing.count += r.gift_num;
    map.set(r.ruid, existing);
  }
  return Array.from(map.entries())
    .map(([ruid, v]) => ({ ruid, rname: v.rname, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

// 计算时间范围
function getDateRange(records: BlindBoxCalcRecord[]): { start: string; end: string } | null {
  if (records.length === 0) return null;
  let earliest = records[0].timestamp;
  let latest = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp < earliest) earliest = r.timestamp;
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return { start: earliest, end: latest };
}

// 计算城堡统计
function calculateCastleStats(
  records: BlindBoxCalcRecord[],
  anchorNames: Record<number, string> | undefined,
  giftMeta: Record<number, BlindBoxGiftMeta> | undefined,
): { castleStats: BlindBoxCalcCastleStat[]; castleGift: BlindBoxCalcResult["castleGift"] } {
  const castleRecords = records.filter((r) => r.gift_id === CASTLE_ID);
  if (castleRecords.length === 0) {
    return { castleStats: [], castleGift: null };
  }

  const anchorMap = new Map<number, { rname: string; totalCount: number; dates: Map<string, number> }>();

  for (const record of castleRecords) {
    const date = record.timestamp.split(" ")[0];
    let anchor = anchorMap.get(record.ruid);
    if (!anchor) {
      anchor = { rname: anchorNameOf(anchorNames, record.ruid), totalCount: 0, dates: new Map() };
      anchorMap.set(record.ruid, anchor);
    }
    anchor.totalCount += record.gift_num;
    anchor.dates.set(date, (anchor.dates.get(date) ?? 0) + record.gift_num);
  }

  const castleStats: BlindBoxCalcCastleStat[] = Array.from(anchorMap.entries()).map(([ruid, anchor]) => ({
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
    castleGift: {
      gift_id: CASTLE_ID,
      gift_name: nameOf(giftMeta, CASTLE_ID),
      gift_img: imgOf(giftMeta, CASTLE_ID),
      price: priceOf(giftMeta, CASTLE_ID),
    },
  };
}

/**
 * 用“全部原始记录 + 元数据 + 筛选条件”本地重算盲盒盈亏。
 * 语义与 route.ts 的无筛选响应完全一致（除筛选部分外，其余字段均取自全量记录）。
 */
export function computeBlindBoxFromRecords(input: BlindBoxCalcInput): BlindBoxCalcResult {
  const { blindBoxId, records, anchorNames, giftMeta, blindPrice, blindBoxName, blindBoxImg } = input;
  const ruid = input.filter?.ruid ?? null;
  const dateRangeKey = input.filter?.dateRange ?? "all";

  // 主播下拉列表只按日期筛选（不受主播筛选影响）
  const dateOnlyFiltered = filterRecords(records, null, dateRangeKey);
  const anchors = buildAnchorList(dateOnlyFiltered, anchorNames);

  // 按筛选条件过滤记录（含主播筛选，用于盈亏明细）
  const filteredRecords = filterRecords(records, ruid, dateRangeKey);

  // 统计每种爆出礼物的数量和价值
  const giftStats = new Map<number, { count: number; totalValue: number }>();
  let totalEarned = 0;
  let drawCount = 0;

  for (const record of filteredRecords) {
    const existing = giftStats.get(record.gift_id) ?? { count: 0, totalValue: 0 };
    const giftPrice = priceOf(giftMeta, record.gift_id);
    existing.count += record.gift_num;
    existing.totalValue += giftPrice * record.gift_num;
    giftStats.set(record.gift_id, existing);
    totalEarned += giftPrice * record.gift_num;
    drawCount += record.gift_num;
  }

  const totalSpent = drawCount * blindPrice;

  const gifts = Array.from(giftStats.entries()).map(([giftId, stats]) => ({
    gift_id: giftId,
    gift_name: nameOf(giftMeta, giftId),
    gift_img: imgOf(giftMeta, giftId),
    unitPrice: priceOf(giftMeta, giftId),
    count: stats.count,
    totalValue: stats.totalValue,
  }));

  let castleStats: BlindBoxCalcCastleStat[] = [];
  let castleGift: BlindBoxCalcResult["castleGift"] = null;
  if (blindBoxId === XINDONG_ID) {
    const castle = calculateCastleStats(records, anchorNames, giftMeta);
    castleStats = castle.castleStats;
    castleGift = castle.castleGift;
  }

  return {
    blindBoxId,
    blindBoxName,
    blindBoxImg,
    blindPrice,
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    recordCount: filteredRecords.length,
    dateRange: getDateRange(records),
    anchors,
    filter: { ruid, dateRange: dateRangeKey },
    gifts,
    castleStats,
    castleGift,
  };
}