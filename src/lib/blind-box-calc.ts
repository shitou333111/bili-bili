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

/**
 * 盲盒额外奖励礼物（成本 0，仅计产出价值）。
 *
 * 奖励礼物有两个互补来源（与合成活动的“合成产物”一致）：
 *  1. 包裹 bag_list —— 已获得但尚未送出的奖励礼物（当前持快照，无时间）；
 *  2. 消费记录 pay-records 中 bag_desc="包裹道具" 的送出记录 —— 已送出的奖励礼物
 *     （送出即离开包裹，故与包裹来源不重复，两者相加 = 全部奖励礼物）。
 *
 * 消费记录来源直接带 ruid/rname/timestamp（按送出时间参与日期筛选）；
 * 包裹来源无主播信息，由 attributeRewardGifts 参考 locked_text 归属。
 */
export type BlindBoxRewardBagGift = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  /** 电池单价 */
  price: number;
  img: string;
  is_locked?: boolean;
  locked_text?: string;
  /** 已带主播（消费记录来源直接给出，包裹来源由 attributeRewardGifts 解析后回填） */
  ruid?: number;
  /** 主播昵称（消费记录来源） */
  rname?: string;
  /** 送出时间（消费记录来源，格式同抽取记录；有值则按日期筛选，包裹来源无值不筛选） */
  timestamp?: string;
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
  /**
   * 该盲盒的额外奖励礼物（已按 admin 配置的奖励礼物名称过滤好，含包裹 + 消费记录两来源）。
   * 成本 0，仅计价值；不计抽数/成本；主播筛选生效；
   * 消费记录来源按 timestamp 参与日期筛选，包裹来源不参与。
   */
  rewardGifts?: BlindBoxRewardBagGift[];
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

/** 主播锁定文本解析（惰性匹配，允许主播昵称中含“的”） */
const REWARD_ANCHOR_MATCHER = /该礼物仅限(.+?)的直播间使用/;

/**
 * 为奖励礼物归属主播（镜像合成活动 calcPayRecordActivityProfit 的包裹补充逻辑）。
 * - 消费记录来源：已带 ruid，直接采用；
 * - 锁定礼物：按 `locked_text` 解析主播名，再映射到记录中的最新 ruid；
 * - 未锁定礼物：盲盒记录无 room_id，退化为「记录仅剩单一 ruid」时归属该主播，否则跳过。
 * 无法归属的礼物保守跳过并记日志。
 */
export function attributeRewardGifts(
  rewardGifts: BlindBoxRewardBagGift[],
  records: BlindBoxCalcRecord[],
  anchorNames?: Record<number, string>,
): Array<BlindBoxRewardBagGift & { ruid: number }> {
  const out: Array<BlindBoxRewardBagGift & { ruid: number }> = [];
  if (rewardGifts.length === 0) return out;

  // 主播昵称 → ruid（取首次出现，与记录顺序无关）
  const nameRuids = new Map<string, number>();
  if (anchorNames) {
    for (const [ruidStr, name] of Object.entries(anchorNames)) {
      const rid = Number(ruidStr);
      if (name && !nameRuids.has(name)) nameRuids.set(name, rid);
    }
  }

  // 记录中的唯一 ruid（未锁定包裹礼物的兜底归属）
  const recordRuids = new Set<number>();
  for (const r of records) recordRuids.add(r.ruid);
  const singleRuid = recordRuids.size === 1 ? Array.from(recordRuids)[0] : undefined;

  for (const g of rewardGifts) {
    let ruid: number | undefined;
    if (g.ruid !== undefined) {
      // 消费记录来源已直接带主播，无需解析
      ruid = g.ruid;
    } else if (g.is_locked) {
      const m = g.locked_text?.match(REWARD_ANCHOR_MATCHER);
      const anchorName = m ? m[1] : "";
      ruid = anchorName ? nameRuids.get(anchorName) : undefined;
    } else {
      ruid = singleRuid;
    }
    if (ruid === undefined) {
      console.log(`[attributeRewardGifts] 无法归属奖励礼物「${g.gift_name}」(locked=${g.is_locked})，已跳过`);
      continue;
    }
    out.push({ ...g, ruid });
  }
  return out;
}

/** admin 配置中的奖励礼物项（EffectiveBlindBoxGift 的结构子集） */
export type RewardGiftConfig = { giftId: number; giftName: string; price: number; img: string };

/** 包裹奖励礼物来源（bag_list 项的结构子集） */
export type RewardBagSource = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  price: number;
  img: string;
  is_locked?: boolean;
  locked_text?: string;
};

/** 消费记录来源（pay-records 项的结构子集） */
export type RewardPayRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  coin?: string;
  pay_coin?: string;
  bag_desc?: string;
  status_msg?: string;
  ruid: number;
  r_uname?: string;
  timestamp: number;
  gift_img?: string;
};

/** unix 秒 → 与盲盒抽取记录一致的本地时间串（"YYYY-MM-DD HH:mm:ss"） */
function formatLocalTs(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 汇总某盲盒的全部奖励礼物（包裹 + 消费记录两来源，互补不重复）。
 * 与合成活动 calcPayRecordActivityProfit 的「产物 = 包裹道具消费记录 + 包裹补充」口径一致：
 * - 包裹 bag_list：已获得未送出（当前持快照）；
 * - 消费记录 pay-records 中 bag_desc="包裹道具" 且礼物名匹配的送出记录（已送出，带主播与时间）。
 * 名称按 admin 配置的奖励礼物名称精确匹配。
 */
export function collectRewardGifts(
  configs: RewardGiftConfig[],
  bagGifts: RewardBagSource[],
  payRecords: RewardPayRecord[],
): BlindBoxRewardBagGift[] {
  const cfgByName = new Map<string, RewardGiftConfig>();
  for (const c of configs) {
    if (c.giftName) cfgByName.set(c.giftName, c);
  }
  const out: BlindBoxRewardBagGift[] = [];
  if (cfgByName.size === 0) return out;

  // 1) 包裹来源：未送出的奖励礼物（价格/图标以实际为准，配置兜底）
  for (const g of bagGifts) {
    const cfg = cfgByName.get(g.gift_name);
    if (!cfg) continue;
    out.push({
      gift_id: g.gift_id || cfg.giftId,
      gift_name: g.gift_name,
      gift_num: g.gift_num,
      price: g.price || cfg.price,
      img: g.img || cfg.img,
      is_locked: g.is_locked,
      locked_text: g.locked_text,
    });
  }

  // 2) 消费记录来源：已送出的奖励礼物（送出即离开包裹，与来源 1 不重复）
  for (const r of payRecords) {
    if (r.status_msg === "已退回") continue;
    if (r.bag_desc !== "包裹道具") continue;
    const cfg = cfgByName.get(r.gift_name);
    if (!cfg) continue;
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, "")) || 0;
    out.push({
      gift_id: r.gift_id || cfg.giftId,
      gift_name: r.gift_name,
      gift_num: r.gift_num,
      price: (r.gift_num > 0 ? Math.round(coins / r.gift_num) : coins) || cfg.price,
      img: r.gift_img || cfg.img,
      ruid: r.ruid,
      rname: r.r_uname,
      timestamp: formatLocalTs(r.timestamp),
    });
  }

  return out;
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

  // ===== 奖励礼物补充（成本 0，仅计价值；来源：包裹 + 消费记录，两者互补不重复） =====
  // 奖励礼物不出现在盲盒抽取记录中：未送出时在包裹，送出后进入消费记录。
  // 不影响 drawCount/totalSpent（成本 0），主播筛选生效；
  // 消费记录来源按送出时间参与日期筛选，包裹来源为当前持快照、不参与日期筛选。
  if (input.rewardGifts && input.rewardGifts.length > 0) {
    const attributed = attributeRewardGifts(input.rewardGifts, records, anchorNames);
    const range = getDateRangeFilter(dateRangeKey);
    const recordGiftIds = new Set(records.map((r) => r.gift_id));
    // 同种奖励礼物聚合（消费记录可能有多条送出记录）
    const rewardStats = new Map<
      string,
      { gift_id: number; name: string; img: string; count: number; totalValue: number }
    >();
    for (const g of attributed) {
      // 重复计数保护：若抽取记录中已含该 gift_id，则奖励补充会重复
      if (g.gift_id > 0 && recordGiftIds.has(g.gift_id)) continue;
      // 主播筛选：奖励礼物归属主播需与当前筛选一致
      if (ruid !== null && g.ruid !== ruid) continue;
      // 消费记录来源按送出时间筛选（包裹来源无 timestamp，恒定计入）
      if (g.timestamp && range) {
        const t = new Date(g.timestamp).getTime();
        if (t < range.start.getTime() || t >= range.end.getTime()) continue;
      }

      const value = g.price * g.gift_num;
      const key = g.gift_id > 0 ? `id_${g.gift_id}` : `name_${g.gift_name}`;
      const cur = rewardStats.get(key);
      if (cur) {
        cur.count += g.gift_num;
        cur.totalValue += value;
        continue;
      }
      rewardStats.set(key, {
        gift_id: g.gift_id,
        name: g.gift_name,
        img: g.img,
        count: g.gift_num,
        totalValue: value,
      });
    }
    for (const s of rewardStats.values()) {
      totalEarned += s.totalValue;
      gifts.push({
        gift_id: s.gift_id,
        gift_name: `${s.name}（奖励）`,
        gift_img: s.img,
        unitPrice: s.count > 0 ? Math.round(s.totalValue / s.count) : 0,
        count: s.count,
        totalValue: s.totalValue,
      });
    }
  }

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