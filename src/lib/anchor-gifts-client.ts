/**
 * Tauri 客户端 - 主播礼物数据获取
 *
 * 在 Tauri 环境下，直接调用 B站 API（通过平台层解决 CORS），
 * 数据存储在本地文件系统，并复刻服务器 /api/anchor/gifts 的完整统计逻辑
 * （giftSummary / fanDistribution / monthlyData / otherStats / blindBoxProfits 及 dateRange/fan 过滤）。
 *
 * 逻辑与 src/app/api/anchor/gifts/route.ts 对应，但运行在客户端。
 */

import type { Platform } from "./platform/types";
import type { AuthSession } from "./auth/session";
import { BLIND_BOX_CONFIG } from "./config";
import { ensureGiftCatalogLoaded, getGiftImg } from "./gift-catalog-client";
import {
  resolveSession,
  buildCookie,
  getEffectiveBlindBoxConfig,
  getAllBlindBoxInfo,
  saveBlindBoxInfo,
  checkBlindBox,
  type BlindBoxInfo,
  type BlindBoxGift,
  type EffectiveBlindBoxConfig,
} from "./stats-client";
import {
  ensureValidCredentialClient,
  extractCookieValue,
} from "./bilibili/cookie-refresh-client";

// B站 礼物流水接口每页返回条数（客户端不传 page_size，使用 B站 默认 50）
const PAGE_SIZE = 50;

// ==================== 类型定义（与 API route 保持一致） ====================

type BiliGiftRecord = {
  uid: number;
  uname: string;
  time: string;
  goods_id: number;
  gift_id: number;
  name: string;
  num: number;
  hamster: number;
  receive_title: string;
  room_id: number;
};

type BiliGiftStreamResponse = {
  code: number;
  message: string;
  data?: {
    ready: number;
    total_page: number;
    total_count: number;
    total_hamster: number;
    list: BiliGiftRecord[];
  };
};

type RecordsMetaData = {
  end_date?: string;
  last_fetch?: string;
  total_page?: number;
  /** 可疑空月份及"被判定为空"的次数，用于下轮补拉；达到上限则视为真无数据，防死循环 */
  empty_counts?: Record<string, number>;
};

export type AnchorGiftsResult = {
  totalHamster: number;
  totalRmb: number;
  totalCount: number;
  totalPage: number;
  giftTypes: number;
  fanCount: number;
  monthlyData: Array<{ month: string; hamster: number; count: number }>;
  fanDistribution: Array<{ uid: number; uname: string; hamster: number; giftCount: number }>;
  giftSummary: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }>;
  dateRange: { start: string; end: string } | null;
  blindBoxProfit: unknown;
  blindBoxProfits: unknown[];
  otherStats: {
    dayStats: { totalDays: number; maxConsecutiveDays: number };
    fanStats: Array<{
      uid: number;
      uname: string;
      totalDays: number;
      maxConsecutiveDays: number;
      consecutiveStart: string;
      consecutiveEnd: string;
    }>;
  };
  records: BiliGiftRecord[];
  filter: { dateRange: string; fan: string };
  metadata: RecordsMetaData | null;
  fetchedNewPages: number;
  yesterdayAvailable: boolean;
};

// ==================== 常量 ====================

// 正常翻页之间的请求间隔；B 站反爬阈值实测 ~ 1 次/秒，400ms 留有余量
const REQUEST_INTERVAL_MS = 0;
// 遇到 412 限流冷却后恢复阶段的请求间隔（更保守）
const SLOW_REQUEST_INTERVAL_MS = 1500;
const PAGE_RETRY_COUNT = 3;
const PAGE0_RETRY_COUNT = 5;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
// 月度并行度：1=串行，>1 时批内多个月份并行拉取（注意：多个月同时翻页会增加 412 限流风险）
const MONTH_CONCURRENCY = 12;
const CONSECUTIVE_MATCH_THRESHOLD = 5;

// 伪空重试间隔：page0 返回 total_page=0 时，按这些递增间隔再查，
// 区分"软限流/冷缓存的假空"与"真无数据"
const EMPTY_RETRY_INTERVAL_MS = [5000, 15000];
// 可疑空月份连续判定上限：同一空月份连续 N 次运行仍为空 → 视为真无数据并放行 end_date（防死循环）
const MAX_CONSECUTIVE_EMPTY_RUNS = 2;

const GIFT_STREAM_API = "https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getReceivedGiftStream";

/**
 * 动态并发池：同时最多跑 concurrency 个任务，任一任务完成即启动下一个任务，
 * 让并发槽位始终饱和（替代"批式并行"——批内完成后才开下一批，存在空闲等待）。
 * 结果按下标顺序返回，供调用方按原顺序处理。
 * onTaskDone：每个任务完成时立即回调（index, item, result），用于拉取过程中的实时进度上报。
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onTaskDone?: (index: number, item: T, result: R) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
      onTaskDone?.(i, items[i], results[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ==================== 日期工具 ====================

function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

function getYesterdayStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + 8 * 3600000);
  beijing.setDate(beijing.getDate() - 1);
  const y = beijing.getFullYear();
  const m = String(beijing.getMonth() + 1).padStart(2, "0");
  const d = String(beijing.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function getDatePart(time: string): string {
  return time.split(" ")[0];
}

/** YYYYMMDD -> Date（北京时间） */
function parseDateStr(s: string): Date {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m, d));
}

/** Date -> YYYYMMDD（北京时间） */
function formatDate(d: Date): string {
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + 8 * 3600000);
  const y = beijing.getFullYear();
  const m = String(beijing.getMonth() + 1).padStart(2, "0");
  const day = String(beijing.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 计算最长连续天数 */
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

/** 日期范围过滤 */
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
      return null;
  }
}

/**
 * 按自然月边界分割日期范围（B站 API 不支持跨自然月查询）
 */
function generateMonthChunks(begin: string, end: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  const by = Number(begin.slice(0, 4));
  const bm = Number(begin.slice(4, 6));
  const bd = Number(begin.slice(6, 8));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(4, 6));
  const ed = Number(end.slice(6, 8));

  let y = by, m = bm;
  let isFirst = true;
  while (y < ey || (y === ey && m <= em)) {
    const startDay = isFirst ? String(bd).padStart(2, "0") : "01";
    const start = `${y}${String(m).padStart(2, "0")}${startDay}`;
    isFirst = false;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let endDay: string;
    if (y === ey && m === em) {
      endDay = String(ed).padStart(2, "0");
    } else {
      endDay = String(lastDay).padStart(2, "0");
    }
    const endStr = `${y}${String(m).padStart(2, "0")}${endDay}`;
    chunks.push({ start, end: endStr });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return chunks;
}

// ==================== 记录 key ====================

function recordKey(r: BiliGiftRecord): string {
  return `${r.time}_${r.uid}_${r.gift_id}_${r.num}`;
}

function buildRecordKeyCounter(records: BiliGiftRecord[]): Map<string, number> {
  const counter = new Map<string, number>();
  for (const r of records) {
    const key = recordKey(r);
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }
  return counter;
}

// ==================== 存储 ====================

async function userDataDir(platform: Platform, mid: number): Promise<string> {
  return `${await platform.getDataDir()}/uid_${mid}`;
}

async function readJson<T>(platform: Platform, filePath: string): Promise<T | null> {
  try {
    if (!(await platform.exists(filePath))) return null;
    const raw = await platform.readFile(filePath);
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readRecordsWithMeta(
  platform: Platform,
  mid: number,
): Promise<{ records: BiliGiftRecord[]; meta: RecordsMetaData | null }> {
  const dir = await userDataDir(platform, mid);
  const filePath = `${dir}/anchor-gifts-records.json`;
  const parsed = await readJson<unknown>(platform, filePath);
  if (!parsed) return { records: [], meta: null };
  if (Array.isArray(parsed)) return { records: parsed as BiliGiftRecord[], meta: null };
  const obj = parsed as { records?: BiliGiftRecord[]; end_date?: string; last_fetch?: string; total_page?: number; empty_counts?: Record<string, number> };
  return {
    records: obj.records ?? [],
    meta: obj.end_date !== undefined
      ? { end_date: obj.end_date, last_fetch: obj.last_fetch, total_page: obj.total_page, empty_counts: obj.empty_counts ?? {} }
      : null,
  };
}

async function saveRecordsWithMeta(
  platform: Platform,
  mid: number,
  records: BiliGiftRecord[],
  meta: RecordsMetaData,
): Promise<void> {
  const dir = await userDataDir(platform, mid);
  await platform.mkdir(dir);
  const filePath = `${dir}/anchor-gifts-records.json`;
  await platform.writeFile(
    filePath,
    JSON.stringify(
      {
        last_fetch: meta.last_fetch ?? getBeijingTime(),
        end_date: meta.end_date,
        // total_page 由存储记录数确定性推导：旧逻辑"每次刷新累加 fetchedNewPages"
        // 即使无新数据也会让 total_page 持续增长（fetchedNewPages≈有数据的月份数），
        // 导致文件每次刷新都变 → 增量上传失效、几十 MB 全量重传。
        total_page: Math.ceil(records.length / PAGE_SIZE),
        total_count: records.length,
        empty_counts: meta.empty_counts ?? {},
        records,
      },
      null,
      2,
    ),
  );
}

// ==================== API 调用 ====================

async function fetchGiftStreamPage(
  platform: Platform,
  cookie: string,
  csrf: string,
  page: number,
  beginDate: string,
  endDate: string,
  buvidCookie?: string,
): Promise<BiliGiftStreamResponse> {
  const body = [
    `page=${page}`,
    `gift_id=0`,
    `begin_date=${beginDate}`,
    `end_date=${endDate}`,
    `uname=`,
    `goods_id=`,
    `csrf_token=${csrf}`,
    `csrf=${csrf}`,
  ].join("&");

  const fullCookie = buvidCookie ? `${cookie};${buvidCookie}` : cookie;

  if (page === 0) {
    console.log(`[AnchorGifts-Tauri][API] 请求 page=0 begin=${beginDate} end=${endDate}`);
  }

  const t0 = performance.now();
  try {
    const result = await platform.fetchBilibiliJson<BiliGiftStreamResponse>({
      url: GIFT_STREAM_API,
      method: "POST",
      body,
      cookie: fullCookie,
      live: true,
    });
    const elapsed = Math.round(performance.now() - t0);
    console.log(`[AnchorGifts-Tauri][API] page=${page} 耗时=${elapsed}ms`);
    if (page === 0) {
      console.log(
        `[AnchorGifts-Tauri][API] 响应 page=0: code=${result.code} total_page=${result.data?.total_page ?? -1} total_count=${result.data?.total_count ?? -1} list_len=${result.data?.list?.length ?? 0}`,
      );
    }
    return result;
  } catch (err: any) {
    // 412 限流：包装错误信息，供上层识别
    if (err?.message?.includes("412")) {
      throw new Error("412 限流");
    }
    throw err;
  }
}

// ==================== 盲盒统计（对应服务器 route 的盲盒盈亏） ====================

type BlindBoxProfit = {
  gift_id: number;
  name: string;
  drawCount: number;
  totalHamster: number;
  cost: number;
  profit: number;
  gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }>;
  img: string;
  blindPrice: number;
  anchors: Array<{ ruid: number; rname: string; count: number }>;
  dateRange: { start: string; end: string } | null;
};

/**
 * 主导出：主播礼物数据
 * @param refresh 是否强制刷新
 * @param dateRange 日期范围过滤（all/today/yesterday/thisWeek/thisMonth）
 * @param fan 粉丝 uid 过滤（逗号分隔）
 */
/** 获取进度回调：用于首屏/刷新时按月份显示进度条 */
export type FetchProgressHandler = (p: {
  text: string;
  ratio?: number;
  current?: number;
  total?: number;
}) => void;

// 模块级防重入锁：不依赖组件 ref，HMR 重挂载也不会失效
let _fetchingGlobal = false;
let _fetchingGlobalAt = 0;
// 锁超时（5分钟）：防止 HMR 或异常导致锁永久卡死
const _FETCHING_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
// 锁等待检查间隔和最大等待时间（与超时一致）
const _LOCK_POLL_MS = 500;

// 调试用：在 window 上暴露强制释放锁的方法
if (typeof window !== "undefined") {
  (window as any).__resetAnchorGiftsLock = () => {
    _fetchingGlobal = false;
    console.log("[AnchorGifts] 锁已强制释放");
  };
}

/** 等待锁释放/超时后，抢占锁。返回 true 表示获取到锁。 */
async function acquireLock(): Promise<boolean> {
  const startWait = Date.now();
  while (_fetchingGlobal && Date.now() - _fetchingGlobalAt < _FETCHING_LOCK_TIMEOUT_MS) {
    // 防止无限等待：最多等一个锁超时周期
    if (Date.now() - startWait >= _FETCHING_LOCK_TIMEOUT_MS) break;
    await new Promise((r) => setTimeout(r, _LOCK_POLL_MS));
  }
  // 到这里要么 _fetchingGlobal=false（被释放），要么超时已过期：直接抢占
  if (_fetchingGlobal) {
    console.warn("[AnchorGifts] 等待锁超时后强制抢占释放（上次锁于 "
      + new Date(_fetchingGlobalAt).toLocaleTimeString("zh-CN") + "）");
  } else if (Date.now() - startWait > 500) {
    console.log(`[AnchorGifts] 锁等待完成，等待 ${Date.now() - startWait}ms 后获取`);
  }
  _fetchingGlobal = true;
  _fetchingGlobalAt = Date.now();
  return true;
}

export async function fetchAnchorGifts(
  platform: Platform,
  opts: { refresh?: boolean; dateRange?: string; fan?: string; onProgress?: FetchProgressHandler } = {},
): Promise<{ code: number; message: string; data?: AnchorGiftsResult | null }> {
  const ok = await acquireLock();
  if (!ok) {
    return { code: -1, message: "already fetching", data: null };
  }

  try {
  const { refresh = false, dateRange = "all", fan = "", onProgress } = opts;

  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }

  // 客户端凭证验证与自动刷新（仅非 server 账号有 B站 Cookie）
  // SESSDATA 失效时用 refresh_token 自动刷新，避免频繁要求重新登录
  let cookie = buildCookie(session);
  let csrf = cookie.match(/bili_jct=([a-f0-9]+)/)?.[1] || "";

  if (session.source !== "server") {
    const credResult = await ensureValidCredentialClient(platform, session);
    if (!credResult.valid) {
      console.warn("[AnchorGifts-Tauri] 凭证失效且刷新失败，需重新登录:", credResult.reason);
      return { code: 0, message: "needs-relogin", data: null };
    }
    cookie = credResult.cookie;
    csrf = credResult.session.biliCookies
      ? extractCookieValue(credResult.session.biliCookies, "bili_jct")
      : "";
  }

  try {
    await ensureGiftCatalogLoaded(platform);
    const { records: existingRecords, meta } = await readRecordsWithMeta(platform, session.mid);
    let allRecords = existingRecords;
    let fetchedNewPages = 0;

    const yesterdayStr = getYesterdayStr();

    // 昨日可用性：以 B站 API 返回的 ready 标识为准（ready=1 表示昨日数据已汇总完成，
    // 即使昨日无收礼记录也应可点击；ready=0 表示官方尚未更新，需置灰）。
    // 无 API 返回（source=server / 离线 / 未拉取到昨日分段）时回退到本地记录判断。
    let yesterdayApiReady: boolean | null = null;

    const startDate = (() => {
      // 与服务器 route 保持一致：只用 end_date 决定起始日期。
      // - end_date 非空 → 从 end_date 开始增量获取
      // - end_date 为空但已有本地记录（旧缓存）→ 从已有记录最新时间开始增量获取，
      //   避免每次全量拉取 3 年数据
      // - 两者皆无 → 首次使用，从3年前下个月开始
      // refresh=true 只是代表用户手动触发，不影响起始日期判断
      if (meta?.end_date) {
        // ===== 保底：end_date 已推进至近期但 records 为空 → 视为被错误推进，回退全量 =====
        // 典型场景：首次打开时网络/412 导致 page 0 失败被旧代码当成"无数据"跳过，
        // end_date 被错误写入"昨天"。即使现在网络已恢复，按 meta.end_date=昨天 只会拉 1-2 天，
        // 永远拿不到 3 年历史。
        // 判据：本地一条记录都没有（从来没成功获取过）且 end_date 距离昨天 ≤ 30 天
        // （已经推到"最新"），则放弃 end_date，从 3 年前重新全量。
        // 对于真·3年无任何礼物的极小号：无非多跑一次全部月份的 total_page=0，
        // 耗时很小，正确性无损。
        if (existingRecords.length === 0) {
          try {
            const endD = parseDateStr(meta.end_date);
            const yesD = parseDateStr(yesterdayStr);
            const diffDays = Math.round((yesD.getTime() - endD.getTime()) / 86400000);
            if (diffDays >= 0 && diffDays <= 30) {
              console.warn(`[AnchorGifts-Tauri] 保底回退：end_date=${meta.end_date}(距昨天${diffDays}天)但现有0条记录，视为被错误推进，改为从3年前全量拉取`);
              // 直接复用下面首次使用的 3年前计算（展开代码避免重复）
              const now = new Date();
              const utc = now.getTime() + now.getTimezoneOffset() * 60000;
              const beijing = new Date(utc + 8 * 3600000);
              const startYear = beijing.getFullYear() - 3;
              const startMonth = beijing.getMonth() + 1;
              const beginYear = startMonth === 12 ? startYear + 1 : startYear;
              const beginMonth = startMonth === 12 ? 1 : startMonth + 1;
              return `${beginYear}${String(beginMonth).padStart(2, "0")}01`;
            }
          } catch { /* parseDateStr 异常则不回退，走原逻辑 */ }
        }
        return meta.end_date;
      }
      if (existingRecords.length > 0) {
        let maxTime = existingRecords[0].time;
        for (const r of existingRecords) {
          if (r.time > maxTime) maxTime = r.time;
        }
        // "YYYY-MM-DD HH:mm:ss" -> YYYYMMDD
        return maxTime.slice(0, 10).replace(/-/g, "");
      }
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const beijing = new Date(utc + 8 * 3600000);
      const startYear = beijing.getFullYear() - 3;
      const startMonth = beijing.getMonth() + 1;
      const beginYear = startMonth === 12 ? startYear + 1 : startYear;
      const beginMonth = startMonth === 12 ? 1 : startMonth + 1;
      return `${beginYear}${String(beginMonth).padStart(2, "0")}01`;
    })();

    // 纯服务器收集账号（source=server）无 B站 Cookie，无法从 B站 拉取增量，
    // 直接基于已从自建服务器拉取到本地的 anchor-gifts-records.json 计算统计。
    if (session.source !== "server" && startDate <= yesterdayStr) {
      const buvidCookie = await platform.getBuvidCookie().catch(() => "");
      const chunks = generateMonthChunks(startDate, yesterdayStr);
      console.log(`[AnchorGifts-Tauri] 获取数据: ${startDate} ~ ${yesterdayStr}, ${chunks.length}个月, 并发度=${MONTH_CONCURRENCY}`);

      const existingKeyCounter = existingRecords.length > 0 ? buildRecordKeyCounter(existingRecords) : undefined;

      // 进度分母 = 首个有数据月份 → 当前时间 的月数（一开始探测出来后就固定），
      // 而非全部 36 个自然月，也不是边获取边增长的探测值。
      // page0 探测（36 个月各 1 个请求，很快）全部完成后，
      // 用首个有数据月份下标 firstDataIndex 确定最终分母 totalValidMonths，之后不再变化。
      let probedCount = 0;
      let firstDataIndex = -1; // 按时间顺序第一个有数据的月份下标
      let totalValidMonths = -1; // 固定分母；-1 表示探测未完成
      let validDone = 0; // 已完成全部翻页的有效月份数
      const probeMonthHasData = (index: number, hasData: boolean) => {
        probedCount++;
        if (hasData && (firstDataIndex === -1 || index < firstDataIndex)) firstDataIndex = index;
        if (probedCount >= chunks.length) {
          totalValidMonths = firstDataIndex === -1 ? 0 : chunks.length - firstDataIndex;
        }
      };

      // 单个月份 chunk 处理：拉取该月所有页，返回结果（不修改全局状态，并行安全）
      async function processChunk(
        chunk: { start: string; end: string },
        index: number,
      ): Promise<{
        records: BiliGiftRecord[];
        totalPages: number;
        hasData: boolean;
        yesterdayReady?: boolean;
        interrupted: boolean;
        page0Failed: boolean;
        /** 本次判定为"可疑空月份"（伪空重试后仍 total_page=0） */
        empty?: boolean;
        /** B站凭证失效（code=-101/3/"未登录"）：与 page0Failed 不同，需要立即终止整个 fetchAnchorGifts 并让上层跳 /login */
        credentialExpired?: boolean;
      }> {
        const records: BiliGiftRecord[] = [];
        let rateLimited = false;

        // 第0页
        let firstPage: BiliGiftStreamResponse | null = null;
        for (let attempt = 0; attempt <= PAGE0_RETRY_COUNT; attempt++) {
          try {
            const result = await fetchGiftStreamPage(platform, cookie, csrf, 0, chunk.start, chunk.end, buvidCookie);
            if (result.code === 0) {
              firstPage = result;
              break;
            }
            // B站 SESSDATA 失效：立即标记 credentialExpired 退出循环，不再重试（重试只会拿到同样的 -101）
            if (result.code === -101 || result.code === 3 || (result.message && result.message.includes("未登录"))) {
              console.warn(`[AnchorGifts-Tauri] B站凭证失效（code=${result.code}），需重新登录`);
              return { records, totalPages: 0, hasData: false, interrupted: false, page0Failed: false, credentialExpired: true };
            }
            if (result.code === 1301000) {
              console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 数据已过期，跳过`);
              // 关键修复：1301000 是 B站 的正常响应（该月数据已过期），必须赋值 firstPage，
              // 否则下方 !firstPage 会把该月误判为 page0Failed，导致 end_date 被推进并永久跳过该月及更早的历史数据。
              firstPage = result;
              break;
            }
            await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          } catch (err: any) {
            if (err?.message?.includes("412")) {
              rateLimited = true;
              await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
            } else {
              await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
            }
          }
        }

        // page 0 所有重试均失败（网络错误、412 限流持续等）：
        // 必须标记 page0Failed，否则上层会当作"正常无数据"推进 end_date，
        // 导致该月及更早的历史数据被永久跳过。
        if (!firstPage) {
          console.warn(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} page 0 获取完全失败，标记为 page0Failed`);
          return { records, totalPages: 0, hasData: false, interrupted: false, page0Failed: true };
        }
        // 探测：page0 确定该月是否有数据（1301000 数据过期也属无数据）。
        // 所有月份探测完成后，用首个有数据月份固定进度分母。
        probeMonthHasData(index, firstPage.code === 0 && (firstPage.data?.total_page ?? 0) > 0);
        // code=1301000 表示该月数据已过期，属于 B站正常响应，不是失败
        if (firstPage.code === 1301000) {
          return { records, totalPages: 0, hasData: false, interrupted: false, page0Failed: false };
        }

        let yesterdayReady: boolean | undefined;
        if (chunk.end === yesterdayStr && firstPage.data) {
          yesterdayReady = firstPage.data.ready === 1;
        }

        let totalPages = firstPage.data?.total_page ?? 0;
        // total_page=0 不一定代表该月无数据：B站 在软限流/冷缓存时静默返回假空（非错误、不重试）。
        // 按递增间隔再探测：恢复出数据 → 视为假空继续翻页；仍为 0 → 判定"可疑空月份"，交给上层用 empty_counts 决定是否补拉。
        if (totalPages === 0) {
          for (const delay of EMPTY_RETRY_INTERVAL_MS) {
            await new Promise((r) => setTimeout(r, delay));
            try {
              const retried = await fetchGiftStreamPage(platform, cookie, csrf, 0, chunk.start, chunk.end, buvidCookie);
              if (retried.code === 0 && (retried.data?.total_page ?? 0) > 0) {
                firstPage = retried;
                totalPages = firstPage.data?.total_page ?? 0;
                console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 伪空重试恢复：total_page=${totalPages}，继续`);
                break;
              }
            } catch { /* 重试失败则继续等下一个间隔 */ }
          }
          if (totalPages === 0) {
            console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 可疑空月份：重试后仍 total_page=0（标记 empty）`);
            return { records, totalPages: 0, hasData: false, yesterdayReady, interrupted: false, page0Failed: false, empty: true };
          }
        }

        if (firstPage.data?.list?.length) {
          records.push(...firstPage.data.list);
        }

        // 翻页
        let interrupted = false;
        for (let p = 1; p < totalPages; p++) {
          if (existingKeyCounter && records.length >= CONSECUTIVE_MATCH_THRESHOLD) {
            const lastN = records.slice(-CONSECUTIVE_MATCH_THRESHOLD);
            const allMatch = lastN.every((r) => {
              const key = recordKey(r);
              return (existingKeyCounter.get(key) ?? 0) > 0;
            });
            if (allMatch) break;
          }

          const interval = rateLimited ? SLOW_REQUEST_INTERVAL_MS : REQUEST_INTERVAL_MS;
          await new Promise((r) => setTimeout(r, interval));

          let success = false;
          for (let attempt = 0; attempt <= PAGE_RETRY_COUNT; attempt++) {
            try {
              const result = await fetchGiftStreamPage(platform, cookie, csrf, p, chunk.start, chunk.end, buvidCookie);
              if (result.code === 0 && result.data?.list) {
                records.push(...result.data.list);
                success = true;
                break;
              }
            } catch (err: any) {
              if (err?.message?.includes("412")) {
                rateLimited = true;
                await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS + attempt * 5000));
              } else {
                await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
              }
            }
          }
          if (!success) {
            interrupted = true;
            break;
          }
        }

        return { records, totalPages, hasData: true, yesterdayReady, interrupted, page0Failed: false };
      }

      // 动态并发池：任一任务完成即启动下一个任务，让并发槽位始终饱和
      // （原批式并行需等整批 10 个全部完成才开下一批，存在空闲等待）。
      // onTaskDone：每个月份 chunk 完成时立即上报进度（拉取过程中动态更新进度条），
      // 而不是等全部完成后再一次性上报。
      const chunkResults = await runWithConcurrency(
        chunks.map((chunk, index) => ({ chunk, index })),
        MONTH_CONCURRENCY,
        ({ chunk, index }) => processChunk(chunk, index),
        (i, item, result) => {
          if (!result.hasData) {
            onProgress?.({ text: "正在探测收益记录起始月份...", current: 0, total: 0 });
            return;
          }
          validDone++;
          // 探测尚未完成（极端情况，通常 page0 探测先于翻页完成）时维持"探测中"，
          // 避免分母漂移；探测完成后分母固定为 totalValidMonths。
          if (totalValidMonths < 0) {
            onProgress?.({ text: "正在探测收益记录起始月份...", current: 0, total: 0 });
            return;
          }
          onProgress?.({
            text: `正在获取收益记录 ${item.chunk.start.slice(0, 6)}（${validDone}/${totalValidMonths}）`,
            ratio: validDone / totalValidMonths,
            current: validDone,
            total: totalValidMonths,
          });
        },
      );

      // 结果按月份顺序串行处理（去重/中断逻辑依赖有序结果，且避免竞态）。
      // 进度已在 onTaskDone 实时上报，此处不再重复上报。
      let interrupted = false;
      for (let ci = 0; ci < chunkResults.length && !interrupted; ci++) {
        const chunk = chunks[ci];
        const result = chunkResults[ci];

          if (result.yesterdayReady !== undefined) {
            yesterdayApiReady = result.yesterdayReady;
          }

          // B站凭证失效（code=-101/3）：立即返回 needs-relogin，让上层（page.tsx finishRefresh）
          // 调 handleAuthExpired 跳 /login。不保存任何 end_date，下次重新拉取。
          // 外层 finally 会自动释放 _fetchingGlobal 锁，不需要手动释放
          if (result.credentialExpired) {
            return { code: 0, message: "needs-relogin", data: null };
          }

          // page 0 完全失败：不应推进 end_date 到昨天，否则该月及更早的历史数据
          // 将被永久跳过。保存当前已获取的记录，end_date 设为失败月份的起始日期，
          // 下次从该月重新拉取。
          if (result.page0Failed) {
            console.warn(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} page0Failed，保存 end_date=${chunk.start} 并中断`);
            const allSorted = allRecords.sort((a, b) => b.time.localeCompare(a.time));
            await saveRecordsWithMeta(platform, session.mid, allSorted, {
              end_date: chunk.start,
              total_page: (meta?.total_page ?? 0) + fetchedNewPages,
              last_fetch: getBeijingTime(),
              empty_counts: meta?.empty_counts ?? {},
            });
            interrupted = true;
            break;
          }

          if (!result.hasData) {
            continue;
          }

          // 去重并合并（串行，避免竞态）
          for (const r of result.records) {
            if (existingKeyCounter) {
              const key = recordKey(r);
              const existingCount = existingKeyCounter.get(key) ?? 0;
              if (existingCount > 0) {
                existingKeyCounter.set(key, existingCount - 1);
                continue;
              }
            }
            allRecords.push(r);
          }
          fetchedNewPages += Math.min(result.records.length > 0 ? 1 : 0, result.totalPages);

          if (result.interrupted) {
            const allSorted = allRecords.sort((a, b) => b.time.localeCompare(a.time));
            await saveRecordsWithMeta(platform, session.mid, allSorted, {
              end_date: chunk.start,
              total_page: (meta?.total_page ?? 0) + fetchedNewPages,
              last_fetch: getBeijingTime(),
              empty_counts: meta?.empty_counts ?? {},
            });
            interrupted = true;
            break;
          }
      }

      // 仅当未发生中断/失败时才推进 end_date 到昨天。
      // 若 interrupted=true，上面已在中断点保存了 end_date=chunk.start，此处不可覆盖。
      if (!interrupted) {
        // empty_counts：有数据的月份清零，可疑空月份累加；只有仍低于上限的空月份才挡住 end_date（供下轮补拉），
        // 达到上限视为真无数据放行，避免 end_date 永不推进导致死循环。
        const nextEmptyCounts: Record<string, number> = { ...(meta?.empty_counts ?? {}) };
        for (let ci = 0; ci < chunkResults.length; ci++) {
          const result = chunkResults[ci];
          const start = chunks[ci]?.start;
          if (!result || !start) continue;
          if (result.empty) {
            nextEmptyCounts[start] = (nextEmptyCounts[start] ?? 0) + 1;
          } else if (result.records.length > 0) {
            delete nextEmptyCounts[start];
          }
        }
        const suspiciousEmptyStarts = chunks
          .map((c) => c.start)
          .filter((s) => s && (nextEmptyCounts[s] ?? 0) < MAX_CONSECUTIVE_EMPTY_RUNS);
        const nextEndDate = suspiciousEmptyStarts.length > 0
          ? suspiciousEmptyStarts.sort()[0]
          : yesterdayStr;

        allRecords = allRecords.sort((a, b) => b.time.localeCompare(a.time));
        await saveRecordsWithMeta(platform, session.mid, allRecords, {
          end_date: nextEndDate,
          total_page: (meta?.total_page ?? 0) + fetchedNewPages,
          last_fetch: getBeijingTime(),
          empty_counts: nextEmptyCounts,
        });
        if (suspiciousEmptyStarts.length > 0) {
          console.log(`[AnchorGifts-Tauri] 获取完成: end_date 保留在最早可疑空月份 ${nextEndDate}（共${suspiciousEmptyStarts.length}个待补拉），总计 ${allRecords.length} 条`);
        } else {
          console.log(`[AnchorGifts-Tauri] 获取完成: 推进到昨天，总计 ${allRecords.length} 条`);
        }
      }
    }

    // ==================== 统计 ====================

    const dateFilter = getDateRangeFilter(dateRange);
    const fanUids = fan
      ? fan.split(",").map((s) => Number(s.trim())).filter((n) => !isNaN(n))
      : [];

    const filteredRecords = allRecords.filter((r) => {
      if (dateFilter) {
        const t = new Date(r.time).getTime();
        if (t < dateFilter.start.getTime() || t >= dateFilter.end.getTime()) return false;
      }
      if (fanUids.length > 0 && !fanUids.includes(r.uid)) return false;
      return true;
    });

    // 礼物汇总 / 粉丝分布 / 月度汇总 / 日期集合
    const giftMap = new Map<number, { name: string; num: number; hamster: number }>();
    const fanMap = new Map<number, { uname: string; hamster: number; giftCount: number; dateSet: Set<string> }>();
    const monthlyMap = new Map<string, { hamster: number; count: number }>();
    const dateSet = new Set<string>();
    let totalHamster = 0;

    // 盲盒统计
    const blindBoxCountMap = new Map<number, { num: number; hamster: number }>();
    const blindBoxGiftCountMap = new Map<number, Map<number, { name: string; num: number; hamster: number }>>();
    const blindBoxFanMap = new Map<number, Map<number, { uname: string; count: number }>>();
    const blindBoxDateSet = new Map<number, Set<string>>();

    // 盲盒配置与反向映射
    const blindBoxConfig: EffectiveBlindBoxConfig = await getEffectiveBlindBoxConfig(platform);
    const blindBoxIds = blindBoxConfig.current_activity_blind_box_ids ?? [];
    const allBlindBoxInfo = await getAllBlindBoxInfo(platform);

    // 本地没有或信息异常（名称兜底为"盲盒_<id>"、单价<=0、礼物列表为空）的盲盒信息时，从 B站 API 获取。
    // 与 stats-client 保持一致：本地即使已有条目，只要名称/单价/礼物不完整就重新拉取，
    // 避免早期误存"盲盒_<id>"、单价0 的坏缓存一直显示异常。
    // source=server 账号无 B站 Cookie，拉取必然失败，跳过并在后面直接使用本地（已从服务器拉取）的盲盒信息。
    for (const blindBoxId of blindBoxIds) {
      const info = allBlindBoxInfo[blindBoxId];
      const needsBlindBoxInfo =
        !info ||
        !info.gifts ||
        info.gifts.length === 0 ||
        !info.blind_box_name ||
        info.blind_price <= 0 ||
        info.blind_box_name === `盲盒_${blindBoxId}`;
      if (needsBlindBoxInfo && session.source !== "server") {
        try {
          const checkResult = await checkBlindBox(platform, blindBoxId, cookie);
          if (checkResult) {
            await saveBlindBoxInfo(platform, session.mid, session.uname, blindBoxId, {
              gift_name: checkResult.blindGiftName,
              gift_img: "",
              price: checkResult.blindPrice,
              gifts: checkResult.gifts,
            });
            allBlindBoxInfo[blindBoxId] = {
              blind_box_id: blindBoxId,
              blind_box_name: checkResult.blindGiftName,
              blind_box_img: "",
              blind_price: checkResult.blindPrice,
              gifts: checkResult.gifts,
              updated_at: getBeijingTime(),
            };
          }
        } catch (err) {
          console.error(`[AnchorGifts-Tauri] 获取盲盒 ${blindBoxId} 信息失败:`, err);
        }
      }
    }

    const giftIdToBlindBoxId = new Map<number, number>();
    for (const [blindBoxIdStr, info] of Object.entries(allBlindBoxInfo)) {
      const blindBoxId = Number(blindBoxIdStr);
      if (info.gifts) {
        for (const g of info.gifts) {
          giftIdToBlindBoxId.set(g.gift_id, blindBoxId);
        }
      }
    }

    for (const r of filteredRecords) {
      totalHamster += r.hamster;
      dateSet.add(getDatePart(r.time));

      // 礼物汇总
      const existingGift = giftMap.get(r.gift_id);
      if (existingGift) {
        existingGift.num += r.num;
        existingGift.hamster += r.hamster;
      } else {
        giftMap.set(r.gift_id, { name: r.name, num: r.num, hamster: r.hamster });
      }

      // 粉丝分布
      const fan = fanMap.get(r.uid);
      if (fan) {
        fan.hamster += r.hamster;
        fan.giftCount += r.num;
        fan.dateSet.add(getDatePart(r.time));
      } else {
        fanMap.set(r.uid, {
          uname: r.uname,
          hamster: r.hamster,
          giftCount: r.num,
          dateSet: new Set([getDatePart(r.time)]),
        });
      }

      // 月度汇总
      const d = new Date(r.time);
      const monthKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthly = monthlyMap.get(monthKey);
      if (monthly) {
        monthly.hamster += r.hamster;
        monthly.count += r.num;
      } else {
        monthlyMap.set(monthKey, { hamster: r.hamster, count: r.num });
      }

      // 盲盒统计
      const bbId = giftIdToBlindBoxId.get(r.gift_id);
      if (bbId !== undefined) {
        const bbCount = blindBoxCountMap.get(bbId);
        if (bbCount) {
          bbCount.num += r.num;
          bbCount.hamster += r.hamster;
        } else {
          blindBoxCountMap.set(bbId, { num: r.num, hamster: r.hamster });
        }

        let giftMapForBB = blindBoxGiftCountMap.get(bbId);
        if (!giftMapForBB) {
          giftMapForBB = new Map();
          blindBoxGiftCountMap.set(bbId, giftMapForBB);
        }
        const giftBB = giftMapForBB.get(r.gift_id);
        if (giftBB) {
          giftBB.num += r.num;
          giftBB.hamster += r.hamster;
        } else {
          giftMapForBB.set(r.gift_id, { name: r.name, num: r.num, hamster: r.hamster });
        }

        let fanMapForBB = blindBoxFanMap.get(bbId);
        if (!fanMapForBB) {
          fanMapForBB = new Map();
          blindBoxFanMap.set(bbId, fanMapForBB);
        }
        const fanBB = fanMapForBB.get(r.uid);
        if (fanBB) {
          fanBB.count += r.num;
        } else {
          fanMapForBB.set(r.uid, { uname: r.uname, count: r.num });
        }

        let datesForBB = blindBoxDateSet.get(bbId);
        if (!datesForBB) {
          datesForBB = new Set();
          blindBoxDateSet.set(bbId, datesForBB);
        }
        datesForBB.add(getDatePart(r.time));
      }
    }

    // 构建盲盒盈亏
    const blindBoxProfits: BlindBoxProfit[] = [];
    for (const blindBoxId of blindBoxIds) {
      const count = blindBoxCountMap.get(blindBoxId);
      const info = allBlindBoxInfo[blindBoxId];
      const boxName = info?.blind_box_name ?? `盲盒_${blindBoxId}`;
      const boxImg = getGiftImg(blindBoxId) ?? blindBoxConfig.icons[blindBoxId] ?? info?.blind_box_img ?? "";
      const drawCount = count?.num ?? 0;
      const totalHamsterBB = count?.hamster ?? 0;
      const blindPrice = (info?.blind_price ?? 0) * 50;
      const cost = drawCount * blindPrice;

      const gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }> = [];
      const giftCountMap = blindBoxGiftCountMap.get(blindBoxId);
      if (info?.gifts) {
        for (const g of info.gifts) {
          const actualCount = giftCountMap?.get(g.gift_id);
          gifts.push({
            gift_id: g.gift_id,
            name: g.gift_name,
            num: actualCount?.num ?? 0,
            hamster: actualCount?.hamster ?? 0,
            img: g.gift_img,
          });
        }
      }

      const fanMapForBB = blindBoxFanMap.get(blindBoxId);
      const anchors = fanMapForBB
        ? Array.from(fanMapForBB.entries())
            .map(([ruid, v]) => ({ ruid: Number(ruid), rname: v.uname, count: v.count }))
            .sort((a, b) => b.count - a.count)
        : [];

      const datesForBB = blindBoxDateSet.get(blindBoxId);
      const sortedDates = datesForBB ? Array.from(datesForBB).sort() : [];
      const dateRangeBB = sortedDates.length > 0
        ? { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] }
        : null;

      blindBoxProfits.push({
        gift_id: blindBoxId,
        name: boxName,
        drawCount,
        totalHamster: totalHamsterBB,
        cost,
        profit: totalHamsterBB - cost,
        gifts,
        img: boxImg,
        blindPrice: (info?.blind_price ?? 0) / 2,
        anchors,
        dateRange: dateRangeBB,
      });
    }

    // 兼容旧版
    const blindBoxProfit = blindBoxProfits.length > 0 ? blindBoxProfits[0] : null;

    const giftSummary = Array.from(giftMap.entries())
      .map(([gift_id, v]) => ({ gift_id, name: v.name, num: v.num, hamster: v.hamster, img: getGiftImg(gift_id) }))
      .sort((a, b) => b.hamster - a.hamster);

    const fanDistribution = Array.from(fanMap.entries())
      .map(([uid, v]) => ({ uid, uname: v.uname, hamster: v.hamster, giftCount: v.giftCount }))
      .sort((a, b) => b.hamster - a.hamster);

    const monthlyData = Array.from(monthlyMap.entries())
      .map(([month, v]) => ({ month, hamster: v.hamster, count: v.count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const sortedDates = Array.from(dateSet).sort();
    const computedDateRange = sortedDates.length > 0
      ? { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] }
      : null;

    // 粉丝送礼天数统计
    const fanStats = Array.from(fanMap.entries())
      .map(([uid, v]) => {
        const sortedFanDates = Array.from(v.dateSet).sort();
        const consecutive = calcMaxConsecutive(sortedFanDates);
        return {
          uid,
          uname: v.uname,
          totalDays: v.dateSet.size,
          maxConsecutiveDays: consecutive.max,
          consecutiveStart: consecutive.start,
          consecutiveEnd: consecutive.end,
        };
      })
      .sort((a, b) => b.totalDays - a.totalDays);

    const allConsecutive = calcMaxConsecutive(sortedDates);

    const yesterdayDate = yesterdayStr.slice(0, 4) + "-" + yesterdayStr.slice(4, 6) + "-" + yesterdayStr.slice(6, 8);
    // 优先采用 B站 API 的 ready 标识；未拉取到昨日分段时回退到本地记录判断
    const yesterdayAvailable =
      yesterdayApiReady !== null
        ? yesterdayApiReady
        : allRecords.some((r) => r.time.startsWith(yesterdayDate));

    const data: AnchorGiftsResult = {
      totalHamster,
      totalRmb: totalHamster / 100,
      totalCount: filteredRecords.length,
      totalPage: Math.ceil(allRecords.length / PAGE_SIZE),
      giftTypes: giftMap.size,
      fanCount: fanMap.size,
      monthlyData,
      fanDistribution,
      giftSummary,
      dateRange: computedDateRange,
      blindBoxProfit,
      blindBoxProfits,
      otherStats: {
        dayStats: { totalDays: sortedDates.length, maxConsecutiveDays: allConsecutive.max },
        fanStats,
      },
      records: filteredRecords,
      filter: { dateRange, fan },
      metadata: meta,
      fetchedNewPages,
      yesterdayAvailable,
    };

    return { code: 0, message: "ok", data };
  } catch (err: any) {
    console.error("[AnchorGifts-Tauri] 获取礼物流水失败:", err?.message || err);
    return { code: 500, message: `获取礼物流水失败: ${err?.message || String(err)}`, data: null };
  }
  } finally {
    _fetchingGlobal = false;
  }
}
