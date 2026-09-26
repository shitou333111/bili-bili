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
import { ensureGiftCatalogLoaded, getGiftImg, getGiftImgByName } from "./gift-catalog-client";
import { buildGiftSummary } from "./gift-summary";
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
import { hasLiveRoom } from "./medical-client";

// B站 礼物流水接口每页返回条数（客户端不传 page_size，使用 B站 默认 50）
const PAGE_SIZE = 50;
// B站 礼物流水接口实际每页返回条数：实测 page0 返回 20 条（total_count/total_page≈20）。
// 用于"月份内断点续拉"按已有记录数推算该从第几页接着翻。
const API_PAGE_SIZE = 20;

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
  /** 首次登录全量探测收益为空 → 判定为无收益/非持续开播主播，置位后跳过后续全量探测 */
  noRevenue?: boolean;
  /**
   * 已"完整覆盖"的最早扫描起点（YYYYMMDD）。仅在本轮无未知月份、未保守中断时写入。
   * 缺失 = 旧版本遗留数据，可能带着"end_date 很新但更早历史从未抓取"的缺失（见历史缺失自愈）。
   */
  scan_from?: string;
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
  /** 本次是否已（或此前已）判定该账号无收益（noRevenue），供前端立即隐藏主播页 */
  noRevenue: boolean;
  fetchedNewPages: number;
  yesterdayAvailable: boolean;
  /** 本次 412 退避重试后仍被拦截而收尾：同窗口内重试无效，须稍后手动刷新续拉 */
  quotaExhausted?: boolean;
  /** 本轮未抓完（page0 失败 / 翻页中断）的月份数，供界面提示补拉进度 */
  pendingMonths?: number;
};

// ==================== 常量 ====================

// ==================== 抓取速率（唯一的速率参数） ====================
// 用户只能调一个东西：每秒发多少次请求（req/s）。内部由此派生出
// ①全局发包间隔 = 1000/速率，②月份并发度（只为喂满节拍，不再对用户暴露）。
// 所有 B站 拉取路径（绿色环形刷新 / 冷启动自动刷新 / 增量更新 / 重建数据库）都经过
// fetchGiftStreamPage 的全局节拍器，因此统一受本参数约束。
//
// 取值依据（2026-09 阶梯加载实测，同一出口 IP，登录 Cookie）：
//  - B站 的 412 是 WAF 网关层拦截（返回 HTML 拦截页，早于业务校验）；凭证（buvid3/buvid4/
//    指纹头）与请求通道（Web Cookie / APP appkey 签名）对阈值均无显著影响（四档对照实测
//    376/400/505/388 次，差异落在噪声内）→ 瓶颈是出口 IP，不是身份。
//  - 限流由"速率"决定，不是"累计次数"：2 req/s 连发 3 分钟（361 次）零 412；
//    3 req/s 连发 30 分钟（5401 次）零 412、延迟平稳（76ms，无软降速）；
//    4 req/s 第 63 秒（252 次）被拦；5 req/s 第 39 秒（196 次）被拦；10~12.6 req/s 几十秒被拦。
//    → 触发点在"60 秒窗口内约 200 次请求"附近：3 req/s = 180 次/分，只剩约 10% 余量。
//      因此 3 req/s 是"贴着线"的默认值（速度优先），2 req/s（120 次/分）才是宽裕档位。
//  - 超额后惩罚阶梯递增（0s → 61s → 851s → 15min 以上），恢复需静置 15~25 分钟。
export const DEFAULT_FETCH_RATE = 3; // req/s（速度优先）
export const MIN_FETCH_RATE = 1;
export const MAX_FETCH_RATE = 12;
/** 速率档位持久化键（localStorage），保证冷启动自动刷新也能读到用户选择。 */
const FETCH_RATE_STORAGE_KEY = "bili_live_anchor_fetch_rate";

/** 速率 → 月份并发度：并发只保证"能喂满节拍"，不再是用户可见的旋钮（并行度=1 时等价串行）。 */
function concurrencyForRate(rate: number): number {
  return Math.min(6, Math.max(1, Math.round(rate)));
}

function clampRate(v: number): number {
  return Math.min(MAX_FETCH_RATE, Math.max(MIN_FETCH_RATE, v));
}

function loadSavedRate(): number {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_FETCH_RATE;
    const v = Number(localStorage.getItem(FETCH_RATE_STORAGE_KEY));
    return Number.isFinite(v) && v >= MIN_FETCH_RATE && v <= MAX_FETCH_RATE ? v : DEFAULT_FETCH_RATE;
  } catch {
    return DEFAULT_FETCH_RATE;
  }
}

/** 当前抓取速率（req/s）。模块级单值：运行中途改档对后续请求即刻生效。 */
let _fetchRate = loadSavedRate();

/** 设置抓取速率（req/s），越界自动收敛到 [MIN_FETCH_RATE, MAX_FETCH_RATE] 并持久化。 */
export function setFetchRate(rate: number): void {
  const v = Number(rate);
  if (!Number.isFinite(v)) return;
  _fetchRate = clampRate(v);
  try {
    localStorage.setItem(FETCH_RATE_STORAGE_KEY, String(_fetchRate));
  } catch {
    /* ignore */
  }
}

export function getFetchRate(): number {
  return _fetchRate;
}

const PAGE_RETRY_COUNT = 3;
const PAGE0_RETRY_COUNT = 5;
/**
 * 撞到 HTTP 412 后就地退避的梯度：先短等、再长等，仍被拦则本轮收尾
 * （进度已落盘，界面提示稍后刷新续拉）。刻意不设更长的等待——严格期靠调低抓取速度解决。
 */
const QUOTA_BACKOFF_MS = [60 * 1000, 300 * 1000];
/**
 * 本轮是否已放弃（412 退避重试后仍被拦）：置位后本轮所有重试/翻页立即放弃（不再空转等待），
 * 由 fetchAnchorGifts 带回 quotaExhausted，由界面提示用户稍后手动刷新。
 */
let _quotaHitThisRun = false;
/** 412 退避期间的进度上报钩子（由 fetchAnchorGifts 注入，把"等待限流恢复 mm:ss"透传给界面） */
let _quotaWaitReporter: ((info: { attempt: number; remainMs: number }) => void) | null = null;
const CONSECUTIVE_MATCH_THRESHOLD = 5;

// 注：原"连续 N 个月无数据即判定历史尽头并提前停止"的机制已删除。
// 抓取改为从旧到新，且首次全量扫描有首探阶段逐月探明数据分布（见 probeMonthOnce），
// 数据起止月份是"实测确定"而非"靠连续空月份推断"，因此早停判据既无必要、还会误判
// （账号停播又复播的中段断档会被当成历史尽头）。空月份的取舍改由 empty_counts 承担。

// 单轮"未知月份"（page0 完全失败 / 翻页中断）上限：达到即视为整体限流，
// 保守中断本轮并保持 end_date = 本次扫描起点（绝不推进）。低于上限时不再中断整轮，
// 而是把未知月份计入 empty_counts 钉住 end_date 供下轮补拉，同时继续扫描其余月份。
const MAX_UNKNOWN_MONTHS_PER_RUN = 3;

// 历史缺失自愈：旧版本"月份获取失败即中断整轮并保存 end_date=失败月份"会留下
// "end_date 已经推到最近、本地却只有最近一两个月记录"的损坏数据——更早历史因 end_date
// 越不过去而永久不可达。判据：缺少 scan_from 标记，且 end_date 距昨天 ≤ SELF_HEAL_END_DATE_DAYS
// 天、本地最早记录距当前月份 ≤ SELF_HEAL_RECORD_SPAN_MONTHS 个月（典型的"只有最近一两个月"）。
// 命中则强制从 B站 保留边界全量重扫一次并把 scan_from 写入，之后不再重复。
const SELF_HEAL_END_DATE_DAYS = 62;
const SELF_HEAL_RECORD_SPAN_MONTHS = 5;

// 伪空重试间隔：page0 返回 total_page=0 时，按这些递增间隔再查，
// 区分"软限流/冷缓存的假空"与"真无数据"
const EMPTY_RETRY_INTERVAL_MS = [5000, 15000, 30000];
// 可疑空月份连续判定上限：同一空月份连续 N 次运行仍为空 → 视为真无数据并放行 end_date（防死循环）。
// 上限越大，持续软限流/冷缓存时伪空越不容易被误判丢弃（但真空月份冗余补拉轮数越多）。
// 从 5 提到 8：风控持续时真实有数据的月份更容易在"满 N 次"前被软限流误判为真无数据
// 而永久跳过（end_date 越过该月后不再回头补拉），提高上限可显著减少这类缺数据。
const MAX_CONSECUTIVE_EMPTY_RUNS = 8;

const GIFT_STREAM_API = "https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getReceivedGiftStream";

/** 浪漫城堡礼物 ID（心动盲盒内的特殊大奖） */
const CASTLE_GIFT_ID = 32132;

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
  const obj = parsed as { records?: BiliGiftRecord[]; end_date?: string; last_fetch?: string; total_page?: number; empty_counts?: Record<string, number>; noRevenue?: boolean; scan_from?: string };
  return {
    records: obj.records ?? [],
    meta: obj.end_date !== undefined || obj.noRevenue !== undefined
      ? { end_date: obj.end_date, last_fetch: obj.last_fetch, total_page: obj.total_page, empty_counts: obj.empty_counts ?? {}, noRevenue: obj.noRevenue ?? false, scan_from: obj.scan_from }
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
        noRevenue: meta.noRevenue ?? false,
        scan_from: meta.scan_from,
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

  // 412 就地退避重试：撞到限流不再立刻抛给上层收尾，而是按梯度等一会儿重试同一个请求，
  // 让"一次点击"在本次运行内尽量跑完。退避用完仍被拦才收尾（进度已落盘，稍后刷新续拉）。
  for (let attempt = 0; ; attempt++) {
    await paceRequest();

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
      if (!err?.message?.includes("412")) throw err;
      // 412 = 撞到出口 IP 的 WAF 配额（与凭证、通道无关）。退避梯度用完即收尾本轮。
      if (attempt >= QUOTA_BACKOFF_MS.length) {
        _quotaHitThisRun = true;
        throw new Error(`412 限流：已退避重试 ${attempt} 次仍被拦截`);
      }
      const wait = QUOTA_BACKOFF_MS[attempt];
      console.warn(
        `[AnchorGifts-Tauri] 撞到 B站 412 限流，退避 ${Math.round(wait / 1000)}s 后重试`
        + `（第 ${attempt + 1}/${QUOTA_BACKOFF_MS.length} 次）：page=${page} begin=${beginDate}`,
      );
      await sleepBackoff(wait, attempt);
    }
  }
}

/**
 * 单次 page0 探测（仅网络层重试，不做伪空重试）：用于首探阶段逐月探明数据分布，
 * 只需快速判断该月有没有数据，不翻页。
 * failed=true 表示未得到可信结论（网络/限流持续失败），调用方必须保守处理（不得据此判空，
 * 也不得据此判有数据）——它会以 "unknown" 记入月份计划，并在翻页阶段被重新请求。
 * 成功时一并带回 page0 原始响应，供后续正式翻页直接复用，避免对同一批月份重复请求。
 */
async function probeMonthOnce(
  platform: Platform,
  cookie: string,
  csrf: string,
  buvidCookie: string,
  chunk: { start: string; end: string },
): Promise<{ hasData: boolean; failed: boolean; credentialExpired: boolean; firstPage?: BiliGiftStreamResponse; failInfo?: string }> {
  let failInfo = "未知（未收到响应）";
  for (let attempt = 0; attempt <= PAGE0_RETRY_COUNT; attempt++) {
    // 本轮已撞到配额窗口（412）：继续探测只会拿到同样的 412，立即放弃交上层收尾
    if (_quotaHitThisRun) {
      return { hasData: false, failed: true, credentialExpired: false, failInfo: "412 限流退避耗尽" };
    }
    try {
      const result = await fetchGiftStreamPage(platform, cookie, csrf, 0, chunk.start, chunk.end, buvidCookie);
      if (result.code === 0) {
        return { hasData: (result.data?.total_page ?? 0) > 0, failed: false, credentialExpired: false, firstPage: result };
      }
      // B站凭证失效：交由上层立即跳登录
      if (result.code === -101 || result.code === 3 || (result.message && result.message.includes("未登录"))) {
        return { hasData: false, failed: false, credentialExpired: true };
      }
      // 1301000：数据已过期（超出 B站 3 年保留期）→ 视为无数据
      if (result.code === 1301000) {
        return { hasData: false, failed: false, credentialExpired: false, firstPage: result };
      }
      failInfo = `code=${result.code} ${result.message ?? ""}`.trim();
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    } catch (err) {
      failInfo = err instanceof Error ? err.message : String(err);
      if (_quotaHitThisRun) {
        return { hasData: false, failed: true, credentialExpired: false, failInfo: "412 限流退避耗尽" };
      }
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return { hasData: false, failed: true, credentialExpired: false, failInfo };
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
  castleFans: Array<{ uid: number; uname: string; face: string; count: number; records: string[] }>;
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
  /** 显式标记：本进度来自"主播收益"拉取。界面据此决定是否追加收益相关的 4 行提示，
   *  不再依赖对 text 做正则匹配（文案一变就失效，已踩过坑）。 */
  anchorGift?: boolean;
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

/**
 * 全局发包节拍器（整机唯一）：所有月份 worker 共用同一个节拍，因此整机速率恒等于
 * fetchRate req/s，与派生的月份并发度无关（并发度只保证有足够的 worker 喂满节拍）。
 * 间隔 = 1000 / 速率，逐包推进、不做突发——实测短窗口对"瞬时速率"敏感，
 * 攒够一波再放会被 412 拦掉；退避期间节拍落后于当前时间，用 Math.max 不补偿积压，
 * 避免 412 退避结束瞬间把欠下的请求一次性补发出去。
 */
let _pacerNextAt = 0;
/** 本轮已发出的 B站 请求数（含重试/伪空重试/探测），用于结合 plannedRequests 估算剩余耗时。 */
let _requestsIssued = 0;
function paceRequest(): Promise<void> {
  const now = Date.now();
  const at = Math.max(_pacerNextAt, now);
  _pacerNextAt = at + 1000 / _fetchRate;
  _requestsIssued++;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

/**
 * 412 退避等待：期间每秒刷新一次锁心跳（避免超过 5 分钟锁超时被抢锁），并把剩余时间透传给界面。
 */
async function sleepBackoff(ms: number, attempt: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (_fetchingGlobal) _fetchingGlobalAt = Date.now();
    _quotaWaitReporter?.({ attempt, remainMs: end - Date.now() });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function fetchAnchorGifts(
  platform: Platform,
  opts: { refresh?: boolean; dateRange?: string; fan?: string; onProgress?: FetchProgressHandler; probe?: boolean; fast?: boolean } = {},
): Promise<{ code: number; message: string; data?: AnchorGiftsResult | null }> {
  const { fast = false } = opts;

  // fast/cached：仅基于本地 records 计算统计，不拉 B站、不起锁、不刷新凭证（无任何网络副作用）。
  // 供主播页启动时先展示缓存数据再静默更新。
  let acquired = false;
  if (!fast) {
    const ok = await acquireLock();
    if (!ok) {
      return { code: -1, message: "already fetching", data: null };
    }
    acquired = true;
    // 每轮开始清空"限流"标记，只反映本轮是否撞到 412
    _quotaHitThisRun = false;
    // 节拍器复位：上一轮结束后残留的 _pacerNextAt 不应把本轮的起步时间提前
    _pacerNextAt = 0;
    _requestsIssued = 0;
  }

  try {
  const { refresh = false, dateRange = "all", fan = "", onProgress, probe = false } = opts;
  // 本轮月份并发度（由速率派生，只保证喂满节拍；速率为 1 时并发 1 = 完全串行）
  const monthConcurrency = concurrencyForRate(_fetchRate);

  const session = await resolveSession(platform);
  if (!session) {
    return { code: 0, message: "needs-relogin", data: null };
  }

  // 客户端凭证验证与自动刷新（仅非 server 账号有 B站 Cookie）
  // SESSDATA 失效时用 refresh_token 自动刷新，避免频繁要求重新登录
  let cookie = buildCookie(session);
  let csrf = cookie.match(/bili_jct=([a-f0-9]+)/)?.[1] || "";

  if (!fast && session.source !== "server") {
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
    // 本次拉取是否判定该账号无收益（供响应带回前端立即隐藏主播页）
    let markedNoRevenue = false;
    // 本轮是否撞到 B站 配额窗口（412）而提前收尾、以及未抓完的月份数：带回前端用于
    // "已抓 X 条，还剩 N 个月份待补，将于 HH:MM 自动继续"的提示与自动续跑
    let quotaExhausted = false;
    let pendingMonths = 0;

    const yesterdayStr = getYesterdayStr();

    // 无直播间（非主播）或已标记无收益（noRevenue）的账号：跳过整个收益拉取。
    // 大多数用户并未开播或未持续开播：仅"扫码登录触发的全量探测"（probe=true，且 roomStatus=1）
    // 才会做有容错的全量收益探测；冷启动/绿色刷新不再重复全量探测。
    let skipPull = false;
    if (fast) {
      // 快速/缓存路径：仅用本地记录计算统计，绝不拉 B站
      skipPull = true;
    } else if (session.source === "server") {
      // 纯服务器收集账号（source=server）本机无 B站 Cookie，根本无法从 B站 拉取增量，
      // 只能基于已从自建服务器拉取到本地的记录计算统计。
      // 绝不能带着空凭证去打 B站（会得到 -101 → 误触发 needs-relogin → 被强制跳登录页）。
      skipPull = true;
      console.log(`[AnchorGifts-Tauri] ${session.mid} 服务器账号，跳过 B站 收益拉取（仅用本地记录）`);
    } else if (meta?.noRevenue) {
      skipPull = true;
      console.log(`[AnchorGifts-Tauri] ${session.mid} 已标记无收益，跳过收益记录拉取`);
    } else {
      skipPull = !(await hasLiveRoom(session.mid));
      if (skipPull) {
        console.log(`[AnchorGifts-Tauri] ${session.mid} 无直播间，跳过收益记录拉取（仅用本地 ${existingRecords.length} 条记录）`);
      }
    }

    // 昨日可用性：以 B站 API 返回的 ready 标识为准（ready=1 表示昨日数据已汇总完成，
    // 即使昨日无收礼记录也应可点击；ready=0 表示官方尚未更新，需置灰）。
    // 无 API 返回（source=server / 离线 / 未拉取到昨日分段）时回退到本地记录判断。
    let yesterdayApiReady: boolean | null = null;

    // B站仅保留近3年数据。月初时"3年前的当月"已过期，最早可拉月份应为"3年前的下个月"。
    // 该边界仅用于对 end_date / 旧缓存起始 做下限收拢；首次全量/回退分支已内置同样的计算。
    // 若不收拢，持久化的 end_date 若指向已过期月份，就会在月初去请求 3 年前当月 → B站 返回
    // 1301000"数据已过期"，白白浪费一次请求且延缓 end_date 推进。
    const retentionBoundary = (() => {
      const d = new Date();
      const utc = d.getTime() + d.getTimezoneOffset() * 60000;
      const bj = new Date(utc + 8 * 3600000);
      const sy = bj.getFullYear() - 3;
      const sm = bj.getMonth() + 1;
      const by = sm === 12 ? sy + 1 : sy;
      const bm = sm === 12 ? 1 : sm + 1;
      return `${by}${String(bm).padStart(2, "0")}01`;
    })();
    const clampStart = (d: string) => (d < retentionBoundary ? retentionBoundary : d);

    /**
     * 历史缺失自愈判据（probe / 非 probe 共用）：
     * 旧版"月份获取失败即中断整轮并保存 end_date=失败月份"会留下 end_date 已推到最近、
     * 本地却只有最近一两个月的损坏数据——更早历史因 end_date 越不过去而永久不可达。
     * 这类数据没有 scan_from 标记，且记录跨度极短（见 SELF_HEAL_* 常量）。
     * 命中则放弃 end_date，从保留边界全量重扫一次；scan_from 写入后不再重复触发。
     */
    const needsSelfHealFullScan = (): boolean => {
      if (meta?.scan_from || !meta?.end_date || existingRecords.length === 0) return false;
      try {
        const endDiffDays = Math.round(
          (parseDateStr(yesterdayStr).getTime() - parseDateStr(meta.end_date).getTime()) / 86400000,
        );
        let earliest = existingRecords[0].time;
        for (const r of existingRecords) if (r.time < earliest) earliest = r.time;
        const earliestYM = earliest.slice(0, 7).replace("-", "");
        const curYM = yesterdayStr.slice(0, 6);
        const spanMonths = (Number(curYM.slice(0, 4)) * 12 + Number(curYM.slice(4, 6)))
          - (Number(earliestYM.slice(0, 4)) * 12 + Number(earliestYM.slice(4, 6)));
        return endDiffDays >= 0 && endDiffDays <= SELF_HEAL_END_DATE_DAYS && spanMonths <= SELF_HEAL_RECORD_SPAN_MONTHS;
      } catch {
        return false;
      }
    };

    // 起始日期：
    // - probe=true（扫码登录触发）：允许有容错的全量探测——无基线时从3年前开始，
    //   end_date 被错误推进时保底回退全量；登录探测被中断时也从 end_date 续拉。
    // - probe=false（冷启动/绿色刷新）：绝不全量探测，仅在已有数据基线时做增量追赶；
    //   无基线（从未探测成功 / 登录探测被中断）的账号直接跳过拉取，避免反复试探。
    const startDate = (() => {
      if (skipPull) return yesterdayStr; // 无房/无收益不拉取，startDate 无意义，占位即可
      // 历史缺失自愈：无论 probe 与否都强制全量重扫一次（否则下一次 end_date 推进会让
      // 更早历史永久不可达）。仅命中旧版损坏特征时触发，scan_from 写入后不再重复。
      if (needsSelfHealFullScan()) {
        console.warn(`[AnchorGifts-Tauri] 历史缺失自愈：end_date=${meta?.end_date} 但本地记录仅跨极少月份，改为从保留边界 ${retentionBoundary} 全量重扫`);
        return clampStart(retentionBoundary);
      }
      if (probe) {
        // 与服务器 route 保持一致：只用 end_date 决定起始日期。
        // - end_date 非空 → 从 end_date 开始增量获取（含被中断探测的续拉）
        // - end_date 为空但已有本地记录（旧缓存）→ 从已有记录最新时间开始增量获取
        // - 两者皆无 → 首次全量探测，从3年前下个月开始
        let forceFullScan = false; // true = 放弃 end_date，从 B站 保留边界全量重扫
        if (meta?.end_date) {
          // ===== 保底：end_date 已推进至近期但 records 为空 → 视为被错误推进，回退全量 =====
          // 典型场景：首次探测时网络/412 导致 page 0 失败被旧代码当成"无数据"跳过，
          // end_date 被错误写入"昨天"。即使现在网络已恢复，按 meta.end_date=昨天 只会拉 1-2 天，
          // 永远拿不到 3 年历史。
          // 判据：本地一条记录都没有（从来没成功获取过）且 end_date 距离昨天 ≤ 30 天
          // （已经推到"最新"），则放弃 end_date，从 3 年前重新全量。
          if (existingRecords.length === 0) {
            try {
              const endD = parseDateStr(meta.end_date);
              const yesD = parseDateStr(yesterdayStr);
              const diffDays = Math.round((yesD.getTime() - endD.getTime()) / 86400000);
              if (diffDays >= 0 && diffDays <= 30) {
                console.warn(`[AnchorGifts-Tauri] 保底回退：end_date=${meta.end_date}(距昨天${diffDays}天)但现有0条记录，视为被错误推进，改为从3年前全量拉取`);
                forceFullScan = true;
              }
            } catch { /* parseDateStr 异常则不回退，走原逻辑 */ }
          }
          if (!forceFullScan) return clampStart(meta.end_date);
        }
        if (!forceFullScan && existingRecords.length > 0) {
          let maxTime = existingRecords[0].time;
          for (const r of existingRecords) {
            if (r.time > maxTime) maxTime = r.time;
          }
          // "YYYY-MM-DD HH:mm:ss" -> YYYYMMDD
          return clampStart(maxTime.slice(0, 10).replace(/-/g, ""));
        }
        // 首次全量探测：B站最多保存3年数据，从3年前的下个月开始
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        const beijing = new Date(utc + 8 * 3600000);
        const startYear = beijing.getFullYear() - 3;
        const startMonth = beijing.getMonth() + 1;
        const beginYear = startMonth === 12 ? startYear + 1 : startYear;
        const beginMonth = startMonth === 12 ? 1 : startMonth + 1;
        return `${beginYear}${String(beginMonth).padStart(2, "0")}01`;
      }
      // 非登录（冷启动/绿色刷新）：仅增量追赶，绝不全量探测
      if (meta?.end_date && existingRecords.length > 0) {
        return clampStart(meta.end_date); // 有数据基线 → 从 end_date 增量
      }
      if (existingRecords.length > 0) {
        let maxTime = existingRecords[0].time;
        for (const r of existingRecords) {
          if (r.time > maxTime) maxTime = r.time;
        }
        // "YYYY-MM-DD HH:mm:ss" -> YYYYMMDD
        return clampStart(maxTime.slice(0, 10).replace(/-/g, ""));
      }
      // 一条记录都没有（含旧版遗留：end_date 已被推到昨天的 0 记录账号）：
      // 非登录拉取只会重查昨天 1 天 + 伪空重试，纯属浪费且无新数据可追。
      // noRevenue 仅由扫码登录（probe=true，含保底回退全量重探）置位，这里一律跳过、
      // 不置位，避免误伤"确曾有历史收益但 end_date 被旧 bug 推到昨天"的账号。
      skipPull = true;
      return yesterdayStr;
    })();

    // ==================== 进度统计状态（月级分母 + 月内页级 + ETA） ====================
    const chunks = generateMonthChunks(startDate, yesterdayStr); // 升序
    /** 单个月的探明结论：data=有数据(pages=总页数)；empty=已确认无数据；unknown=未得到可信结论。 */
    type MonthStatus = "data" | "empty" | "unknown";
    const monthPlan = new Map<string, { status: MonthStatus; pages: number }>();

    /**
     * 进度分母 = "有数据的月份数"（精确值，来自逐月探测），不是"最早到最晚的跨度"。
     * 跨度口径在中间存在空月份时，分母把空月份也算进去、分子却永远不会加上它们，
     * 导致进度条永远到不了 100%；改用计数口径后，每个计入分母的月份都会被真正翻完。
     */
    let totalValidMonths = -1; // -1 表示尚未探明（增量路径没有首探阶段）
    let validDone = 0; // 已完成全部翻页的有数据月份数

    const dataMonthCount = () => {
      let n = 0;
      for (const v of monthPlan.values()) if (v.status === "data") n++;
      return n;
    };
    /** 最早有数据月份在 chunks 中的下标（-1 = 未知）。用于剪枝"开播之前"的空月份。 */
    const firstDataIndexOf = () => {
      for (let i = 0; i < chunks.length; i++) {
        if (monthPlan.get(chunks[i].start)?.status === "data") return i;
      }
      return -1;
    };
    const plannedRequests = () => {
      let n = 0;
      // 有数据月 = 该月总页数；其余（空月/未知月）至少 1 次 page0。
      for (const v of monthPlan.values()) n += v.status === "data" ? Math.max(v.pages, 1) : 1;
      return n;
    };
    /** 剩余耗时文案（尚未探明任何月份时返回空串，不做假估算）。 */
    const fmtRemain = () => {
      const planned = plannedRequests();
      if (planned <= 0 || _requestsIssued <= 0) return "";
      const left = planned - _requestsIssued;
      if (left <= 0) return "即将完成";
      const sec = Math.round(left / _fetchRate);
      if (sec < 60) return "约剩不到 1 分钟";
      if (sec < 3600) return `约剩 ${Math.round(sec / 60)} 分钟`;
      return `约剩 ${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分钟`;
    };
    /** 月级进度（月内页级进度由 processChunk 上报）。 */
    const emitMonthProgress = (ym: string) => {
      const remain = fmtRemain();
      onProgress?.({
        text: `正在获取收益记录 ${ym}（${validDone}/${totalValidMonths}）${remain ? " · " + remain : ""}`,
        ratio: Math.min(1, validDone / totalValidMonths),
        current: validDone,
        total: totalValidMonths,
        anchorGift: true,
      });
    };
    /**
     * 记录某月份的探明结论。调用方必须区分三态：
     *  - 探测失败（未知）绝不能当成"无数据"：那会让该月被排除出分母、且永久不被翻页；
     *  - 分母只上修不下修：未知月份在翻页阶段重试成功后可以补进分母（如软限流假空恢复）。
     */
    const recordMonth = (start: string, status: MonthStatus, pages = 0) => {
      const prev = monthPlan.get(start);
      // 不拿"未得到结论"去覆盖已有结论（例如翻页阶段重试失败不应抹掉首探的结果）
      if (prev && prev.status !== "unknown" && status === "unknown") return;
      monthPlan.set(start, { status, pages });
      // 只有本批月份"全部"有了结论时，分母才算探明。增量路径下月份是边翻边进的，
      // 若每进一个月就重算分母，分母会跟着分子一起涨（如 1/1→2/2→3/3 恒等于 100%）。
      if (monthPlan.size < chunks.length) return;
      const n = dataMonthCount();
      // n=0（本批无任何有数据月份）时不设分母，保持 -1 → 进度条走不定态，
      // 避免出现"（1/0）"这种分母为 0 的文案。
      if (n > 0 && n > totalValidMonths) totalValidMonths = n;
    };

    // ==================== 首探：一次性探完全部月份（仅扫码登录全量探测，且本地无任何记录） ====================
    // 不逐月探明的话，既无法提前确定进度分母，也无法区分"某月真没数据"与"某月没抓到"。
    // 这里把扫描窗口内所有月份的 page0 一次探完（每月 1 次请求，3 req/s 下约 12 秒），换来：
    //  ① 分母（有数据的月份总数）在翻页开始前就固定 → 进度条第一秒起就是确定百分比，不再中途变大；
    //  ② 每个月的 total_page 都已知 → 剩余请求数精确 → ETA 精确。
    // 这些 page0 会被正式翻页阶段从 probedFirstPage 复用，所以不额外增加请求。
    // 全部月份均无数据 → 该账号无收益：置 noRevenue 并保存后立即终止，不再扫描历史月份。
    // 注意：仅"零记录"账号适用（有记录的账号即使近期无数据也不得判无收益）。
    let buvidCookie = "";
    // 首探已拿到的 page0 原始响应（按月份 start 缓存），供正式翻页阶段复用。
    const probedFirstPage = new Map<string, BiliGiftStreamResponse>();
    if (probe && !skipPull && existingRecords.length === 0) {
      buvidCookie = await platform.getBuvidCookie().catch(() => "");
      console.log(`[AnchorGifts-Tauri] 首探：一次探测全部 ${chunks.length} 个月（${startDate} ~ ${yesterdayStr}），用于固定进度分母与 ETA`);
      onProgress?.({ text: "正在探测收益记录（首次全量扫描）...", current: 0, total: 0, anchorGift: true });
      const probeResults = await runWithConcurrency(
        chunks,
        monthConcurrency,
        (c) => probeMonthOnce(platform, cookie, csrf, buvidCookie, c),
      );
      probeResults.forEach((r, i) => {
        if (r.firstPage) probedFirstPage.set(chunks[i].start, r.firstPage);
        // 三态区分：探测失败 = 未知（既不算有数据，也绝不算空），该月会被翻页阶段重试；
        // 只有"拿到可信响应且 total_page=0"才是空月份。
        if (r.failed) recordMonth(chunks[i].start, "unknown");
        else if (r.hasData) recordMonth(chunks[i].start, "data", r.firstPage?.data?.total_page ?? 0);
        else recordMonth(chunks[i].start, "empty");
      });
      if (probeResults.some((r) => r.credentialExpired)) {
        return { code: 0, message: "needs-relogin", data: null };
      }
      // 有月份探测未得到可信结论（网络/限流持续失败）时不判空，继续走正常全量抓取。
      // 补日志：探测失败此前是完全静默的，导致"page0 全失败"看起来像是正式翻页阶段的问题。
      const probeFailedList = probeResults
        .map((r, i) => ({ r, start: chunks[i].start }))
        .filter((x) => x.r.failed);
      if (probeFailedList.length > 0) {
        console.warn(
          `[AnchorGifts-Tauri] 首探有 ${probeFailedList.length}/${chunks.length} 个月未得到可信结论，不判无收益，继续全量抓取；失败明细：`
          + probeFailedList.map((x) => `${x.start}(${x.r.failInfo ?? "未知"})`).join("，"),
        );
      }
      const probeFailed = probeFailedList.length > 0;
      const probeAllEmpty = probeResults.every((r) => !r.hasData);
      if (!probeFailed && probeAllEmpty) {
        markedNoRevenue = true;
        skipPull = true;
        await saveRecordsWithMeta(platform, session.mid, [], {
          end_date: yesterdayStr,
          total_page: meta?.total_page ?? 0,
          last_fetch: getBeijingTime(),
          empty_counts: {},
          noRevenue: true,
        });
        console.log(`[AnchorGifts-Tauri] ${session.mid} 首探短路：全部 ${chunks.length} 个月均无数据，标记 noRevenue 并终止扫描`);
      }
    }

    // 纯服务器收集账号（source=server）无 B站 Cookie，无法从 B站 拉取增量，
    // 直接基于已从自服务器拉取到本地的 anchor-gifts-records.json 计算统计。
    if (!skipPull && startDate <= yesterdayStr) {
      // 412 退避发生在 API 层（fetchGiftStreamPage），此处注入钩子把等待进度透传给界面：
      // 让用户看到"已抓 X 条 · 第 N 次退避 · 等待限流恢复 mm:ss"，而不是页面长时间静止。
      _quotaWaitReporter = ({ attempt, remainMs }) => {
        const sec = Math.max(0, Math.ceil(remainMs / 1000));
        onProgress?.({
          text: `正在获取收益记录：已抓 ${allRecords.length} 条 · 第 ${attempt + 1}/${QUOTA_BACKOFF_MS.length} 次退避 · 等待限流恢复 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`,
          anchorGift: true,
        });
      };
      if (!buvidCookie) buvidCookie = await platform.getBuvidCookie().catch(() => "");
      // buvid 缺失时 B站 live 接口极易直接以 412/风控 拒绝，且 getBuvidCookie 内部 catch 会静默返回空串，
      // 这里显式告警，避免把"缺 buvid 导致的全批失败"误判成账号/数据问题。
      if (!buvidCookie) console.warn("[AnchorGifts-Tauri] buvid Cookie 获取失败（为空），B站可能以 412/风控 拒绝所有请求");
      // 执行顺序：从旧到新。数据起止范围已由首探实测确定，不再需要"从新到旧 + 连续空月份
      // 提前终止"的启发式；顺序推进更符合"按时间补齐历史"的直觉，日志与进度也更好读。
      console.log(`[AnchorGifts-Tauri] 获取数据: ${startDate} ~ ${yesterdayStr}, ${chunks.length}个月, 速率=${_fetchRate}req/s 并发度=${monthConcurrency}（从旧到新）`);

      // 伪空重试（total_page=0 时按递增间隔复查，识别软限流假空）的适用范围：
      // 首探已给出完整的月份分布时，只对"有数据月份之间的空档"复查——中段断档才可疑；
      // 开播之前 / 停播之后的长空白段是账号真的没有收益，若也逐月复查（5s+15s+30s），
      // 一次全量扫描会白等几十分钟。没有首探结论（增量路径）时保持原有行为，一律复查。
      //
      // 例外：最早有数据月份的"前一个月"也必须复查。它紧邻已知最早的数据月，是最可能的
      // 假空位置——首探时该月的 page0 恰好被软限流/冷缓存命中返回 total_page=0 的话，
      // 它会被当成"开播之前"而永久跳过，导致账号真实的最早一个月收益缺失。
      // （代价只有一次 5s+15s+30s 的复查；相较之下漏掉首月历史是不可逆的。）
      const dataStarts = chunks.map((c) => c.start).filter((s) => monthPlan.get(s)?.status === "data");
      const knownRange = monthPlan.size >= chunks.length && dataStarts.length > 0;
      const firstDataStart = knownRange ? dataStarts[0] : null;
      const lastDataStart = knownRange ? dataStarts[dataStarts.length - 1] : null;
      const firstDataIdxInChunks = firstDataIndexOf();
      const monthBeforeFirstData = firstDataIdxInChunks > 0 ? chunks[firstDataIdxInChunks - 1].start : null;
      const shouldRetryEmptyMonth = (start: string) =>
        !knownRange
        || (start > firstDataStart! && start < lastDataStart!)
        || start === monthBeforeFirstData;

      const existingKeyCounter = existingRecords.length > 0 ? buildRecordKeyCounter(existingRecords) : undefined;

      // 单个月份 chunk 处理：拉取该月所有页，返回结果（不修改全局状态，并行安全）
      async function processChunk(
        chunk: { start: string; end: string },
        // 该批中排在最前的月份负责上报月内页级进度：多个月份并行时若都上报，
        // 文案会在不同月份之间来回跳。月级进度仍由每个月份完成时上报。
        reportPages = false,
      ): Promise<{
        records: BiliGiftRecord[];
        totalPages: number;
        hasData: boolean;
        yesterdayReady?: boolean;
        interrupted: boolean;
        page0Failed: boolean;
        /** page0 失败或翻页中断时的原始失败原因（B站 code/message 或网络异常文本），供上层日志定位 */
        failInfo?: string;
        /** 本次判定为"可疑空月份"（伪空重试后仍 total_page=0） */
        empty?: boolean;
        /** B站凭证失效（code=-101/3/"未登录"）：与 page0Failed 不同，需要立即终止整个 fetchAnchorGifts 并让上层跳 /login */
        credentialExpired?: boolean;
      }> {
        const records: BiliGiftRecord[] = [];

        // 首探已确认无数据的月份：直接跳过，不再翻页——省掉一次无用请求。
        // 注意只信任"empty"（拿到可信响应且 total_page=0），"unknown"（探测失败）必须照常重试。
        if (monthPlan.get(chunk.start)?.status === "empty") {
          return { records, totalPages: 0, hasData: false, interrupted: false, page0Failed: false, empty: true };
        }

        // 第0页：优先复用首探阶段已拿到的响应，避免对同一月份重复请求
        let firstPage: BiliGiftStreamResponse | null = probedFirstPage.get(chunk.start) ?? null;
        let lastFailInfo = "未知（未收到响应）"; // 失败原因，供上层日志定位（412/风控/网络/其它 code）
        for (let attempt = 0; firstPage === null && !_quotaHitThisRun && attempt <= PAGE0_RETRY_COUNT; attempt++) {
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
            lastFailInfo = `code=${result.code} ${result.message ?? ""}`.trim();
            await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          } catch (err: any) {
            // 412 → 配额窗口已满：同窗口内重试无效，立即跳出（不再空转等待），由上层收尾
            lastFailInfo = _quotaHitThisRun ? "412 限流退避耗尽" : (err?.message ?? String(err));
            if (_quotaHitThisRun) break;
            await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
          }
        }

        // page 0 所有重试均失败（网络错误、412 限流持续等）：
        // 必须标记 page0Failed，否则上层会当作"正常无数据"推进 end_date，
        // 导致该月及更早的历史数据被永久跳过。
        if (!firstPage) {
          console.warn(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} page 0 获取完全失败，标记为 page0Failed（最后失败原因：${lastFailInfo}）`);
          return { records, totalPages: 0, hasData: false, interrupted: false, page0Failed: true, failInfo: lastFailInfo };
        }
        // 记录该月结论（page0 已确定，1301000 数据过期也属无数据）。
        // 未知月份在这里重试成功后会把结论升级为 data/empty，并相应修正进度分母。
        recordMonth(
          chunk.start,
          firstPage.code === 0 && (firstPage.data?.total_page ?? 0) > 0 ? "data" : "empty",
          firstPage.data?.total_page ?? 0,
        );
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
        // 只在"值得怀疑的月份"上做（见 shouldRetryEmptyMonth）：开播前/停播后的大段空白不值得逐月白等。
        if (totalPages === 0 && shouldRetryEmptyMonth(chunk.start)) {
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
          // 伪空重试恢复出数据：修正该月的请求数计划与"有数据"判定（分母只上修）
          console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 伪空误判修正：该月实有数据（total_page=${totalPages}）`);
          recordMonth(chunk.start, "data", totalPages);
        }

        if (firstPage.data?.list?.length) {
          records.push(...firstPage.data.list);
        }

        // 翻页
        let interrupted = false;
        let lastPageFailInfo = "未知（未收到响应）"; // 翻页中断时的原始失败原因
        // "提前停翻"开关：命中本地已有记录时提前结束翻页，用于跳过已经完整抓过的月份。
        // 但对于上一轮被限流打断、尚未抓完的月份（记在 empty_counts 里）必须关掉，
        // 否则重拉时会在"已有记录的边界"处再次提前停翻，该月份尾部数据永远补不回来。
        const allowEarlyStop = (meta?.empty_counts?.[chunk.start] ?? 0) < 1;
        // 月份内断点续拉：该月上一轮被 412 打断（记在 empty_counts 里）时，本地已存有前 K 页记录。
        // 必须从缺失页接着翻，而不是从 page 1 重翻——否则每次运行都只会重复抓取同样的前 K 页，
        // 配额一耗尽就再次中断，尾部数据永远拿不到（多轮运行也无法收敛）。
        // 留 2 页余量防边界漂移，重复记录由合并阶段的 existingKeyCounter 去重。
        let startPage = 1;
        if (!allowEarlyStop) {
          const ym = `${chunk.start.slice(0, 4)}-${chunk.start.slice(4, 6)}`;
          let haveThisMonth = 0;
          for (const r of existingRecords) if (r.time.startsWith(ym)) haveThisMonth++;
          if (haveThisMonth > 0) {
            startPage = Math.max(1, Math.floor(haveThisMonth / API_PAGE_SIZE) - 2);
            console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 断点续拉：本地已有 ${haveThisMonth} 条（约 ${Math.ceil(haveThisMonth / API_PAGE_SIZE)} 页），从第 ${startPage} 页继续（共 ${totalPages} 页）`);
          }
        }
        // 月内页级进度：进入该月翻页时先报一次，之后每翻完一页报一次
        const emitPageProgress = (page: number) => {
          if (!reportPages) return;
          const remain = fmtRemain();
          onProgress?.({
            text: `正在获取收益记录 ${chunk.start.slice(0, 6)} 第 ${page}/${totalPages} 页${remain ? " · " + remain : ""}`,
            ratio: totalValidMonths > 0 ? Math.min(1, validDone / totalValidMonths) : undefined,
            current: validDone,
            total: totalValidMonths,
            anchorGift: true,
          });
        };
        emitPageProgress(startPage);
        for (let p = startPage; p < totalPages; p++) {
          // 已撞到配额窗口（412）：停止剩余翻页（不再发请求空转），记为"部分完成"待下轮断点续拉
          if (_quotaHitThisRun) {
            interrupted = true;
            lastPageFailInfo = "412 限流退避耗尽";
            break;
          }
          if (allowEarlyStop && existingKeyCounter && records.length >= CONSECUTIVE_MATCH_THRESHOLD) {
            const lastN = records.slice(-CONSECUTIVE_MATCH_THRESHOLD);
            const allMatch = lastN.every((r) => {
              const key = recordKey(r);
              return (existingKeyCounter.get(key) ?? 0) > 0;
            });
            if (allMatch) break;
          }

          let success = false;
          for (let attempt = 0; attempt <= PAGE_RETRY_COUNT; attempt++) {
            try {
              const result = await fetchGiftStreamPage(platform, cookie, csrf, p, chunk.start, chunk.end, buvidCookie);
              if (result.code === 0 && result.data?.list) {
                records.push(...result.data.list);
                success = true;
                break;
              }
              lastPageFailInfo = `page=${p} code=${result.code} ${result.message ?? ""}`.trim();
            } catch (err: any) {
              lastPageFailInfo = `page=${p} ${err?.message ?? String(err)}`;
              if (_quotaHitThisRun) break; // 412：不再重试，交由上层收尾
              await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
            }
          }
          if (!success) {
            interrupted = true;
            break;
          }
          emitPageProgress(p + 1);
        }

        return { records, totalPages, hasData: true, yesterdayReady, interrupted, page0Failed: false, failInfo: interrupted ? lastPageFailInfo : undefined };
      }

      // 从旧到新分批抓取：每批最多 monthConcurrency 个月份并行（并发度由速率派生）。
      // 批内结果仍按月份顺序串行处理（见下方 for 循环），与并发度无关。
      const chunkResults: Array<Awaited<ReturnType<typeof processChunk>> | undefined> = new Array(chunks.length);
      const unknownStarts: string[] = []; // page0 完全失败的月份：完全未知，计入保守中断阈值
      const partialStarts: string[] = []; // page0 成功但翻页被 412 打断的月份：已知有数据但不完整
      let aborted = false; // 未知月份过多 → 保守中断本轮（end_date 保持本次起始日期，绝不推进）
      for (let b = 0; b < chunks.length && !aborted; b += monthConcurrency) {
        const batch = Array.from({ length: Math.min(monthConcurrency, chunks.length - b) }, (_, k) => b + k);
        // onTaskDone：每个月份 chunk 完成时立即上报进度（拉取过程中动态更新进度条），
        // 而不是等全部完成后再一次性上报。
        const batchResults = await runWithConcurrency(
          batch,
          monthConcurrency,
          // batch[0] 是本批最靠前的月份：只由它上报月内页级进度，避免多月并行时文案跳来跳去
          (idx) => processChunk(chunks[idx], idx === batch[0]),
          (_batchIndex, idx, result) => {
            // 空月份不计入分母，也不上报进度——它没有"第几个月"可显示，
            // 若在此处改文案，会把"正在获取收益记录 X（n/m）"降级回"正在探测…"（已修复的闪现问题）。
            // 未知月份同理由翻页阶段的结果决定，这里不动进度。
            if (!result.hasData) return;
            validDone++;
            if (totalValidMonths < 0) return; // 分母未探明（增量路径）：交给页级进度显示
            emitMonthProgress(chunks[idx].start.slice(0, 6));
          },
        );
        batch.forEach((idx, k) => { chunkResults[idx] = batchResults[k]; });

        // 本批结果按月份顺序串行处理（去重/中断逻辑依赖有序结果，且避免竞态）。
        // 进度已在 onTaskDone 实时上报，此处不再重复上报。
        for (const idx of batch) {
          const chunk = chunks[idx];
          const result = chunkResults[idx]!;

          if (result.yesterdayReady !== undefined) {
            yesterdayApiReady = result.yesterdayReady;
          }

          // B站凭证失效（code=-101/3）：立即返回 needs-relogin，让上层（page.tsx finishRefresh）
          // 调 handleAuthExpired 跳 /login。不保存任何 end_date，下次重新拉取。
          // 外层 finally 会自动释放 _fetchingGlobal 锁，不需要手动释放
          if (result.credentialExpired) {
            return { code: 0, message: "needs-relogin", data: null };
          }

          // 已取到的记录照常合并（翻页中断的月份也可能已取到前若干页，不能因为失败就丢弃）
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
          if (result.records.length > 0) fetchedNewPages += 1;

          // 拉取失败（page0 完全失败 / 翻页中断）的月份 = 未知月份：
          // 绝不在此中断整轮，也绝不当作"无数据"——那会让该月被排除出分母并永久跳过。
          // 处理：页0失败记为"未知月份"、翻页被限流打断记为"待补拉月份"，
          // 两者都计入 empty_counts 钉住 end_date 供下轮补拉，本轮继续推进后面的月份。
          if (result.page0Failed) {
            console.warn(
              `[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} page0 获取失败，记为未知月份（失败原因：${result.failInfo ?? "未知"}），本轮跳过该月待下轮补拉`,
            );
            unknownStarts.push(chunk.start);
            continue;
          }

          // 翻页被 412 打断 = "部分完成"：该月份确实有数据（前几十页已取到），只是没翻完。
          // 与"未知月份"区分开：不计入保守中断阈值（一轮里几十个月份先后被限流是常态，
          // 若计入会让每次扫描都在中途放弃），但仍计入 empty_counts 钉住 end_date 供下轮补拉。
          if (result.interrupted) {
            console.warn(
              `[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 翻页中断（已取 ${result.records.length} 条，失败原因：${result.failInfo ?? "未知"}），记为待补拉月份`,
            );
            partialStarts.push(chunk.start);
          }
        }

        // 412 退避用完仍被拦截：判定出口 IP 被持续限流，本轮收尾。
        // end_date 保持本轮起点，未知/待补拉月份已计入 empty_counts，用户下次刷新可续拉。
        if (_quotaHitThisRun) {
          console.warn(
            `[AnchorGifts-Tauri] 已退避重试 ${QUOTA_BACKOFF_MS.length} 次仍被 412 限流，本轮收尾：已抓 ${allRecords.length} 条，待补拉 ${partialStarts.length + unknownStarts.length} 个月份，请稍后手动刷新续拉（或在「重建数据」卡片里把抓取速度调低）`,
          );
          aborted = true;
          break;
        }

        // 单轮未知月份过多（连首页都拿不到）→ 保守中断本轮：
        // end_date 保持本次扫描起点（绝不推进），已取到的记录照常保存，下一轮从同一范围重来。
        if (unknownStarts.length >= MAX_UNKNOWN_MONTHS_PER_RUN) {
          console.warn(
            `[AnchorGifts-Tauri] 本轮已有 ${unknownStarts.length} 个月份获取失败（≥${MAX_UNKNOWN_MONTHS_PER_RUN}），保守中断并保持 end_date=${startDate}`,
          );
          aborted = true;
          break;
        }
      }

      // 保守中断（未知月份过多）：end_date 保持本次扫描起点，绝不推进，下一轮从同一范围重来。
      if (aborted) {
        // 必须把本轮的未知月份/待补拉月份一并写入 empty_counts，否则下一轮找不到它们，
        // 既不会补拉，也不会关闭"提前停翻"开关（尾部数据会被永久跳过）。
        const abortedEmptyCounts: Record<string, number> = { ...(meta?.empty_counts ?? {}) };
        for (const s of [...partialStarts, ...unknownStarts]) {
          abortedEmptyCounts[s] = (abortedEmptyCounts[s] ?? 0) + 1;
        }
        allRecords = allRecords.sort((a, b) => b.time.localeCompare(a.time));
        await saveRecordsWithMeta(platform, session.mid, allRecords, {
          end_date: startDate,
          total_page: (meta?.total_page ?? 0) + fetchedNewPages,
          last_fetch: getBeijingTime(),
          empty_counts: abortedEmptyCounts,
          noRevenue: meta?.noRevenue ?? false,
          scan_from: meta?.scan_from,
        });
        console.log(`[AnchorGifts-Tauri] 保守中断：end_date 保持 ${startDate}（不推进），总计 ${allRecords.length} 条`);
      } else {
        // empty_counts：有数据的月份清零，可疑空月份累加；只有仍低于上限的空月份才挡住 end_date（供下轮补拉），
        // 达到上限视为真无数据放行，避免 end_date 永不推进导致死循环。
        const nextEmptyCounts: Record<string, number> = { ...(meta?.empty_counts ?? {}) };
        // 首个有数据月份之前的历史月份 = 账号尚未开播，真·无数据且响应与假空无法区分（都是 code=0/total_page=0）。
        // 若也计入 empty_counts 会把 end_date 钉到最早月份、每次全量重拉并反复重试这些月份，代价过大；
        // 故对于开播之前的无历史月份一律不计数、不补拉。
        // （边角：若账号真正的首播月本次恰好被限流假空，该月会被当作无历史跳过——
        //  少见且可通过手动"重建数据库"重新获得机会，权衡下值得。）
        const firstDataIndex = firstDataIndexOf();
        for (let ci = 0; ci < chunkResults.length; ci++) {
          const result = chunkResults[ci];
          const start = chunks[ci]?.start;
          if (!result || !start) continue;
          if (firstDataIndex !== -1 && ci < firstDataIndex) continue;
          if (result.empty) {
            nextEmptyCounts[start] = (nextEmptyCounts[start] ?? 0) + 1;
          } else if (result.hasData && !result.interrupted) {
            // "完整翻完"的月份才清除补拉标记（该月页数已全部取到，即使本次没有新增记录——
            // 断点续拉从缺失页接着翻完时，前面的页都是已有记录，records 可能为 0）；
            // 被 412 打断的部分完成月份必须保留标记，否则下轮会跳过它、尾部数据永久缺失。
            delete nextEmptyCounts[start];
          }
        }
        // 只保留"本次获取范围内、且位于首个有数据月份之后"的可疑空月份。
        // 其余（开播前的无历史月份、或已超出本次范围的过期残留）一律清除——
        // 否则历史残留会永久钉住 end_date 为最早月份，导致每次重开都从3年前全量重拉，
        // 甚至手动改写 end_date 也会被残留计数重新覆盖回旧月份。
        const rangeStarts = new Set(chunks.map((c) => c.start));
        const minDataStart = firstDataIndex !== -1 ? chunks[firstDataIndex].start : null;
        const prunedEmptyCounts: Record<string, number> = {};
        for (const [s, c] of Object.entries(nextEmptyCounts)) {
          if (s && rangeStarts.has(s) && (minDataStart === null || s >= minDataStart)) {
            prunedEmptyCounts[s] = c;
          }
        }
        // 本轮"未知月份"（拉取失败）必须计入：它们不是"无数据"，只是没抓到，
        // 需要挡住 end_date 供下一轮补拉（超过 MAX_CONSECUTIVE_EMPTY_RUNS 才放弃，防死循环）。
        // 不套用 minDataStart 过滤——失败的月份可能比已知最早的收益月份还早，
        // 若被过滤掉，end_date 推进会把这些月份永久跳过。
        // 被 412 打断的部分完成月份同理：必须挡住 end_date 供下一轮把它补完。
        for (const s of partialStarts) {
          prunedEmptyCounts[s] = (prunedEmptyCounts[s] ?? 0) + 1;
        }
        for (const s of unknownStarts) {
          prunedEmptyCounts[s] = (prunedEmptyCounts[s] ?? 0) + 1;
        }
        const suspiciousEmptyStarts = chunks
          .map((c) => c.start)
          .filter((s) => {
            const c = prunedEmptyCounts[s] ?? 0;
            // 只有真正被判空过的月份（次数>=1）且仍低于上限的，才需要挡住 end_date 补拉。
            // 有数据的月份不在 empty_counts 里（count=0），绝不能当作可疑空，否则 end_date 会被钉在最早月份导致每次全量重拉。
            return s && c >= 1 && c < MAX_CONSECUTIVE_EMPTY_RUNS;
          });
        const nextEndDate = suspiciousEmptyStarts.length > 0
          ? suspiciousEmptyStarts.sort()[0]
          : yesterdayStr;

        // noRevenue 仅由首探短路判定置位（见上文），此处沿用已持久化的标记，不再重复判定。
        // end_date 的推进：没有"待补拉/可疑空"的月份时直接推进到昨天（本轮范围已抓完），
        // 否则钉在最早的那个月份上供下轮续拉。
        // scan_from 语义 = "从该日期起的历史已确认完整"：仅当本轮从 B站 保留边界起步
        // （真正覆盖全部可得历史）且无未知月份时才写入首次值；增量轮次不写入，避免把
        // scan_from 标成近期日期而使"历史缺失自愈"判据失效。
        const coveredFullHistory = startDate <= retentionBoundary && unknownStarts.length === 0 && partialStarts.length === 0;
        allRecords = allRecords.sort((a, b) => b.time.localeCompare(a.time));
        await saveRecordsWithMeta(platform, session.mid, allRecords, {
          end_date: nextEndDate,
          total_page: (meta?.total_page ?? 0) + fetchedNewPages,
          last_fetch: getBeijingTime(),
          empty_counts: prunedEmptyCounts,
          noRevenue: meta?.noRevenue ?? false,
          scan_from: meta?.scan_from ?? (coveredFullHistory ? startDate : undefined),
        });
        if (suspiciousEmptyStarts.length > 0) {
          console.log(`[AnchorGifts-Tauri] 获取完成: end_date 保留在最早可疑空月份 ${nextEndDate}（共${suspiciousEmptyStarts.length}个待补拉），总计 ${allRecords.length} 条`);
        } else {
          console.log(`[AnchorGifts-Tauri] 获取完成: 推进到昨天，总计 ${allRecords.length} 条`);
        }
      }

      // 带回本轮收尾状态：412 退避耗尽时前端提示用户稍后刷新续拉（配合断点续拉逐轮补齐）
      quotaExhausted = _quotaHitThisRun;
      pendingMonths = partialStarts.length + unknownStarts.length;
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
    // 浪漫城堡按粉丝统计
    const blindBoxCastleMap = new Map<number, Map<number, { uname: string; records: string[] }>>();

    // 盲盒配置与反向映射
    const blindBoxConfig: EffectiveBlindBoxConfig = await getEffectiveBlindBoxConfig(platform);
    const activityBoxIds = blindBoxConfig.current_activity_blind_box_ids ?? [];
    const extraProfitIds = (blindBoxConfig.profitIds ?? []).filter((id) => !activityBoxIds.includes(id));
    const blindBoxIds = [...activityBoxIds, ...extraProfitIds];
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
      if (needsBlindBoxInfo && !fast && session.source !== "server") {
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

        // 浪漫城堡按粉丝统计（records 存完整时间戳）
        if (r.gift_id === CASTLE_GIFT_ID) {
          let castleFanMapForBB = blindBoxCastleMap.get(bbId);
          if (!castleFanMapForBB) {
            castleFanMapForBB = new Map();
            blindBoxCastleMap.set(bbId, castleFanMapForBB);
          }
          let castleFan = castleFanMapForBB.get(r.uid);
          if (castleFan) {
            castleFan.records.push(r.time);
          } else {
            castleFanMapForBB.set(r.uid, { uname: r.uname, records: [r.time] });
          }
        }
      }
    }

    // 盲盒粉丝下拉列表：仅按时间段过滤（不受已选粉丝影响）。
    // 否则选中某位粉丝后 filteredRecords 只剩该粉丝，anchors 也只剩一条，
    // 再次点开下拉框就无法看到其他粉丝（修复：下拉列表只剩一位的问题）。
    const blindBoxFanMapAll = new Map<number, Map<number, { uname: string; count: number }>>();
    if (fanUids.length > 0) {
      for (const r of allRecords) {
        if (dateFilter) {
          const t = new Date(r.time).getTime();
          if (t < dateFilter.start.getTime() || t >= dateFilter.end.getTime()) continue;
        }
        const bbIdAll = giftIdToBlindBoxId.get(r.gift_id);
        if (bbIdAll === undefined) continue;
        let fanMapForBBAll = blindBoxFanMapAll.get(bbIdAll);
        if (!fanMapForBBAll) {
          fanMapForBBAll = new Map();
          blindBoxFanMapAll.set(bbIdAll, fanMapForBBAll);
        }
        const fanBBAll = fanMapForBBAll.get(r.uid);
        if (fanBBAll) {
          fanBBAll.count += r.num;
        } else {
          fanMapForBBAll.set(r.uid, { uname: r.uname, count: r.num });
        }
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

      const fanMapForBB = fanUids.length > 0
        ? (blindBoxFanMapAll.get(blindBoxId) ?? blindBoxFanMap.get(blindBoxId))
        : blindBoxFanMap.get(blindBoxId);
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

      // 浪漫城堡按粉丝统计（与 route.ts 一致）
      const castleFanMapForBB = blindBoxCastleMap.get(blindBoxId);
      const castleFans = castleFanMapForBB
        ? Array.from(castleFanMapForBB.entries())
            .map(([uid, v]) => ({
              uid: Number(uid),
              uname: v.uname,
              face: "",
              count: v.records.length,
              records: v.records.slice().sort((a, b) => b.localeCompare(a)),
            }))
            .sort((a, b) => b.records[0].localeCompare(a.records[0]))
        : [];

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
        castleFans,
      });
    }

    // 兼容旧版
    const blindBoxProfit = blindBoxProfits.length > 0 ? blindBoxProfits[0] : null;

    // 按名称合并同一种礼物（B站礼物 ID 随版本变更，旧 ID 与新 ID 同名礼物合并为一条，
    // 代表 ID 优先取当前目录有效的 ID，图标缺失时按名称回退）
    const giftSummary = buildGiftSummary(
      Array.from(giftMap.entries()).map(([gift_id, v]) => ({ gift_id, ...v })),
      (gift_id, name) => getGiftImg(gift_id) || getGiftImgByName(name),
    );

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
      giftTypes: giftSummary.length,
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
      // 本次已判定无收益（或此前已标记）：供前端立即隐藏主播页
      noRevenue: markedNoRevenue || (meta?.noRevenue ?? false),
      fetchedNewPages,
      yesterdayAvailable,
      quotaExhausted,
      pendingMonths,
    };

    return { code: 0, message: "ok", data };
  } catch (err: any) {
    console.error("[AnchorGifts-Tauri] 获取礼物流水失败:", err?.message || err);
    return { code: 500, message: `获取礼物流水失败: ${err?.message || String(err)}`, data: null };
  }
  } finally {
    _quotaWaitReporter = null;
    if (acquired) _fetchingGlobal = false;
  }
}
