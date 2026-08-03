import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { loadGiftDb, saveGiftsToDb } from "@/lib/gift-db";
import { getEffectiveBlindBoxConfig } from "@/lib/config-override";
import { getAllBlindBoxInfo, saveBlindBoxInfo, type BlindBoxInfo } from "@/lib/blind-box-db";
import { checkBlindBox } from "@/lib/bilibili/gift-api";
import { buildMockAnchorGiftsResponse } from "@/lib/revenue";
import { getBuvidCookie } from "@/lib/bilibili/client";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// ==================== 类型定义 ====================

/** B站 API 返回的原始礼物记录 */
type BiliGiftRecord = {
  uid: number;
  uname: string;
  time: string;       // "2026-07-23 16:30:24"
  goods_id: number;
  gift_id: number;
  name: string;
  num: number;
  hamster: number;     // 主播收益（金仓鼠）
  receive_title: string;
  room_id: number;
};

type BiliGiftStreamResponse = {
  code: number;
  message: string;
  ttl: number;
  data?: {
    ready: number;
    total_page: number;
    total_count: number;
    list: BiliGiftRecord[];
    total_hamster: number;
  };
};

/** 本地存储的记录格式 */
type GiftRecord = BiliGiftRecord;

/** 记录文件中存储的元数据（与records合并到一个文件） */
type RecordsMetaData = {
  end_date: string;       // 已获取到的截止日期，如 "20260801"
  last_fetch: string;     // 最后一次获取时间
  total_page: number;     // 累计获取页数
};

// ==================== 常量 ====================

const DATA_DIR = path.join(process.cwd(), ".data");
const GIFT_STREAM_API = "https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getReceivedGiftStream";

// ==================== 工具函数 ====================

function getRecordsDir(mid: number, uname: string): string {
  const safeName = uname.replace(/[\\/:*?"<>|]/g, "_");
  return path.join(DATA_DIR, `uid_${mid}_${safeName}`);
}

async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // 目录已存在
  }
}

function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

/** 获取当前时间的北京时间日期组件 */
function getBeijingDate(date: Date = new Date()): { year: number; month: number; day: number } {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + 8 * 3600000);
  return {
    year: beijing.getFullYear(),
    month: beijing.getMonth(),
    day: beijing.getDate(),
  };
}

/** 获取昨天的 YYYYMMDD（B站 API 不支持查询当天） */
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

/** 获取指定日期前一天的 YYYYMMDD */
function getDayBeforeStr(dateStr: string): string {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(4, 6)) - 1;
  const d = Number(dateStr.slice(6, 8));
  const dObj = new Date(Date.UTC(y, m, d));
  dObj.setUTCDate(dObj.getUTCDate() - 1);
  const py = dObj.getUTCFullYear();
  const pm = String(dObj.getUTCMonth() + 1).padStart(2, "0");
  const pd = String(dObj.getUTCDate()).padStart(2, "0");
  return `${py}${pm}${pd}`;
}

/** 检测指定日期在 B站 API 中是否有数据 */
async function checkDateAvailable(
  cookie: string,
  csrf: string,
  dateStr: string,
): Promise<boolean> {
  try {
    const result = await fetchGiftStreamPage(cookie, csrf, 0, dateStr, dateStr);
    return result.code === 0 && (result.data?.total_page ?? 0) > 0;
  } catch {
    return false;
  }
}

/** YYYYMMDD -> Date（北京时间） */
function parseDateStr(s: string): Date {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  // 返回北京时间对应的 UTC 时间
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

/** 从 "2026-07-23 16:30:24" 提取日期部分 YYYY-MM-DD */
function getDatePart(time: string): string {
  return time.split(" ")[0];
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

/** 计算任意365天内的最大活跃天数 */
function calcMaxDaysInYear(sortedDates: string[]): { max: number; start: string; end: string } {
  if (sortedDates.length === 0) return { max: 0, start: "", end: "" };

  let maxCount = 1;
  let maxStart = sortedDates[0];
  let maxEnd = sortedDates[0];

  let left = 0;
  for (let right = 0; right < sortedDates.length; right++) {
    const leftDate = new Date(sortedDates[left]);
    const rightDate = new Date(sortedDates[right]);
    let diffDays = Math.round((rightDate.getTime() - leftDate.getTime()) / 86400000);

    while (diffDays > 365) {
      left++;
      const newLeftDate = new Date(sortedDates[left]);
      diffDays = Math.round((rightDate.getTime() - newLeftDate.getTime()) / 86400000);
      if (diffDays <= 365) break;
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

// ==================== 存储操作 ====================

function getRecordsFilePath(mid: number, uname: string): string {
  return path.join(getRecordsDir(mid, uname), "anchor-gifts-records.json");
}

/** 旧版metadata文件路径（用于迁移） */
function getOldMetadataFilePath(mid: number, uname: string): string {
  return path.join(getRecordsDir(mid, uname), "anchor-gifts-metadata.json");
}

/** 读取记录和元数据（合并存储后统一读取，兼容旧版分离文件） */
async function readRecordsWithMeta(mid: number, uname: string): Promise<{ records: GiftRecord[]; meta: RecordsMetaData | null }> {
  const filePath = getRecordsFilePath(mid, uname);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const records: GiftRecord[] = Array.isArray(parsed) ? parsed : (parsed.records ?? []);
    // 新格式：元数据内嵌在records文件中
    if (parsed.end_date !== undefined) {
      return {
        records,
        meta: {
          end_date: parsed.end_date ?? "",
          last_fetch: parsed.last_fetch ?? parsed.exportedAt ?? "",
          total_page: parsed.total_page ?? 0,
        },
      };
    }
    // 旧格式：records文件无元数据，尝试从独立的metadata文件迁移
    const oldMeta = await tryReadOldMetadata(mid, uname);
    return { records, meta: oldMeta };
  } catch {
    // records文件不存在，尝试从独立的metadata文件迁移
    const oldMeta = await tryReadOldMetadata(mid, uname);
    return { records: [], meta: oldMeta };
  }
}

/** 读取旧版独立metadata文件（迁移用） */
async function tryReadOldMetadata(mid: number, uname: string): Promise<RecordsMetaData | null> {
  const filePath = getOldMetadataFilePath(mid, uname);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      end_date: parsed.end_date ?? "",
      last_fetch: parsed.last_fetch ?? "",
      total_page: parsed.total_page ?? 0,
    };
  } catch {
    return null;
  }
}

/** 保存记录和元数据到同一个文件，并删除旧版metadata文件 */
async function saveRecordsWithMeta(mid: number, uname: string, records: GiftRecord[], meta: RecordsMetaData) {
  const dir = getRecordsDir(mid, uname);
  await ensureDir(dir);
  const filePath = getRecordsFilePath(mid, uname);
  const data = {
    last_fetch: meta.last_fetch,
    end_date: meta.end_date,
    total_page: meta.total_page,
    total_count: records.length,
    records,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  // 删除旧版metadata文件（如果存在）
  const oldMetaPath = getOldMetadataFilePath(mid, uname);
  try {
    await fs.unlink(oldMetaPath);
  } catch {
    // 文件不存在则忽略
  }
}

// ==================== API 调用 ====================

/** 调用 B站 礼物流水 API（单页） */
async function fetchGiftStreamPage(
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

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://live.bilibili.com/",
    "Origin": "https://live.bilibili.com",
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": fullCookie,
  };

  // 仅 page=0 输出请求日志，避免翻页日志淹没终端
  if (page === 0) {
    console.log(`[AnchorGifts][API] 请求 page=0 begin=${beginDate} end=${endDate} csrf=${csrf ? "***" : "(空)"} buvid=${buvidCookie ? "有" : "无"}`);
  }

  const response = await fetch(GIFT_STREAM_API, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[AnchorGifts][API] HTTP ${response.status}: ${text.slice(0, 500)}`);
    throw new Error(`B站礼物流水 API HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = (await response.json()) as BiliGiftStreamResponse;
  // 仅 page=0 输出响应日志
  if (page === 0) {
    const listLen = result.data?.list?.length ?? 0;
    const totalPage = result.data?.total_page ?? -1;
    const totalCount = result.data?.total_count ?? -1;
    console.log(`[AnchorGifts][API] 响应 page=0: code=${result.code} message="${result.message}" total_page=${totalPage} total_count=${totalCount} list_len=${listLen} total_hamster=${result.data?.total_hamster ?? "?"}`);
  }
  return result;
}

// ==================== 数据处理 ====================

/** 记录唯一标识（用于比较，非去重） */
function recordKey(r: GiftRecord): string {
  return `${r.time}_${r.uid}_${r.gift_id}_${r.num}`;
}

/** 连续匹配阈值：连续 N 条记录都匹配已有数据时，认为已到达已有数据边界，停止翻页 */
const CONSECUTIVE_MATCH_THRESHOLD = 5;

/** 并发获取月度数据的并发数 */
const MONTH_CONCURRENCY = 1;

/** 页面请求失败时的重试次数（page=0用5次，翻页用3次） */
const PAGE_RETRY_COUNT = 3;
const PAGE0_RETRY_COUNT = 5;

/** 连续请求间隔（ms），避免触发B站限流 */
const REQUEST_INTERVAL_MS = 1500;

/** 412限流后的冷却间隔（ms） */
const RATE_LIMIT_COOLDOWN_MS = 30_000;

/** 412限流后恢复翻页的慢速间隔（ms） */
const SLOW_REQUEST_INTERVAL_MS = 4000;

/** 月度数据获取失败时抛出的错误，携带失败的月份范围 */
class MonthFetchError extends Error {
  constructor(
    public begin: string,
    public end: string,
    message: string,
  ) {
    super(`[${begin}~${end}] ${message}`);
    this.name = "MonthFetchError";
  }
}

/**
 * 带并发限制的并行执行。
 * 遇到第一个错误时立即停止所有 worker，返回已完成的结果和错误。
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ results: R[]; firstError?: Error }> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let firstError: Error | undefined;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err: any) {
        firstError = err;
        stopped = true;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return { results, firstError };
}

/**
 * 构建已有记录的 key 计数器。
 * 使用 Map 而非 Set 是因为同一 key 可能对应多条真实记录（如同时发送多个相同礼物），
 * Set 无法区分"已有1条"和"已有2条"，会导致新记录被误判为已有数据。
 */
function buildRecordKeyCounter(records: GiftRecord[]): Map<string, number> {
  const counter = new Map<string, number>();
  for (const r of records) {
    const key = recordKey(r);
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }
  return counter;
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
 * 使用纯数字计算，避免时区问题，正确处理闰年2月29日
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
    // 首月使用精确起始日（如 20260610），后续月份从 01 开始
    const startDay = isFirst ? String(bd).padStart(2, "0") : "01";
    const start = `${y}${String(m).padStart(2, "0")}${startDay}`;
    isFirst = false;
    // 使用真实日历获取当月最后一天（Date.UTC(month, 0) 返回上个月最后一天，month 是 1-indexed）
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let endDay: string;
    if (y === ey && m === em) {
      // 最后一个月，使用 end 的日期
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

// ==================== GET Handler ====================

export async function GET(request: Request) {
  // 认证：优先 cookie，fallback 到 query 参数（Tauri WebView 可能不发送 cookie）
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  console.log(`[AnchorGifts] 收到请求, cookie header 长度: ${cookieHeader.length}`);
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  // fallback: query 参数 _sid
  if (!sid) {
    sid = url.searchParams.get("_sid") ?? null;
    if (sid) console.log(`[AnchorGifts] 从 query 参数获取 sid: ${sid.substring(0, 8)}...`);
  }
  console.log(`[AnchorGifts] sid 匹配: ${sid ? sid.substring(0, 8) + "..." : "(null)"}`);
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    console.log(`[AnchorGifts] 未找到 session，返回模拟数据`);
    const mockData = buildMockAnchorGiftsResponse();
    return NextResponse.json(
      { code: 0, message: "mock", data: mockData },
      { status: 200 },
    );
  }

  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    console.log(`[AnchorGifts] B站凭证失效，返回模拟数据`);
    const mockData = buildMockAnchorGiftsResponse();
    return NextResponse.json(
      { code: 0, message: "needs-relogin", data: mockData },
      { status: 200 },
    );
  }

  const validSession = credentialResult.session;
  const biliCookie = credentialResult.cookie;
  const csrf = biliCookie.match(/bili_jct=([a-f0-9]+)/)?.[1] || "";
  console.log(`[AnchorGifts] 认证通过: mid=${validSession.mid} uname=${validSession.uname} csrf=${csrf ? "***" : "(空)"} cookie_len=${biliCookie.length}`);

  // 解析查询参数
  const refresh = url.searchParams.get("refresh") === "true";
  const dateRangeFilter = url.searchParams.get("dateRange") ?? "all";
  const fanFilter = url.searchParams.get("fan") ?? "";

  try {
    // 读取已有记录和元数据（合并存储）
    const { records: existingRecords, meta } = await readRecordsWithMeta(validSession.mid, validSession.uname);

    let allRecords = existingRecords;
    let fetchedNewPages = 0;

    const yesterdayStr = getYesterdayStr();

    // 不额外调用 checkDateAvailable（避免增加请求触发限流），
    // 从拉取到的记录中判断昨日是否有数据
    let yesterdayAvailable = true;

    /** 获取指定月份(payload按整个自然月)内的所有记录，自动翻页 */
    async function fetchRange(begin: string, end: string, existingKeyCounter?: Map<string, number>, buvidCookie?: string): Promise<{ records: GiftRecord[]; pages: number }> {
      const records: GiftRecord[] = [];
      let rateLimited = false; // 412限流标记，触发后切换慢速模式

      // 带重试的页面请求，网络错误/412限流时使用指数退避
      async function fetchPageWithRetry(page: number, maxRetries: number = PAGE_RETRY_COUNT): Promise<BiliGiftStreamResponse | null> {
        const totalAttempts = maxRetries + 1;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            const result = await fetchGiftStreamPage(biliCookie, csrf, page, begin, end, buvidCookie);
            if (result.code === 0) return result;
            // code=1301000: "不支持查询三年前的数据"——该月数据已过期，跳过（不重试）
            if (result.code === 1301000) {
              console.log(`[AnchorGifts] ${begin}~${end} 第${page}页 code=1301000（数据已过期超过3年），跳过该月`);
              return result;
            }
            // 其他API错误：指数退避
            const delay = 1000 * Math.pow(2, attempt);
            console.error(`[AnchorGifts] ${begin}~${end} 第${page}页 API错误 code=${result.code}，等待${delay}ms后重试${attempt + 1}/${totalAttempts}`);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
          } catch (err: any) {
            const isRateLimit = err?.message?.includes("412");
            if (isRateLimit) {
              // 412限流：先冷却，再以慢速重试
              rateLimited = true;
              const cooldownDelay = RATE_LIMIT_COOLDOWN_MS + attempt * 10_000;
              console.warn(`[AnchorGifts] ${begin}~${end} 第${page}页 触发412限流，冷却${cooldownDelay}ms后进入慢速模式重试${attempt + 1}/${totalAttempts}`);
              await new Promise(r => setTimeout(r, cooldownDelay));
            } else {
              const delay = 1000 * Math.pow(2, attempt);
              console.error(`[AnchorGifts] ${begin}~${end} 第${page}页请求失败，等待${delay}ms后重试${attempt + 1}/${totalAttempts}:`, err);
              if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
            }
          }
        }
        return null;
      }

      // 第0页：total_page 有意义，total_page=0 表示该月无数据
      // page=0 使用更多重试次数（5次），避免因网络波动丢失整个月份
      const firstPage = await fetchPageWithRetry(0, PAGE0_RETRY_COUNT);
      if (!firstPage) {
        throw new MonthFetchError(begin, end, "第0页获取失败（已重试），终止以避免数据缺失");
      }

      // code=1301000: "不支持查询三年前的数据"——该月已过期，跳过
      if (firstPage.code === 1301000) {
        console.log(`[AnchorGifts] ${begin}~${end} code=1301000 message="${firstPage.message}"（数据已过期），跳过该月`);
        return { records, pages: 0 };
      }

      const totalPages = firstPage.data?.total_page ?? 0;
      const totalHamster = firstPage.data?.total_hamster ?? 0;
      const listLen = firstPage.data?.list?.length ?? 0;
      console.log(`[AnchorGifts] ${begin}~${end} 第0页: total_pages=${totalPages} total_hamster=${totalHamster} list_len=${listLen}`);

      // total_page=0 表示该月没有数据，跳过（不是错误）
      if (totalPages === 0) {
        console.log(`[AnchorGifts] ${begin}~${end} 无数据(total_page=0)，跳过`);
        return { records, pages: 0 };
      }

      // 第0页的数据
      if (listLen > 0) {
        records.push(...(firstPage.data?.list ?? []));
      }

      // 翻页：从第1页到第totalPages-1页（0-based，第0页已获取）
      let stoppedEarly = false;
      for (let p = 1; p < totalPages; p++) {
        // 连续匹配检测（有已有数据时启用）
        if (existingKeyCounter && records.length >= CONSECUTIVE_MATCH_THRESHOLD) {
          const lastN = records.slice(-CONSECUTIVE_MATCH_THRESHOLD);
          const allMatch = lastN.every(r => {
            const key = recordKey(r);
            return (existingKeyCounter.get(key) ?? 0) > 0;
          });
          if (allMatch) {
            console.log(`[AnchorGifts] ${begin}~${end} 连续 ${CONSECUTIVE_MATCH_THRESHOLD} 条匹配已有数据，停止翻页（已获取 ${records.length} 条）`);
            stoppedEarly = true;
            break;
          }
        }

        // 请求间隔：412限流后使用慢速间隔
        const interval = rateLimited ? SLOW_REQUEST_INTERVAL_MS : REQUEST_INTERVAL_MS;
        await new Promise(r => setTimeout(r, interval));

        const pageResult = await fetchPageWithRetry(p);
        if (pageResult?.data?.list) {
          if (pageResult.data.list.length > 0) {
            records.push(...pageResult.data.list);
          }
        } else {
          throw new MonthFetchError(begin, end, `第${p}页获取失败（已重试），终止以避免数据缺失`);
        }
      }
      const pages = stoppedEarly ? 1 : totalPages;
      return { records, pages };
    }

    // ==================== 统一获取逻辑 ====================
    // 只用 end_date 决定起始日期：
    // - end_date 为空或文件不存在 → 首次使用，从3年前下个月开始（如2026年8月→2023年9月）
    // - end_date 不为空 → 从 end_date 开始增量获取
    // refresh=true 只是代表用户手动触发，不影响起始日期判断
    const startDate = (() => {
      if (meta?.end_date) {
        console.log(`[AnchorGifts] 起始日期：使用 end_date=${meta.end_date}${refresh ? " (用户手动触发)" : ""}`);
        return meta.end_date;
      }
      // 首次使用：B站最多保存3年数据，从3年前的下个月开始
      // 如当前2026年8月 → 2023年9月（8月数据可能已过期）
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const beijing = new Date(utc + 8 * 3600000);
      const startYear = beijing.getFullYear() - 3;
      const startMonth = beijing.getMonth() + 1; // 0-indexed → 1-indexed (1~12)
      // 下个月：12月 → 次年1月
      const beginYear = startMonth === 12 ? startYear + 1 : startYear;
      const beginMonth = startMonth === 12 ? 1 : startMonth + 1;
      const beginDate = `${beginYear}${String(beginMonth).padStart(2, "0")}01`;
      console.log(`[AnchorGifts] 首次使用：起始日期=${beginDate}（当前${beijing.getFullYear()}年${startMonth}月 → 3年前${startYear}年${startMonth}月 → 下个月${beginYear}年${beginMonth}月）${refresh ? " (用户手动触发)" : ""}`);
      return beginDate;
    })();

    if (startDate > yesterdayStr) {
      console.log(`[AnchorGifts] 无需获取，startDate=${startDate} > yesterdayStr=${yesterdayStr}`);
      fetchedNewPages = 0;
    } else {
      // 获取 buvid3 反爬Cookie
      const buvidCookie = await getBuvidCookie().catch(() => "");

      const chunks = generateMonthChunks(startDate, yesterdayStr);
      console.log(`[AnchorGifts] 获取数据: ${startDate} ~ ${yesterdayStr}, 共${chunks.length}个月, 并发数=${MONTH_CONCURRENCY}${buvidCookie ? ", buvid=有" : ", buvid=无"}`);

      const existingKeyCounter = existingRecords.length > 0 ? buildRecordKeyCounter(existingRecords) : undefined;
      let hasNewRecords = false;

      // 并行获取各月数据
      const { results: chunkResults, firstError } = await runWithConcurrency(chunks, MONTH_CONCURRENCY, async (chunk) => {
        console.log(`[AnchorGifts] 获取分段: ${chunk.start} ~ ${chunk.end}`);
        return await fetchRange(chunk.start, chunk.end, existingKeyCounter, buvidCookie);
      });

      // 合并结果并去重
      fetchedNewPages = 0;
      for (const result of chunkResults) {
        if (!result) continue;
        fetchedNewPages += result.pages;
        for (const r of result.records) {
          if (existingKeyCounter) {
            const key = recordKey(r);
            const existingCount = existingKeyCounter.get(key) ?? 0;
            if (existingCount > 0) {
              existingKeyCounter.set(key, existingCount - 1);
              continue;
            }
          }
          existingRecords.push(r);
          hasNewRecords = true;
        }
      }

      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));

      const prevTotalPage = meta?.total_page ?? 0;

      // 如果中途有月份失败，标记失败月份起始日为截止点，下次从该月继续
      if (firstError instanceof MonthFetchError) {
        const failedBegin = firstError.begin;
        console.error(`[AnchorGifts] 获取中途失败: ${firstError.message}，安全failedBegin=${failedBegin}`);
        await saveRecordsWithMeta(validSession.mid, validSession.uname, allRecords, {
          total_page: prevTotalPage + fetchedNewPages,
          end_date: failedBegin,
          last_fetch: getBeijingTime(),
        });
        console.log(`[AnchorGifts] 获取部分完成: ${fetchedNewPages} 页, 新增记录 ${hasNewRecords ? "有" : "无"}, 总计 ${allRecords.length} 条（截止 ${failedBegin}）`);
      } else {
        await saveRecordsWithMeta(validSession.mid, validSession.uname, allRecords, {
          total_page: prevTotalPage + fetchedNewPages,
          end_date: yesterdayStr,
          last_fetch: getBeijingTime(),
        });
        console.log(`[AnchorGifts] 获取完成: ${fetchedNewPages} 页, 新增记录 ${hasNewRecords ? "有" : "无"}, 总计 ${allRecords.length} 条`);
      }
    }

    // 从拉取到的记录中判断昨日是否有数据（避免额外API调用触发限流）
    if (allRecords.length > 0) {
      const yesterdayDate = yesterdayStr.slice(0, 4) + "-" + yesterdayStr.slice(4, 6) + "-" + yesterdayStr.slice(6, 8);
      yesterdayAvailable = allRecords.some(r => r.time.startsWith(yesterdayDate));
      if (!yesterdayAvailable) {
        console.log(`[AnchorGifts] 昨日(${yesterdayStr})无数据，官方可能尚未更新`);
      }
    }

    // 应用筛选
    const dateFilter = getDateRangeFilter(dateRangeFilter);
    const fanUids = fanFilter
      ? fanFilter.split(",").map(s => Number(s.trim())).filter(n => !isNaN(n))
      : [];

    const filteredRecords = allRecords.filter(r => {
      if (dateFilter) {
        const t = new Date(r.time).getTime();
        if (t < dateFilter.start.getTime() || t >= dateFilter.end.getTime()) return false;
      }
      if (fanUids.length > 0 && !fanUids.includes(r.uid)) return false;
      return true;
    });

    // ==================== 计算统计数据（camelCase 输出，匹配前端） ====================

    // 礼物汇总
    const giftMap = new Map<number, { name: string; num: number; hamster: number }>();
    // 粉丝分布
    const fanMap = new Map<number, { uname: string; hamster: number; giftCount: number; dateSet: Set<string> }>();
    // 月度汇总
    const monthlyMap = new Map<string, { hamster: number; count: number }>();
    // 日期集合
    const dateSet = new Set<string>();

    let totalHamster = 0;

    // 盲盒统计：记录每种盲盒的接收次数和收益
    const blindBoxCountMap = new Map<number, { num: number; hamster: number }>();
    // 盲盒内各礼物分别计数
    const blindBoxGiftCountMap = new Map<number, Map<number, { name: string; num: number; hamster: number }>>();
    // 盲盒粉丝统计
    const blindBoxFanMap = new Map<number, Map<number, { uname: string; count: number }>>();
    // 盲盒日期集合
    const blindBoxDateSet = new Map<number, Set<string>>();

    // 获取盲盒配置和反向映射（必须在循环之前）
    const blindBoxConfig = await getEffectiveBlindBoxConfig();
    const blindBoxIds = blindBoxConfig.current_activity_blind_box_ids ?? [];
    const allBlindBoxInfo = await getAllBlindBoxInfo(0, "");

    // 如果本地没有盲盒信息，尝试从B站API获取（参考粉丝页盲盒盈亏的实现）
    for (const blindBoxId of blindBoxIds) {
      if (!allBlindBoxInfo[blindBoxId]) {
        try {
          console.log(`[AnchorGifts] 本地无盲盒 ${blindBoxId} 信息，尝试从B站API获取...`);
          const checkResult = await checkBlindBox(blindBoxId, biliCookie);
          if (checkResult) {
            await saveBlindBoxInfo(validSession.mid, validSession.uname, blindBoxId, {
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
            console.log(`[AnchorGifts] 盲盒 ${blindBoxId}(${checkResult.blindGiftName}) 信息获取成功，包含 ${checkResult.gifts.length} 个礼物`);
          } else {
            console.log(`[AnchorGifts] 盲盒 ${blindBoxId} API返回为空，可能已过期`);
          }
        } catch (err) {
          console.error(`[AnchorGifts] 获取盲盒 ${blindBoxId} 信息失败:`, err);
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
      const existing = giftMap.get(r.gift_id);
      if (existing) {
        existing.num += r.num;
        existing.hamster += r.hamster;
      } else {
        giftMap.set(r.gift_id, { name: r.name, num: r.num, hamster: r.hamster });
      }

      // 粉丝分布（按 UID 合并，记录按时间降序，首次遇到的是最新记录，取最新昵称）
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

      // 月度汇总 (YYYYMM 格式，匹配前端)
      const d = new Date(r.time);
      const monthKey = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthly = monthlyMap.get(monthKey);
      if (monthly) {
        monthly.hamster += r.hamster;
        monthly.count += r.num;
      } else {
        monthlyMap.set(monthKey, { hamster: r.hamster, count: r.num });
      }

      // 盲盒统计：通过反向映射判断该礼物是否属于某个盲盒内的礼物
      const bbId = giftIdToBlindBoxId.get(r.gift_id);
      if (bbId !== undefined) {
        // 盲盒总计数
        const bbExisting = blindBoxCountMap.get(bbId);
        if (bbExisting) {
          bbExisting.num += r.num;
          bbExisting.hamster += r.hamster;
        } else {
          blindBoxCountMap.set(bbId, { num: r.num, hamster: r.hamster });
        }

        // 盲盒内各礼物分别计数
        let giftMapForBB = blindBoxGiftCountMap.get(bbId);
        if (!giftMapForBB) {
          giftMapForBB = new Map();
          blindBoxGiftCountMap.set(bbId, giftMapForBB);
        }
        const giftExisting = giftMapForBB.get(r.gift_id);
        if (giftExisting) {
          giftExisting.num += r.num;
          giftExisting.hamster += r.hamster;
        } else {
          giftMapForBB.set(r.gift_id, { name: r.name, num: r.num, hamster: r.hamster });
        }

        // 盲盒粉丝统计
        let fanMapForBB = blindBoxFanMap.get(bbId);
        if (!fanMapForBB) {
          fanMapForBB = new Map();
          blindBoxFanMap.set(bbId, fanMapForBB);
        }
        const fanExisting = fanMapForBB.get(r.uid);
        if (fanExisting) {
          fanExisting.count += r.num;
        } else {
          fanMapForBB.set(r.uid, { uname: r.uname, count: r.num });
        }

        // 盲盒日期
        let datesForBB = blindBoxDateSet.get(bbId);
        if (!datesForBB) {
          datesForBB = new Set();
          blindBoxDateSet.set(bbId, datesForBB);
        }
        datesForBB.add(getDatePart(r.time));
      }
    }

    // 将盲盒内礼物信息保存到 gift-db，供消费记录显示礼物图片
    for (const info of Object.values(allBlindBoxInfo)) {
      if (info.gifts) {
        await saveGiftsToDb(info.gifts.map(g => ({
          gift_id: g.gift_id,
          name: g.gift_name,
          img: g.gift_img,
        })));
      }
    }

    // 提前加载 giftDb，供下方使用
    const giftDb = loadGiftDb();

    // 同时将所有礼物记录中的礼物名称保存到 gift-db（img 可能为空，后续由 pay-records 填充）
    await saveGiftsToDb(
      Array.from(giftMap.entries()).map(([gift_id, v]) => ({
        gift_id,
        name: v.name,
        img: giftDb.gifts?.[gift_id]?.img ?? "",
      })),
    );

    // 注意：盲盒统计已在上面主循环中通过 giftIdToBlindBoxId 反向映射完成

    // 构建盲盒盈亏数据（数组，支持多种盲盒）
    const blindBoxProfits: Array<{
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
    }> = [];

    for (const blindBoxId of blindBoxIds) {
      const count = blindBoxCountMap.get(blindBoxId);
      const info = allBlindBoxInfo[blindBoxId];
      const boxName = info?.blind_box_name ?? `盲盒_${blindBoxId}`;
      const boxImg = info?.blind_box_img ?? blindBoxConfig.icons[blindBoxId] ?? "";
      const drawCount = count?.num ?? 0;
      const totalHamsterBB = count?.hamster ?? 0;
      // blind_price 单位是电池，乘以50转换为 hamster（收益已/2，成本也需/2）
      const blindPrice = (info?.blind_price ?? 0) * 50;
      const cost = drawCount * blindPrice;

      // 礼物列表：从盲盒信息中获取，实际数量从收益记录中统计
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
            img: giftDb.gifts?.[g.gift_id]?.img ?? g.gift_img ?? "",
          });
        }
      }

      // 粉丝列表（按次数降序）
      const fanMapForBB = blindBoxFanMap.get(blindBoxId);
      const anchors = fanMapForBB
        ? Array.from(fanMapForBB.entries())
            .map(([ruid, v]) => ({ ruid: Number(ruid), rname: v.uname, count: v.count }))
            .sort((a, b) => b.count - a.count)
        : [];

      // 日期范围
      const datesForBB = blindBoxDateSet.get(blindBoxId);
      const sortedDates = datesForBB ? Array.from(datesForBB).sort() : [];
      const dateRange = sortedDates.length > 0
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
        blindPrice: (info?.blind_price ?? 0) / 2,  // 电池单位，/2 与收益对齐
        anchors,
        dateRange,
      });
    }

    // 兼容旧版：blindBoxProfit 指向第一个盲盒（或心动盲盒）
    const blindBoxProfit = blindBoxProfits.length > 0 ? blindBoxProfits[0] : {
      gift_id: 0,
      name: "",
      drawCount: 0,
      totalHamster: 0,
      cost: 0,
      profit: 0,
      gifts: [] as Array<{ gift_id: number; name: string; num: number; hamster: number }>,
      img: "",
    };

    const giftSummary = Array.from(giftMap.entries())
      .map(([gift_id, v]) => ({ gift_id, name: v.name, num: v.num, hamster: v.hamster, img: giftDb.gifts?.[gift_id]?.img ?? "" }))
      .sort((a, b) => b.hamster - a.hamster);

    const fanDistribution = Array.from(fanMap.entries())
      .map(([uid, v]) => ({ uid, uname: v.uname, hamster: v.hamster, giftCount: v.giftCount }))
      .sort((a, b) => b.hamster - a.hamster);

    const monthlyData = Array.from(monthlyMap.entries())
      .map(([month, v]) => ({ month, hamster: v.hamster, count: v.count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // 日期范围
    const sortedDates = Array.from(dateSet).sort();
    const dateRange = sortedDates.length > 0
      ? { start: sortedDates[0], end: sortedDates[sortedDates.length - 1] }
      : null;

    // 粉丝送礼天数统计（含连续天数）
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

    // 连续天数
    const allConsecutive = calcMaxConsecutive(sortedDates);

    const otherStats = {
      dayStats: {
        totalDays: sortedDates.length,
        maxConsecutiveDays: allConsecutive.max,
      },
      fanStats,
    };

    // 构建响应（camelCase 字段）
    const data = {
      totalHamster,
      totalRmb: totalHamster / 100,
      totalCount: filteredRecords.length,
      totalPage: (meta?.total_page ?? 0) + fetchedNewPages,
      giftTypes: giftMap.size,
      fanCount: fanMap.size,
      monthlyData,
      fanDistribution,
      giftSummary,
      dateRange,
      blindBoxProfit,
      blindBoxProfits,
      otherStats,
      records: filteredRecords,
      filter: { dateRange: dateRangeFilter, fan: fanFilter },
      metadata: meta,
      fetchedNewPages: fetchedNewPages,
      yesterdayAvailable,
    };

    console.log(`[AnchorGifts] 返回数据: totalHamster=${totalHamster} totalRmb=${totalHamster/100} totalCount=${filteredRecords.length} giftTypes=${giftMap.size} fanCount=${fanMap.size} dateRange=${dateRange?.start ?? "?"}~${dateRange?.end ?? "?"} otherStats.dayStats.totalDays=${otherStats.dayStats.totalDays} otherStats.fanStats.length=${otherStats.fanStats.length}`);

    return NextResponse.json(
      { code: 0, message: "ok", data },
      { status: 200 },
    );
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error("[AnchorGifts] 获取礼物流水失败:", errMsg);
    console.error("[AnchorGifts] 完整错误:", err);
    return NextResponse.json(
      { code: 500, message: `获取礼物流水失败: ${errMsg}`, data: null },
      { status: 500 },
    );
  }
}