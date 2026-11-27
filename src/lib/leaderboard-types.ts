/**
 * 黑白榜共享类型与纯函数（前后端共用，禁止引入 node 内置模块）
 *
 * 数据流：客户端刷新统计后计算「紧凑绝对值快照」→ POST /api/leaderboard/report
 * → 服务端按卡片/周期覆盖写入 .data/leaderboard → /hbb 公开页只读。
 */

export type LeaderboardTabKey = "blind" | "synthesis";
export type LeaderboardView = "user" | "anchor";
export type LeaderboardPeriodKey = "today" | "lastFriday" | "activity" | "year";
/** 排序口径：绝对盈亏 / 相对收益（收入 ÷ 花费） */
export type LeaderboardSort = "absolute" | "relative";

export type LeaderboardMaxGift = {
  id: number;
  name: string;
  img: string;
  /** 单价（电池） */
  price: number;
  count: number;
};

/** 卡片「最大礼物」：盲盒可爆出 / 合成活动可产出的单价最高礼物（与用户无关） */
export type LeaderboardTopGift = {
  id: number;
  name: string;
  img: string;
  /** 单价（电池） */
  price: number;
};

/** 一个用户在某张卡片、某个周期内的聚合指标（单位：电池） */
export type LeaderboardMetric = {
  /** 抽数（盲盒）/ 合成个数（合成） */
  drawCount: number;
  /** 花费（电池） */
  spent: number;
  /** 产出价值（电池） */
  earned: number;
  /** 盈亏 = earned - spent（电池） */
  profit: number;
  /** 单价最高的礼物；同价取数量多 */
  maxGift: LeaderboardMaxGift | null;
};

export type LeaderboardCardMeta = {
  key: string;
  tab: LeaderboardTabKey;
  title: string;
  icon?: string;
  /** 该卡片的最大礼物（盲盒可爆出 / 合成活动可产出），用于每行固定展示 */
  topGift?: LeaderboardTopGift;
  /** 是否在标题右侧展示「单位电池」备注（仅第一张非心动/幸运盲盒卡） */
  unitNote?: boolean;
  /** true = 不展示最大礼物（如「一年内总合成」无法区分最大礼物） */
  hideTopGift?: boolean;
  /** 「全部盲盒」聚合卡：标题灯泡里展示的参与统计盲盒（admin「盈亏」勾选） */
  boxes?: Array<{ id: number; name: string; icon: string }>;
  views: LeaderboardView[];
  periods: Array<{ key: LeaderboardPeriodKey; label: string }>;
  defaultView: LeaderboardView;
  defaultPeriod: LeaderboardPeriodKey;
};

export type LeaderboardTabMeta = {
  key: LeaderboardTabKey;
  title: string;
  cards: LeaderboardCardMeta[];
};

export type LeaderboardMeta = {
  tabs: LeaderboardTabMeta[];
  /** 最近一个已过去的周五（YYYY-MM-DD），用于页面展示 */
  lastFridayKey: string;
  todayKey: string;
};

export type LeaderboardRow = {
  /** 盈利榜为 1..N；亏损榜为负数（-1 表示亏损最多） */
  rank: number;
  uid: number;
  name: string;
  face?: string;
  metric: LeaderboardMetric;
};

export type LeaderboardRanking = {
  card: string;
  period: LeaderboardPeriodKey;
  view: LeaderboardView;
  /** 本次排序口径 */
  sort: LeaderboardSort;
  summary: LeaderboardMetric & { users: number };
  top: LeaderboardRow[];
  bottom: LeaderboardRow[];
  total: number;
  updatedAt: number;
};

/** 服务端存储的周期指标（额外记录归属日期，用于过期清理） */
export type StoredPeriodMetric = LeaderboardMetric & {
  updatedAt: number;
  /** today / lastFriday 的归属日期键（YYYY-MM-DD） */
  dayKey?: string;
};

export type StoredEntry = {
  uid: number;
  name: string;
  face?: string;
  updatedAt: number;
  periods: Partial<Record<LeaderboardPeriodKey, StoredPeriodMetric>>;
};

export type LeaderboardBoardFile = {
  version: 1;
  card: string;
  view: LeaderboardView;
  updatedAt: number;
  entries: Record<string, StoredEntry>;
};

export type LeaderboardReportCard = {
  card: string;
  periods: Partial<Record<LeaderboardPeriodKey, LeaderboardMetric>>;
};

export type LeaderboardReport = {
  view: LeaderboardView;
  uid: number;
  name: string;
  face?: string;
  cards: LeaderboardReportCard[];
};

export const BLIND_CARD_PREFIX = "blind:";
export const SYN_CARD_PREFIX = "syn:";
export const SYN_YEAR_CARD = "syn-year";
/** 主播盲盒「全部盲盒」聚合卡片（对应软件内盲盒页最下方的全部盲盒盈亏） */
export const ALL_BLIND_CARD = "blind:all";

export const MAX_RANK_ROWS = 20;
/** 页面按需展开时的单次条数 */
export const RANK_PAGE_ROWS = 30;
/** 接口允许返回的单侧最大条数 */
export const MAX_RANK_LIMIT = 300;

export function blindCardKey(id: number): string {
  return `${BLIND_CARD_PREFIX}${id}`;
}

export function synCardKey(id: string): string {
  return `${SYN_CARD_PREFIX}${id}`;
}

export function isPeriodKey(v: unknown): v is LeaderboardPeriodKey {
  return v === "today" || v === "lastFriday" || v === "activity" || v === "year";
}

export function isLeaderboardView(v: unknown): v is LeaderboardView {
  return v === "user" || v === "anchor";
}

export function emptyMetric(): LeaderboardMetric {
  return { drawCount: 0, spent: 0, earned: 0, profit: 0, maxGift: null };
}

function safeInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** 清洗客户端上报的指标：只保留非负整数，盈亏由服务端重算 */
export function normalizeMetric(input: Partial<LeaderboardMetric> | null | undefined): LeaderboardMetric {
  const spent = Math.max(0, safeInt(input?.spent));
  const earned = Math.max(0, safeInt(input?.earned));
  const drawCount = Math.max(0, safeInt(input?.drawCount));
  const mg = input?.maxGift;
  const giftId = safeInt(mg?.id);
  const giftImg = String(mg?.img ?? "").slice(0, 500);
  const giftCount = Math.max(0, safeInt(mg?.count));
  // count=0 也要保留：卡片「最大礼物」未开出时需显示「图标 ×0」
  const maxGift: LeaderboardMaxGift | null =
    mg && (giftCount > 0 || giftId > 0 || giftImg)
      ? {
          id: giftId,
          name: String(mg.name ?? "").slice(0, 40),
          img: giftImg,
          price: Math.max(0, safeInt(mg.price)),
          count: giftCount,
        }
      : null;
  return { drawCount, spent, earned, profit: earned - spent, maxGift };
}

/** 从候选礼物中选出「单价最高，同价取数量多」的一个 */
export function pickMaxGift(
  items: Array<{ id: number; name: string; img: string; price: number; count: number }>,
): LeaderboardMaxGift | null {
  let best: LeaderboardMaxGift | null = null;
  for (const g of items) {
    if (!(g.count > 0)) continue;
    if (!best || g.price > best.price || (g.price === best.price && g.count > best.count)) {
      best = { id: g.id, name: g.name, img: g.img, price: g.price, count: g.count };
    }
  }
  return best;
}

/** 汇总多行指标（用于「全体用户」汇总行） */
export function sumMetrics(metrics: LeaderboardMetric[]): LeaderboardMetric {
  let drawCount = 0;
  let spent = 0;
  let earned = 0;
  // 各行展示的都是「卡片最大礼物」，汇总时按礼物 id 累加数量
  const giftTotals = new Map<number, LeaderboardMaxGift>();
  for (const m of metrics) {
    drawCount += m.drawCount;
    spent += m.spent;
    earned += m.earned;
    if (m.maxGift) {
      const g = m.maxGift;
      const cur = giftTotals.get(g.id);
      if (cur) cur.count += g.count;
      else giftTotals.set(g.id, { ...g });
    }
  }
  let best: LeaderboardMaxGift | null = null;
  for (const g of giftTotals.values()) {
    if (!best || g.price > best.price || (g.price === best.price && g.count > best.count)) {
      best = g;
    }
  }
  return { drawCount, spent, earned, profit: earned - spent, maxGift: best };
}
