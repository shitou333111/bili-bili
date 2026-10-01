import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential, buildCookieHeader } from "@/lib/bilibili/cookie-refresh";
import { ensureGiftCatalogLoaded, getGiftImg, getGiftImgByName } from "@/lib/gift-catalog";
import { buildGiftSummary } from "@/lib/gift-summary";
import { isOffline } from "@/lib/offline";
import { getEffectiveBlindBoxConfig } from "@/lib/config-override";
import { getAllBlindBoxInfo, saveBlindBoxInfo, type BlindBoxInfo } from "@/lib/blind-box-db";
import { checkBlindBox, getUserInfoByUid } from "@/lib/bilibili/gift-api";
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
  /** 可疑空月份及连续"被判定为空"的次数（key=月份起始YYYYMMDD）。
   *  用于区分"伪空（软限流/冷缓存返回 total_page=0）"与"真无数据"：
   *  只有次数 < MAX_CONSECUTIVE_EMPTY_RUNS 的空月份才挡住 end_date 供下一轮补拉；
   *  达到上限的视为真无数据，放行 end_date，避免 end_date 永不推进导致死循环。 */
  empty_counts?: Record<string, number>;
  /** 首次登录全量探测收益为空 → 判定为无收益/非持续开播主播，置位后跳过后续全量探测 */
  noRevenue?: boolean;
  /**
   * 已"完整覆盖"的最早扫描起点（YYYYMMDD）。仅在本轮无未知月份、未保守中断时写入。
   * 缺失 = 旧版本遗留数据，可能带着"end_date 很新但更早历史从未抓取"的缺失（见历史缺失自愈）。
   */
  scan_from?: string;
};

// ==================== 常量 ====================

const DATA_DIR = path.join(process.cwd(), ".data");
const GIFT_STREAM_API = "https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getReceivedGiftStream";
const ROOM_INFO_API = "https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld";

/** 浪漫城堡礼物 ID（心动盲盒内的特殊大奖） */
const CASTLE_GIFT_ID = 32132;

/** 判断该 mid 是否有直播间（是否为主播）。getRoomInfoOld 为公开接口，无需登录凭证。 */
async function checkAnchorHasRoom(mid: number): Promise<boolean> {
  try {
    const res = await fetch(`${ROOM_INFO_API}?mid=${encodeURIComponent(String(mid))}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      cache: "no-store",
    });
    const data = await res.json();
    // roomStatus: 0 无房 / 1 有房
    return data?.code === 0 && (data?.data?.roomStatus === 1 || (data?.data?.roomid ?? 0) > 0);
  } catch (err) {
    // 查询失败（网络/接口异常）→ 视为可能有房，不阻断（幂等兜底：宁可多拉也不漏）
    console.error(`[AnchorGifts] 检查房间失败，默认视为有房:`, err);
    return true;
  }
}

// ==================== 工具函数 ====================

function getRecordsDir(mid: number, _uname?: string): string {
  return path.join(DATA_DIR, `uid_${mid}`);
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
    if (parsed.end_date !== undefined || parsed.noRevenue !== undefined) {
      return {
        records,
        meta: {
          end_date: parsed.end_date ?? "",
          last_fetch: parsed.last_fetch ?? parsed.exportedAt ?? "",
          total_page: parsed.total_page ?? 0,
          empty_counts: parsed.empty_counts ?? {},
          noRevenue: parsed.noRevenue ?? false,
          scan_from: parsed.scan_from,
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
      empty_counts: parsed.empty_counts ?? {},
      noRevenue: parsed.noRevenue ?? false,
      scan_from: parsed.scan_from,
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
    empty_counts: meta.empty_counts ?? {},
    noRevenue: meta.noRevenue ?? false,
    scan_from: meta.scan_from,
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
  // 412 就地退避重试：撞到限流不再立刻抛给上层收尾，而是按梯度等一会儿重试同一个请求。
  for (let attempt = 0; ; attempt++) {
    await paceRequest();

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
      // 412 = 撞到出口 IP 的 WAF 配额（与凭证、通道无关）：按退避梯度重试同一请求
      if (response.status === 412) {
        if (attempt >= QUOTA_BACKOFF_MS.length) {
          _quotaHitThisRun = true;
          throw new Error(`412 限流：已退避重试 ${attempt} 次仍被拦截`);
        }
        const wait = QUOTA_BACKOFF_MS[attempt];
        console.warn(
          `[AnchorGifts] 撞到 B站 412 限流，退避 ${Math.round(wait / 1000)}s 后重试`
          + `（第 ${attempt + 1}/${QUOTA_BACKOFF_MS.length} 次）：page=${page} begin=${beginDate}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
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
}

// ==================== 数据处理 ====================

/** 记录唯一标识（用于比较，非去重） */
function recordKey(r: GiftRecord): string {
  return `${r.time}_${r.uid}_${r.gift_id}_${r.num}`;
}

/** 连续匹配阈值：连续 N 条记录都匹配已有数据时，认为已到达已有数据边界，停止翻页 */
const CONSECUTIVE_MATCH_THRESHOLD = 5;

/** 服务器端固定抓取速率（req/s）与由它派生的月份并发度。
 *  WEB 端并不把主播收益抓取暴露给用户：普通用户走本地直出，无 B站 Cookie 的账号直接跳过，
 *  真正跑这条路径的只有服务器自身，不存在"多用户共享出口 IP 叠加放大速率"的场景，
 *  因此直接采用客户端默认档 3 req/s（实测可持续阈值边界，30 分钟长测零 412），
 *  不再刻意压到 0.67 req/s。
 *  并发只保证"能喂满节拍"（与客户端 concurrencyForRate 一致），速率为 1 时并发 1 = 完全串行。 */
const TARGET_RATE = 3;
function concurrencyForRate(rate: number): number {
  return Math.min(6, Math.max(1, Math.round(rate)));
}
const MONTH_CONCURRENCY = concurrencyForRate(TARGET_RATE);

/** 单轮"未知月份"（该月拉取失败）上限：达到即保守中断本轮并保持
 *  end_date = 本次扫描起点（绝不推进）。低于上限时不再中断整轮，而是把未知月份计入
 *  empty_counts 钉住 end_date 供下轮补拉，同时继续扫描更早月份。 */
const MAX_UNKNOWN_MONTHS_PER_RUN = 3;

/** 历史缺失自愈：旧版本"月份获取失败即中断整轮并保存 end_date=失败月份"会留下
 *  "end_date 已经推到最近、本地却只有最近一两个月记录"的损坏数据（更早历史永久不可达）。
 *  判据：缺少 scan_from 标记，且 end_date 距昨天 ≤ SELF_HEAL_END_DATE_DAYS 天、
 *  本地最早记录距当前月份 ≤ SELF_HEAL_RECORD_SPAN_MONTHS 个月 → 强制从保留边界全量重扫。 */
const SELF_HEAL_END_DATE_DAYS = 62;
const SELF_HEAL_RECORD_SPAN_MONTHS = 5;

/** 页面请求失败时的重试次数（page=0用5次，翻页用3次） */
const PAGE_RETRY_COUNT = 3;
const PAGE0_RETRY_COUNT = 5;

/** B站 礼物流水接口实际每页返回条数：实测 page0 返回 20 条（total_count/total_page≈20）。
 *  用于"月份内断点续拉"按已有记录数推算该从第几页接着翻。 */
const API_PAGE_SIZE = 20;

/** 撞到 HTTP 412 后就地退避的梯度：先短等、再长等，仍被拦则本轮收尾（进度已落盘，前端提示稍后刷新续拉）。
 *  与客户端 anchor-gifts-client.ts 的 QUOTA_BACKOFF_MS 保持一致。 */
const QUOTA_BACKOFF_MS = [60 * 1000, 300 * 1000];

/** 本轮是否已放弃（412 退避重试后仍被拦）：置位后本轮所有重试/翻页立即放弃，由响应带回 quotaExhausted。 */
let _quotaHitThisRun = false;

/** 全局平滑节拍器（与客户端一致）：任意两次请求的发出间隔 = 1000/TARGET_RATE，不因并发而缩短。
 *  实测（2026-09 阶梯加载）：412 是 WAF 网关层拦截，凭证与请求通道对阈值均无显著影响
 *  → 瓶颈是出口 IP；且限流由"速率"而非"累计次数"决定（2 req/s 与 3 req/s 各连发 3 分钟零 412，
 *  4 req/s 第 63 秒被拦，10~12.6 req/s 几十秒被拦）→ 可持续阈值落在 (3, 4] req/s。
 *  退避期间节拍落后于当前时间时用 Math.max 不补偿积压，避免 412 退避一结束就把欠下的请求一次性补发。 */
let _pacerNextAt = 0;
function paceRequest(): Promise<void> {
  const now = Date.now();
  const at = Math.max(_pacerNextAt, now);
  _pacerNextAt = at + 1000 / TARGET_RATE;
  const wait = at - now;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}

/** 伪空重试间隔：page0 返回 total_page=0 时，按这些递增间隔再查，
 *  把"软限流/冷缓存导致的假空"从"真无数据"里区分出来。 */
const EMPTY_RETRY_INTERVAL_MS = [5000, 15000, 30000];

/** 可疑空月份连续判定上限：同一空月份连续 N 次运行都被判空 → 视为真无数据并放行 end_date，
 *  保证修复不会因真·空月份导致 end_date 永不推进（死循环）。
 *  上限越大，持续软限流/冷缓存导致的伪空越不容易被误判丢弃（但真空月份冗余补拉轮数也越多）。
 *  从 5 提到 8：风控持续时真实有数据的月份容易被误判为真无数据而永久跳过（缺数据），
 *  提高上限可显著减少这类缺数据。 */
const MAX_CONSECUTIVE_EMPTY_RUNS = 8;

/** 月度数据获取失败时抛出的错误，携带失败的月份范围 */
class MonthFetchError extends Error {
  constructor(
    public begin: string,
    public end: string,
    message: string,
    public partial = false,
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

/**
 * 单次 page0 探测（仅网络层重试，不做伪空重试）：用于"首探"，
 * 只需快速判断该月有没有数据，不翻页。
 * failed=true 表示未得到可信结论（网络/限流持续失败），调用方必须保守处理（不得据此判空）。
 * 成功时一并带回 page0 原始响应，供后续正式翻页直接复用，避免对同一批月份重复请求。
 */
async function probeMonthOnce(
  cookie: string,
  csrf: string,
  buvidCookie: string,
  begin: string,
  end: string,
): Promise<{ hasData: boolean; failed: boolean; credentialExpired: boolean; firstPage?: BiliGiftStreamResponse; failInfo?: string }> {
  let failInfo = "未知（未收到响应）";
  for (let attempt = 0; attempt <= PAGE0_RETRY_COUNT; attempt++) {
    // 本轮已撞到配额窗口（412）：继续探测只会拿到同样的 412，立即放弃交上层收尾
    if (_quotaHitThisRun) {
      return { hasData: false, failed: true, credentialExpired: false, failInfo: "412 限流退避耗尽" };
    }
    try {
      const result = await fetchGiftStreamPage(cookie, csrf, 0, begin, end, buvidCookie);
      if (result.code === 0) {
        return { hasData: (result.data?.total_page ?? 0) > 0, failed: false, credentialExpired: false, firstPage: result };
      }
      // B站凭证失效：交由上层立即返回 needs-relogin
      if (result.code === -101 || result.code === 3 || (result.message && result.message.includes("未登录"))) {
        return { hasData: false, failed: false, credentialExpired: true };
      }
      // 1301000：数据已过期（超出 B站 3 年保留期）→ 视为无数据
      if (result.code === 1301000) {
        return { hasData: false, failed: false, credentialExpired: false, firstPage: result };
      }
      failInfo = `code=${result.code} ${result.message ?? ""}`.trim();
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    } catch (err) {
      failInfo = err instanceof Error ? err.message : String(err);
      // 412 → 配额窗口已满：同窗口内重试无效，立即返回失败（不再冷却等待），由上层收尾
      if (_quotaHitThisRun) {
        return { hasData: false, failed: true, credentialExpired: false, failInfo: "412 限流退避耗尽" };
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
  }
  return { hasData: false, failed: true, credentialExpired: false, failInfo };
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
    console.log(`[AnchorGifts] 未找到 session，需要重新登录`);
    return NextResponse.json(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  const offline = isOffline(url);
  // fast=1：仅基于本地记录计算统计，不拉 B站（用于主播页启动先展示缓存再静默更新）
  const fast = url.searchParams.get("fast") === "1";
  // 解析查询参数（需在 localOnly 判定之前）
  const refresh = url.searchParams.get("refresh") === "true";
  // probe=true：扫码登录触发的全量收益探测（仅登录后首次加载会带上）；
  // 冷启动/绿色刷新不传此参数，不做全量探测（避免对无收益账号反复试探）。
  const probe = url.searchParams.get("probe") === "true";
  const dateRangeFilter = url.searchParams.get("dateRange") ?? "all";
  const fanFilter = url.searchParams.get("fan") ?? "";
  // 数据拉取与页面展示完全解耦：只有用户手动刷新（refresh=true）或扫码登录探测（probe=true）
  // 才触发 B站 拉取；其余场景（打开/切换页面、切换时间段/粉丝，包括"全部"）一律仅基于
  // 本地记录重新统计，不拉 B站。本地数据的最新由冷启动增量更新/手动刷新保障。
  const localOnly = offline || fast || (!refresh && !probe);
  // 服务器账号（source=server）本机无 B站 凭证：跳过凭证校验（与原生端一致），
  // 否则缺失/空凭证会被 ensureValidCredential 判为失效 → 误触发 needs-relogin → 强制跳扫码登录页。
  const isServerAccount = session.source === "server";
  if (!localOnly && !isServerAccount) {
    const credentialResult = await ensureValidCredential(session);
    if (!credentialResult.valid) {
      console.log(`[AnchorGifts] B站凭证失效，需要重新登录`);
      return NextResponse.json(
        { code: 0, message: "needs-relogin", data: null },
        { status: 200 },
      );
    }
  }

  const validSession = session;
  const biliCookie = localOnly || isServerAccount ? "" : buildCookieHeader(session);
  const csrf = biliCookie.match(/bili_jct=([a-f0-9]+)/)?.[1] || "";
  console.log(`[AnchorGifts] 认证通过${offline ? " (离线模式，使用本地缓存)" : ""}: mid=${validSession.mid} uname=${validSession.uname} csrf=${csrf ? "***" : "(空)"} cookie_len=${biliCookie.length}`);

  try {
    // 每轮开始清空"限流"标记，只反映本轮是否撞到 412（与客户端 anchor-gifts-client 一致）
    _quotaHitThisRun = false;
    // 节拍器复位：上一轮结束后残留的 _pacerNextAt 不应把本轮的起步时间提前
    _pacerNextAt = 0;
    // 读取已有记录和元数据（合并存储）
    const { records: existingRecords, meta } = await readRecordsWithMeta(validSession.mid, validSession.uname);

    let allRecords = existingRecords;
    let fetchedNewPages = 0;
    // 本次探测是否判定该账号无收益（置位后随响应带回，前端据此立即隐藏主播页）
    let markedNoRevenue = false;
    // 本轮是否撞到 412 限流而提前收尾、以及未抓完的月份数：带回前端用于
    // "已抓 X 条，还剩 N 个月份待补，请稍后刷新续拉"的提示
    let quotaExhausted = false;
    let pendingMonths = 0;

    const yesterdayStr = getYesterdayStr();

    // 不额外调用 checkDateAvailable（避免增加请求触发限流），
    // 从拉取到的记录中判断昨日是否有数据
    let yesterdayAvailable = true;

    // 昨日可用性：以 B站 API 返回的 ready 标识为准（ready=1 表示昨日数据已汇总完成，
    // 即使昨日无收礼记录也应可点击；ready=0 表示官方尚未更新，需置灰）。
    // 无 API 返回（离线/未拉取到昨日分段）时回退到本地记录判断。
    let yesterdayApiReady: boolean | null = null;

    // 首探已拿到的 page0 原始响应（按月份 start 缓存）：正式翻页阶段同批月份直接复用，
    // 避免每个月份被请求两遍（首探一遍 + 正式翻页一遍）。
    const probedFirstPage = new Map<string, BiliGiftStreamResponse>();

    /** 获取指定月份(payload按整个自然月)内的所有记录，自动翻页。
     *  retryEmpty=false 时跳过伪空重试（由调用方按 shouldRetryEmptyMonth 决定），
     *  page0 返回 total_page=0 直接按空月份返回——开播前/停播后的大段空白不值得逐月复查。 */
    async function fetchRange(begin: string, end: string, existingKeyCounter?: Map<string, number>, buvidCookie?: string, allowEarlyStop = true, cachedFirstPage?: BiliGiftStreamResponse, retryEmpty = true): Promise<{ records: GiftRecord[]; pages: number; ready?: number; empty?: boolean }> {
      const records: GiftRecord[] = [];

      // 带重试的页面请求，网络错误时使用指数退避
      async function fetchPageWithRetry(page: number, maxRetries: number = PAGE_RETRY_COUNT): Promise<BiliGiftStreamResponse | null> {
        const totalAttempts = maxRetries + 1;
        // 命中配额窗口（412）后条件立即为假，不再空转重试
        for (let attempt = 0; attempt <= maxRetries && !_quotaHitThisRun; attempt++) {
          try {
            const result = await fetchGiftStreamPage(biliCookie, csrf, page, begin, end, buvidCookie);
            if (result.code === 0) return result;
            // code=1301000: "不支持查询三年前的数据"——该月数据已过期，跳过（不重试）
            if (result.code === 1301000) {
              console.log(`[AnchorGifts] ${begin}~${end} 第${page}页 code=1301000（数据已过期超过3年），跳过该月`);
              return result;
            }
            // 其他API错误：指数退避（减半基础，避免等待过久）
            const delay = 500 * Math.pow(2, attempt);
            console.error(`[AnchorGifts] ${begin}~${end} 第${page}页 API错误 code=${result.code}，等待${delay}ms后重试${attempt + 1}/${totalAttempts}`);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
          } catch (err: any) {
            // 412 → 配额窗口已满：同窗口内重试必定继续 412，立即跳出（不再冷却等待），交上层收尾
            if (err?.message?.includes("412") || _quotaHitThisRun) {
              _quotaHitThisRun = true;
              console.warn(`[AnchorGifts] ${begin}~${end} 第${page}页 触发412配额窗口已满，立即放弃重试${attempt + 1}/${totalAttempts}`);
              break;
            }
            const delay = 500 * Math.pow(2, attempt);
            console.error(`[AnchorGifts] ${begin}~${end} 第${page}页请求失败，等待${delay}ms后重试${attempt + 1}/${totalAttempts}:`, err);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, delay));
          }
        }
        return null;
      }

      // 第0页：total_page 有意义，total_page=0 表示该月无数据
      // page=0 使用更多重试次数（5次），避免因网络波动丢失整个月份
      // 探测阶段（首探/历史尽头探测）已拿到该月 page0 时直接复用，跳过请求与重试，避免重复请求
      let firstPage = cachedFirstPage ?? await fetchPageWithRetry(0, PAGE0_RETRY_COUNT);
      if (!firstPage) {
        throw new MonthFetchError(begin, end, "第0页获取失败（已重试），终止以避免数据缺失");
      }

      // code=1301000: "不支持查询三年前的数据"——该月已过期，跳过
      if (firstPage.code === 1301000) {
        console.log(`[AnchorGifts] ${begin}~${end} code=1301000 message="${firstPage.message}"（数据已过期），跳过该月`);
        return { records, pages: 0 };
      }

      let totalPages = firstPage.data?.total_page ?? 0;
      const totalHamster = firstPage.data?.total_hamster ?? 0;

      // total_page=0 不一定代表该月无数据：B站 在软限流或被冷缓存命中时，
      // 会静默返回 code=0/total_page=0（假空），并非错误、也不会重试。
      // 这里按递增间隔再做几次 page0 探测：恢复出数据 → 视为假空，继续翻页；
      // 仍为 0 → 判定为"可疑空月份"（empty=true，交给上层用 empty_counts 决定是否补拉）。
      if (totalPages === 0) {
        if (retryEmpty) {
          for (const delay of EMPTY_RETRY_INTERVAL_MS) {
            await new Promise(r => setTimeout(r, delay));
            const retried = await fetchPageWithRetry(0, PAGE0_RETRY_COUNT);
            if (retried && retried.code === 0 && (retried.data?.total_page ?? 0) > 0) {
              firstPage = retried;
              totalPages = firstPage.data?.total_page ?? 0;
              console.log(`[AnchorGifts] ${begin}~${end} 伪空重试恢复：total_page=${totalPages} total_hamster=${firstPage.data?.total_hamster ?? "?"}，继续`);
              break;
            }
          }
        }
        if (totalPages === 0) {
          console.log(`[AnchorGifts] ${begin}~${end} 空月份：${retryEmpty ? "重试后仍 total_page=0" : "未复查（不在伪空重试范围内）"}（标记 empty，交由上层判定）`);
          return { records: [], pages: 0, ready: firstPage.data?.ready, empty: true };
        }
      }

      const listLen = firstPage.data?.list?.length ?? 0;
      const ready = firstPage.data?.ready;
      console.log(`[AnchorGifts] ${begin}~${end} 第0页: total_pages=${totalPages} total_hamster=${totalHamster} list_len=${listLen}`);

      // 第0页的数据
      if (listLen > 0) {
        records.push(...(firstPage.data?.list ?? []));
      }

      // 翻页：从第1页到第totalPages-1页（0-based，第0页已获取）
      // 月份内断点续拉：该月上一轮被 412 打断（记在 empty_counts 里）时，本地已存有前 K 页记录。
      // 必须从缺失页接着翻，而不是从 page 1 重翻——否则每次运行都只会重复抓取同样的前 K 页，
      // 配额一耗尽就再次中断，尾部数据永远拿不到（多轮运行也无法收敛）。
      // 留 2 页余量防边界漂移，重复记录由合并阶段的 existingKeyCounter 去重。
      let startPage = 1;
      if (!allowEarlyStop) {
        const ym = `${begin.slice(0, 4)}-${begin.slice(4, 6)}`;
        let haveThisMonth = 0;
        for (const r of existingRecords) if (r.time.startsWith(ym)) haveThisMonth++;
        if (haveThisMonth > 0) {
          startPage = Math.max(1, Math.floor(haveThisMonth / API_PAGE_SIZE) - 2);
          console.log(`[AnchorGifts] ${begin}~${end} 断点续拉：本地已有 ${haveThisMonth} 条（约 ${Math.ceil(haveThisMonth / API_PAGE_SIZE)} 页），从第 ${startPage} 页继续（共 ${totalPages} 页）`);
        }
      }
      let stoppedEarly = false;
      for (let p = startPage; p < totalPages; p++) {
        // 已撞到配额窗口（412）：停止剩余翻页（不再发请求空转），按"部分完成"抛出（partial=true）
        // 交给上层记为待补拉月份，下轮由"月份内断点续拉"从缺失页继续
        if (_quotaHitThisRun) {
          throw new MonthFetchError(begin, end, "412 配额窗口已满（翻页中断）", true);
        }
        // 连续匹配检测（有已有数据时启用）
        // empty_counts 中记录过的月份（曾中断/不完整）传 false：补拉时必须翻完每一页，
        // 否则会在已知记录的边界提前停止，尾部数据永远抓不到（永久数据空洞）。
        if (allowEarlyStop && existingKeyCounter && records.length >= CONSECUTIVE_MATCH_THRESHOLD) {
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

        // 请求间隔统一由 fetchGiftStreamPage 内的全局节拍器控制（与并发度解耦），此处不再单独 sleep
        const pageResult = await fetchPageWithRetry(p);
        if (pageResult?.data?.list) {
          if (pageResult.data.list.length > 0) {
            records.push(...pageResult.data.list);
          }
        } else {
          throw new MonthFetchError(begin, end, `第${p}页获取失败（已重试），终止以避免数据缺失`, true);
        }
      }
      const pages = stoppedEarly ? 1 : totalPages;
      return { records, pages, ready };
    }

    // ==================== 统一获取逻辑 ====================
    // 只用 end_date 决定起始日期：
    // - probe=true（扫码登录触发）：允许有容错的全量探测——
    //   end_date 为空或文件不存在 → 首次使用，从3年前下个月开始（如2026年8月→2023年9月）
    //   end_date 不为空 → 从 end_date 开始增量获取（含被中断探测的续拉）
    // - probe=false（冷启动/绿色刷新）：绝不全量探测，仅在有数据基线时增量追赶；
    //   无基线（从未探测成功 / 登录探测被中断）→ skipFetch，跳过拉取避免反复试探
    // refresh=true 只是代表用户手动触发，不影响起始日期判断
    let skipFetch = false;
    // B站最多保存3年数据：从3年前的下个月开始（如当前2026年8月 → 2023年9月，8月数据可能已过期）
    const fullBeginDate = (() => {
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const beijing = new Date(utc + 8 * 3600000);
      const startYear = beijing.getFullYear() - 3;
      const startMonth = beijing.getMonth() + 1; // 0-indexed → 1-indexed (1~12)
      // 下个月：12月 → 次年1月
      const beginYear = startMonth === 12 ? startYear + 1 : startYear;
      const beginMonth = startMonth === 12 ? 1 : startMonth + 1;
      return `${beginYear}${String(beginMonth).padStart(2, "0")}01`;
    })();
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
    const startDate = (() => {
      // 历史缺失自愈：无论 probe 与否都强制全量重扫一次（否则下一次 end_date 推进会让
      // 更早历史永久不可达）。仅命中旧版损坏特征时触发，scan_from 写入后不再重复。
      if (needsSelfHealFullScan()) {
        console.warn(`[AnchorGifts] 历史缺失自愈：end_date=${meta?.end_date} 但本地记录仅跨极少月份，改为从保留边界 ${fullBeginDate} 全量重扫`);
        return fullBeginDate;
      }
      if (probe) {
        let forceFullScan = false; // true = 放弃 end_date，从保留边界全量重扫
        if (meta?.end_date) {
          // ===== 保底：end_date 已推进至近期但 records 为空 → 视为被错误推进，回退全量 =====
          // 典型场景：首次打开时网络/412 导致 page 0 失败被旧代码当成"无数据"跳过，
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
                console.warn(`[AnchorGifts] 保底回退：end_date=${meta.end_date}(距昨天${diffDays}天)但现有0条记录，视为被错误推进，改为从${fullBeginDate}全量拉取`);
                forceFullScan = true;
              }
            } catch { /* parseDateStr 异常则不回退，走原逻辑 */ }
          }
          if (!forceFullScan) {
            console.log(`[AnchorGifts] 起始日期：使用 end_date=${meta.end_date}${refresh ? " (用户手动触发)" : ""}`);
            return meta.end_date;
          }
        }
        console.log(`[AnchorGifts] 起始日期=${fullBeginDate}（全量扫描）${refresh ? " (用户手动触发)" : ""}`);
        return fullBeginDate;
      }
      // 非登录（冷启动/绿色刷新）：仅增量追赶，绝不全量探测
      if (meta?.end_date && existingRecords.length > 0) {
        console.log(`[AnchorGifts] 起始日期：使用 end_date=${meta.end_date}${refresh ? " (用户手动触发)" : ""}`);
        return meta.end_date;
      }
      if (existingRecords.length > 0) {
        // 旧缓存无 end_date：从已有记录最新时间开始增量获取
        let maxTime = existingRecords[0].time;
        for (const r of existingRecords) {
          if (r.time > maxTime) maxTime = r.time;
        }
        return maxTime.slice(0, 10).replace(/-/g, "");
      }
      // 一条记录都没有（含旧版遗留：end_date 已被推到昨天的 0 记录账号）：
      // 非登录拉取只会重查昨天 1 天 + 伪空重试，纯属浪费且无新数据可追。
      // noRevenue 仅由扫码登录（probe=true，含保底回退全量重探）置位，这里一律跳过、
      // 不置位，避免误伤"确曾有历史收益但 end_date 被旧 bug 推到昨天"的账号。
      skipFetch = true;
      return yesterdayStr;
    })();

    if (localOnly) {
      // 本地直出（fast 或离线模式）：不抓取 B 站，仅使用本地缓存记录
      console.log(`[AnchorGifts] ${fast ? "fast" : "离线"}模式，使用本地缓存 ${existingRecords.length} 条记录`);
      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));
      fetchedNewPages = 0;
    } else if (meta?.noRevenue) {
      // 首次登录全量探测已确认无收益（noRevenue）：视为无直播间/非持续开播主播，跳过整个收益拉取。
      // 与冷启动、绿色刷新一致：不再重复探测，仅使用本地已有（通常为空）记录计算统计。
      console.log(`[AnchorGifts] ${validSession.mid} 已标记无收益，跳过收益记录拉取（仅用本地 ${existingRecords.length} 条记录）`);
      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));
      fetchedNewPages = 0;
    } else if (skipFetch) {
      // 非登录（冷启动/绿色刷新）且无数据基线：不做全量探测，仅用本地已有记录计算统计。
      // 该账号的全量探测只在下次扫码登录（probe=true）时触发，或在"重建数据"时重新进行。
      console.log(`[AnchorGifts] ${validSession.mid} 非登录且无数据基线，跳过收益记录拉取（仅用本地 ${existingRecords.length} 条记录）`);
      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));
      fetchedNewPages = 0;
    } else if (startDate > yesterdayStr) {
      console.log(`[AnchorGifts] 无需获取，startDate=${startDate} > yesterdayStr=${yesterdayStr}`);
      fetchedNewPages = 0;
    } else if (!(await checkAnchorHasRoom(validSession.mid))) {
      // 无直播间（非主播）：跳过整个收益拉取，仅使用本地已有记录计算统计。
      // 大多数用户并非主播，避免为完全无收益数据的账号做几十个月的翻页/重试。
      console.log(`[AnchorGifts] ${validSession.mid} 无直播间，跳过收益记录拉取（仅用本地 ${existingRecords.length} 条记录）`);
      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));
      fetchedNewPages = 0;
    } else {
      // 获取 buvid3 反爬Cookie
      const buvidCookie = await getBuvidCookie().catch(() => "");

      const chunks = generateMonthChunks(startDate, yesterdayStr); // 升序
      /** 单个月的探明结论：data=有数据；empty=已确认无数据；unknown=未得到可信结论。 */
      type MonthStatus = "data" | "empty" | "unknown";
      const monthPlan = new Map<string, MonthStatus>();
      /** 记录某月份的探明结论。必须区分三态：探测失败（未知）绝不能当成"无数据"，
       *  否则该月会被排除出抓取范围并永久跳过。 */
      const recordMonth = (start: string, status: MonthStatus) => {
        const prev = monthPlan.get(start);
        // 不拿"未得到结论"去覆盖已有结论（例如翻页阶段重试失败不应抹掉首探的结果）
        if (prev && prev !== "unknown" && status === "unknown") return;
        monthPlan.set(start, status);
      };
      /** 最早有数据月份在 chunks 中的下标（-1 = 未知）。用于剪枝"开播之前"的空月份。 */
      const firstDataIndexOf = () => {
        for (let i = 0; i < chunks.length; i++) {
          if (monthPlan.get(chunks[i].start) === "data") return i;
        }
        return -1;
      };

      // ==================== 首探：一次性探完全部月份（仅扫码登录全量探测，且本地无任何记录） ====================
      // 与客户端一致：一次探完扫描窗口内所有月份的 page0（每月 1 次请求），换来
      //  ① 每个月的 total_page 已知 → 已确认的空月份可直接跳过、不再发请求；
      //  ② 数据分布的起止范围由实测确定 → 后续按"从旧到新"顺序推进即可，不需要任何早停启发式。
      // 这些 page0 会被正式翻页阶段从 probedFirstPage 复用，所以不额外增加请求。
      // 全部月份均无数据 → 该账号无收益：置 noRevenue 并保存后立即终止，不再扫描历史月份。
      // 注意：仅"零记录"账号适用（有记录的账号即使近期无数据也不得判无收益）。
      if (probe && existingRecords.length === 0) {
        console.log(`[AnchorGifts] ${validSession.mid} 首探：一次探测全部 ${chunks.length} 个月（${startDate} ~ ${yesterdayStr}）`);
        const { results: probeResults } = await runWithConcurrency(
          chunks,
          MONTH_CONCURRENCY,
          (c) => probeMonthOnce(biliCookie, csrf, buvidCookie, c.start, c.end),
        );
        probeResults.forEach((r, i) => {
          if (r.firstPage) probedFirstPage.set(chunks[i].start, r.firstPage);
          // 三态区分：探测失败 / 凭证失效 = 未知（既不算有数据、也绝不算空），该月会被翻页阶段重试；
          // 只有"拿到可信响应且 total_page=0"才是空月份。
          if (r.failed || r.credentialExpired) recordMonth(chunks[i].start, "unknown");
          else if (r.hasData) recordMonth(chunks[i].start, "data");
          else recordMonth(chunks[i].start, "empty");
        });
        // 有月份探测未得到可信结论（网络/限流持续失败、凭证失效）时不判无收益，继续走正常全量抓取。
        const probeFailedList = probeResults
          .map((r, i) => ({ r, start: chunks[i].start }))
          .filter((x) => x.r.failed || x.r.credentialExpired);
        if (probeFailedList.length > 0) {
          console.warn(
            `[AnchorGifts] 首探有 ${probeFailedList.length}/${chunks.length} 个月未得到可信结论，不判无收益，继续全量抓取；失败明细：`
            + probeFailedList.map((x) => `${x.start}(${x.r.failInfo ?? (x.r.credentialExpired ? "凭证失效" : "未知")})`).join("，"),
          );
        }
        if (probeFailedList.length === 0 && probeResults.every((r) => !r.hasData)) {
          markedNoRevenue = true;
          skipFetch = true;
          await saveRecordsWithMeta(validSession.mid, validSession.uname, [], {
            total_page: meta?.total_page ?? 0,
            end_date: yesterdayStr,
            last_fetch: getBeijingTime(),
            empty_counts: {},
            noRevenue: true,
          });
          console.log(`[AnchorGifts] ${validSession.mid} 首探短路：全部 ${chunks.length} 个月均无数据，标记 noRevenue 并终止扫描`);
        }
      }

      // 执行顺序：从旧到新。数据起止范围已由首探实测确定，不再需要"从新到旧 + 连续空月份
      // 提前终止"的启发式；顺序推进更符合"按时间补齐历史"的直觉，日志也更好读。
      console.log(`[AnchorGifts] 获取数据: ${startDate} ~ ${yesterdayStr}, 共${chunks.length}个月, 速率=${TARGET_RATE}req/s 并发度=${MONTH_CONCURRENCY}（从旧到新）${buvidCookie ? ", buvid=有" : ", buvid=无"}`);

      // 伪空重试（total_page=0 时按递增间隔复查，识别软限流假空）的适用范围：
      // 首探已给出完整的月份分布时，只对"有数据月份之间的空档"复查——中段断档才可疑；
      // 开播之前 / 停播之后的长空白段是账号真的没有收益，若也逐月复查（5s+15s+30s），
      // 一次全量扫描会白等几十分钟。没有首探结论（增量路径）时保持原有行为，一律复查。
      //
      // 例外：最早有数据月份的"前一个月"也必须复查。它紧邻已知最早的数据月，是最可能的
      // 假空位置——首探时该月的 page0 恰好被软限流/冷缓存命中返回 total_page=0 的话，
      // 它会被当成"开播之前"而永久跳过，导致账号真实的最早一个月收益缺失。
      const dataStarts = chunks.map((c) => c.start).filter((s) => monthPlan.get(s) === "data");
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
      let hasNewRecords = false;
      fetchedNewPages = 0;

      // 从旧到新分批抓取：每批最多 MONTH_CONCURRENCY 个月份并行（并发度由速率派生）。
      const chunkResults: Array<{ records: GiftRecord[]; pages: number; ready?: number; empty?: boolean } | undefined> = new Array(chunks.length);
      const unknownStarts: string[] = []; // 拉取失败（该月拿不到）的月份：未知，不得视为空
      const partialStarts: string[] = []; // 第0页成功、翻页被 412 打断的月份：已知有数据但不完整
      let aborted = false; // 未知月份过多 → 保守中断本轮（end_date 保持本次起始日期，绝不推进）
      let firstError: Error | undefined;

      // skipFetch 为 true 表示首探已判定该账号无收益并落盘：整个抓取循环跳过（见下方收尾分支）。
      for (let b = 0; b < chunks.length && !aborted && !skipFetch; b += MONTH_CONCURRENCY) {
        const batch = Array.from({ length: Math.min(MONTH_CONCURRENCY, chunks.length - b) }, (_, k) => b + k);
        const batchOut = await runWithConcurrency(batch, MONTH_CONCURRENCY, async (idx) => {
          const chunk = chunks[idx];
          // 首探已确认无数据的月份：直接跳过，不再翻页——省掉一次无用请求。
          // 只信任"empty"（拿到可信响应且 total_page=0）；"unknown"（探测失败）必须照常重试。
          if (monthPlan.get(chunk.start) === "empty") {
            return { records: [], pages: 0, empty: true };
          }
          console.log(`[AnchorGifts] 获取分段: ${chunk.start} ~ ${chunk.end}`);
          try {
            return await fetchRange(chunk.start, chunk.end, existingKeyCounter, buvidCookie, (meta?.empty_counts?.[chunk.start] ?? 0) < 1, probedFirstPage.get(chunk.start), shouldRetryEmptyMonth(chunk.start));
          } catch (err) {
            // 单月失败不再中断整轮：中断会让更晚月份永不被抓取，
            // 而 end_date 一旦被钉在失败月份，那段历史就永久不可达（历史数据缺失的根因）。
            if (err instanceof MonthFetchError) {
              const isPartial = err.partial;
              console.warn(`[AnchorGifts] ${chunk.start}~${chunk.end} 获取失败（${isPartial ? "翻页中断" : "page0 失败"}，失败原因：${err.message}），${isPartial ? "记为待补拉月份" : "记为未知月份"}，继续扫描更晚月份`);
              if (isPartial) {
                partialStarts.push(chunk.start);
                // 翻页被打断但 page0 已成功 = 该月确实有数据，要计入"有数据月份"，
                // 否则收尾时 firstDataIndexOf 会算错，把开播之后的月份误当开播之前剪掉。
                recordMonth(chunk.start, "data");
              } else {
                unknownStarts.push(chunk.start);
              }
              return undefined;
            }
            throw err;
          }
        });
        batch.forEach((idx, k) => { chunkResults[idx] = batchOut.results[k]; });
        if (batchOut.firstError) {
          // 非 MonthFetchError 的意外错误：保守中断本轮（end_date 保持本次起始日期）
          firstError = batchOut.firstError;
          console.error(`[AnchorGifts] 获取出现意外错误: ${firstError.message}，保守中断并保持 end_date=${startDate}`);
          aborted = true;
          break;
        }

        // 本批结果按月份顺序串行处理：读取 ready 标识、去重合并、回填探明结论
        for (const idx of batch) {
          const result = chunkResults[idx];
          // 结果为 undefined = 该月份拉取失败（未知/部分完成月份）：已在 catch 中记录，此处不再处理
          if (!result) continue;
          // 从包含"昨日"的最近分段响应中读取 ready 标识，判断官方昨日数据是否已更新
          if (result.ready !== undefined) {
            yesterdayApiReady = result.ready === 1;
          }
          fetchedNewPages += result.pages;
          // 回填探明结论：伪空重试恢复出数据的月份在此纠正为"有数据"（首探可能把它误判成空月份）
          recordMonth(chunks[idx].start, result.empty ? "empty" : "data");
          if (result.records.length === 0) continue;
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

        // 412 退避用完仍被拦截：判定出口 IP 被持续限流，本轮收尾。
        // end_date 保持本轮起点，未知/待补拉月份已计入 empty_counts，用户下次刷新可续拉。
        if (_quotaHitThisRun) {
          console.warn(`[AnchorGifts] 已退避重试 ${QUOTA_BACKOFF_MS.length} 次仍被 412 限流，本轮收尾：已抓 ${allRecords.length} 条，待补拉 ${partialStarts.length + unknownStarts.length} 个月份，请稍后手动刷新续拉（速率由服务器端固定档位决定，只能等待恢复）`);
          aborted = true;
          break;
        }

        // 单轮未知月份过多（连首页都拿不到）→ 保守中断本轮
        if (unknownStarts.length >= MAX_UNKNOWN_MONTHS_PER_RUN) {
          console.warn(`[AnchorGifts] 本轮已有 ${unknownStarts.length} 个月份获取失败（≥${MAX_UNKNOWN_MONTHS_PER_RUN}），保守中断并保持 end_date=${startDate}`);
          aborted = true;
          break;
        }
      }

      allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));

      const prevTotalPage = meta?.total_page ?? 0;
      // 首个有数据月份下标（取自 monthPlan 的实测结论，而非"本次是否取到新记录"）：
      // 开播前无历史月份的响应与假空无法区分（都是 code=0/total_page=0），
      // 若也计入 empty_counts 会把 end_date 钉到最早月份、每次全量重拉并反复重试这些月份，代价过大；
      // 故开播前（firstDataIdx 之前）的月份一律不计数、不补拉。
      const firstDataIdx = firstDataIndexOf();
      // empty_count 处理：有数据的月份清零，空月份累加，再按上限决定 end_date
      const prevEmptyCounts = meta?.empty_counts ?? {};
      const nextEmptyCounts: Record<string, number> = { ...prevEmptyCounts };
      for (let ci = 0; ci < chunkResults.length; ci++) {
        const result = chunkResults[ci];
        if (!result) continue;
        const start = chunks[ci]?.start;
        if (!start) continue;
        if (firstDataIdx !== -1 && ci < firstDataIdx) continue;
        if (result.empty) {
          nextEmptyCounts[start] = (nextEmptyCounts[start] ?? 0) + 1;
        } else {
          // "完整翻完"的月份才清除补拉标记（该月页数已全部取到，即使本次没有新增记录——
          // 断点续拉从缺失页接着翻完时，前面的页都是已有记录，records 可能为 0）；
          // 被 412 打断的部分完成月份不会出现在 chunkResults（值为 undefined，已在上方 continue），
          // 标记自然保留，否则下轮会跳过它、尾部数据永久缺失。
          delete nextEmptyCounts[start];
        }
      }
      // 本轮"未知月份"（拉取失败）必须计入：它们不是"无数据"，只是没抓到，
      // 需要挡住 end_date 供下一轮补拉（超过 MAX_CONSECUTIVE_EMPTY_RUNS 才放弃，防死循环）。
      // 不套用 firstDataIdx 过滤——失败的月份可能比已知最早的收益月份还早，
      // 若被过滤掉，end_date 推进会把这些月份永久跳过。
      for (const s of unknownStarts) {
        nextEmptyCounts[s] = (nextEmptyCounts[s] ?? 0) + 1;
      }
      // 被 412 打断的部分完成月份同理：必须挡住 end_date 供下一轮把它补完。
      for (const s of partialStarts) {
        nextEmptyCounts[s] = (nextEmptyCounts[s] ?? 0) + 1;
      }
      // 仍低于上限的空月份视为"可疑"，取其最早者作为截止点，下轮从该月补拉
      const suspiciousEmptyStarts = chunks
        .map(c => c.start)
        .filter(s => {
          const c = nextEmptyCounts[s] ?? 0;
          // 只有真正被判空过的月份（次数>=1）且仍低于上限的，才挡住 end_date 补拉。
          // 有数据的月份不在 empty_counts 里（count=0），绝不能当作可疑空，
          // 否则 end_date 会被钉在最早月份，导致每次更新都从头全量重拉。
          return s && c >= 1 && c < MAX_CONSECUTIVE_EMPTY_RUNS;
        });
      const nextEndDate = suspiciousEmptyStarts.length > 0
        ? suspiciousEmptyStarts.sort()[0]
        : yesterdayStr;

      if (skipFetch) {
        // 首探已判定无收益并落盘（noRevenue=true）：本轮不再改动任何元数据，
        // 否则下面的收尾会以 noRevenue=false 覆盖掉刚写入的标记。
        allRecords = existingRecords.sort((a, b) => b.time.localeCompare(a.time));
        fetchedNewPages = 0;
        console.log(`[AnchorGifts] ${validSession.mid} 首探判定无收益，跳过本轮元数据写入`);
      } else if (aborted) {
        // 保守中断（未知月份过多 / 意外错误）：end_date 保持本次扫描起点，绝不推进，
        // 下一轮从同一范围重来（已取到的记录照常保存）。
        const abortedEmptyCounts: Record<string, number> = { ...prevEmptyCounts };
        for (const s of [...partialStarts, ...unknownStarts]) {
          abortedEmptyCounts[s] = (abortedEmptyCounts[s] ?? 0) + 1;
        }
        await saveRecordsWithMeta(validSession.mid, validSession.uname, allRecords, {
          total_page: prevTotalPage + fetchedNewPages,
          end_date: startDate,
          last_fetch: getBeijingTime(),
          empty_counts: abortedEmptyCounts,
          noRevenue: meta?.noRevenue ?? false,
          scan_from: meta?.scan_from,
        });
        console.log(`[AnchorGifts] 保守中断: end_date 保持 ${startDate}（不推进），${fetchedNewPages} 页, 新增 ${hasNewRecords ? "有" : "无"}, 总计 ${allRecords.length} 条${firstError ? `（${firstError.message}）` : ""}`);
      } else {
        // noRevenue 仅由首探短路判定置位（见上文首个 if (probe ...) 分支），此处沿用已持久化的标记。
        // scan_from 语义 = "从该日期起的历史已确认完整"：仅当本轮从 B站 保留边界起步
        // （真正覆盖全部可得历史）且无未知月份时才写入首次值；增量轮次不写入，避免把
        // scan_from 标成近期日期而使"历史缺失自愈"判据失效。
        const coveredFullHistory = startDate <= fullBeginDate && unknownStarts.length === 0 && partialStarts.length === 0;
        await saveRecordsWithMeta(validSession.mid, validSession.uname, allRecords, {
          total_page: prevTotalPage + fetchedNewPages,
          end_date: nextEndDate,
          last_fetch: getBeijingTime(),
          empty_counts: nextEmptyCounts,
          noRevenue: meta?.noRevenue ?? false,
          scan_from: meta?.scan_from ?? (coveredFullHistory ? startDate : undefined),
        });
        if (suspiciousEmptyStarts.length > 0) {
          console.log(`[AnchorGifts] 获取完成: end_date 保留在最早可疑空月份 ${nextEndDate}（共${suspiciousEmptyStarts.length}个待补拉），${fetchedNewPages} 页, 新增 ${hasNewRecords ? "有" : "无"}, 总计 ${allRecords.length} 条`);
        } else {
          console.log(`[AnchorGifts] 获取完成: ${fetchedNewPages} 页, 新增记录 ${hasNewRecords ? "有" : "无"}, 总计 ${allRecords.length} 条`);
        }
      }

      // 带回本轮收尾状态：412 退避耗尽时前端提示用户稍后刷新续拉（配合月份内断点续拉逐轮补齐）
      quotaExhausted = _quotaHitThisRun;
      pendingMonths = partialStarts.length + unknownStarts.length;
    }

    // 昨日可用性：优先采用 B站 API 的 ready 标识（ready=1 即官方已更新昨日数据，
    // 即使昨日无收礼记录也应可点击）；未拉取到昨日分段时回退到本地记录判断。
    const yesterdayDate = yesterdayStr.slice(0, 4) + "-" + yesterdayStr.slice(4, 6) + "-" + yesterdayStr.slice(6, 8);
    if (yesterdayApiReady !== null) {
      yesterdayAvailable = yesterdayApiReady;
    } else if (allRecords.length > 0) {
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

    // 盲盒统计：记录每种盲盒的接收次数和收益（收益含奖励礼物，次数含全部礼物）
    const blindBoxCountMap = new Map<number, { num: number; hamster: number }>();
    // 盲盒成本计数：仅统计非奖励礼物（奖励礼物成本 0，不计抽数/成本）
    const blindBoxCostCountMap = new Map<number, number>();
    // 盲盒内各礼物分别计数
    const blindBoxGiftCountMap = new Map<number, Map<number, { name: string; num: number; hamster: number }>>();
    // 盲盒粉丝统计
    const blindBoxFanMap = new Map<number, Map<number, { uname: string; count: number }>>();
    // 盲盒日期集合
    const blindBoxDateSet = new Map<number, Set<string>>();
    // 盲盒内"浪漫城堡"礼物按粉丝统计（用于"粉丝城堡清单"模态框）
    // key=盲盒id，value=Map<粉丝uid, { uname, records: 每次开城堡的时间戳 }>
    const blindBoxCastleMap = new Map<number, Map<number, { uname: string; records: string[] }>>();

    // 获取盲盒配置和反向映射（必须在循环之前）
    const blindBoxConfig = await getEffectiveBlindBoxConfig();
    // 可查询盲盒 = admin 勾选的卡片盲盒 ∪ 盈亏勾选的盲盒（保证"全部盲盒"卡片能查到任一指定盲盒），完全按 admin 配置控制
    const activityBoxIds = blindBoxConfig.current_activity_blind_box_ids ?? [];
    const extraProfitIds = (blindBoxConfig.profitIds ?? []).filter((id) => !activityBoxIds.includes(id));
    const blindBoxIds = [...activityBoxIds, ...extraProfitIds];
    const allBlindBoxInfo = await getAllBlindBoxInfo(0, "");

    // 各盲盒的奖励礼物 id 集合（admin 配置，成本 0），供成本计数与名称标注使用
    const rewardGiftIdsByBox = new Map<number, Set<number>>();
    for (const [idStr, box] of Object.entries(blindBoxConfig.boxes)) {
      if (box.rewardGiftIds.size > 0) rewardGiftIdsByBox.set(Number(idStr), box.rewardGiftIds);
    }

    // 如果本地/配置缺少盲盒礼物列表，尝试从B站API获取（离线时跳过）。
    // 仅在「该盲盒无礼物的 gift_id 列表」时才探测，且不覆盖 admin 配置的名称/单价。
    for (const blindBoxId of blindBoxIds) {
      const existing = allBlindBoxInfo[blindBoxId];
      const needProbe = !existing || existing.gifts.length === 0;
      if (!localOnly && needProbe) {
        try {
          console.log(`[AnchorGifts] 盲盒 ${blindBoxId} 无礼物列表，尝试从B站API获取...`);
          const checkResult = await checkBlindBox(blindBoxId, biliCookie);
          if (checkResult) {
            const mergedName = existing?.blind_box_name || checkResult.blindGiftName;
            const mergedImg = existing?.blind_box_img || "";
            const mergedPrice = existing?.blind_price || checkResult.blindPrice;
            await saveBlindBoxInfo(validSession.mid, validSession.uname, blindBoxId, {
              gift_name: mergedName,
              gift_img: mergedImg,
              price: mergedPrice,
              gifts: checkResult.gifts,
            });
            allBlindBoxInfo[blindBoxId] = {
              blind_box_id: blindBoxId,
              blind_box_name: mergedName,
              blind_box_img: mergedImg,
              blind_price: mergedPrice,
              gifts: checkResult.gifts,
              updated_at: getBeijingTime(),
            };
            console.log(`[AnchorGifts] 盲盒 ${blindBoxId}(${mergedName}) 信息获取成功，包含 ${checkResult.gifts.length} 个礼物`);
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
          // gift_id=0 的奖励礼物（过期、无法确定 id）不参与反向映射，避免污染
          if (g.gift_id > 0 && !giftIdToBlindBoxId.has(g.gift_id)) giftIdToBlindBoxId.set(g.gift_id, blindBoxId);
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

        // 成本计数：奖励礼物成本 0，不计抽数/成本
        if (!rewardGiftIdsByBox.get(bbId)?.has(r.gift_id)) {
          blindBoxCostCountMap.set(bbId, (blindBoxCostCountMap.get(bbId) ?? 0) + r.num);
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

        // 浪漫城堡按粉丝统计（records 存完整时间戳，用于展示 日期/周几/时间）
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

    // 加载礼物图标目录（来自 B站 giftConfig API，无需登录；仅用于展示图标）
    await ensureGiftCatalogLoaded();

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
      castleFans: Array<{ uid: number; uname: string; face: string; count: number; records: string[] }>;
    }> = [];

    // 预取"粉丝城堡清单"各粉丝头像（仅有城堡粉丝时发起，数量少；失败不影响列表）
    const castleFaceMap = new Map<number, string>();
    {
      const castleUids = new Set<number>();
      for (const fanMapBB of blindBoxCastleMap.values()) {
        for (const uid of fanMapBB.keys()) castleUids.add(Number(uid));
      }
      if (castleUids.size > 0) {
        await Promise.all(Array.from(castleUids).map(async (uid) => {
          try {
            const info = await getUserInfoByUid(uid, false, validSession.mid, validSession.uname || "");
            if (info.face) castleFaceMap.set(uid, info.face);
          } catch { /* 头像获取失败不阻断列表展示 */ }
        }));
      }
    }

    for (const blindBoxId of blindBoxIds) {
      const count = blindBoxCountMap.get(blindBoxId);
      const info = allBlindBoxInfo[blindBoxId];
      const boxName = info?.blind_box_name ?? `盲盒_${blindBoxId}`;
      // blind_box_img 在 saveBlindBoxInfo 时为空，从 gift-catalog 或 admin-config 获取
      const boxImg = getGiftImg(blindBoxId) || blindBoxConfig.icons[blindBoxId] || info?.blind_box_img || "";
      // 抽数/成本仅计非奖励礼物（奖励礼物成本 0）
      const drawCount = blindBoxCostCountMap.get(blindBoxId) ?? 0;
      const totalHamsterBB = count?.hamster ?? 0;
      // blind_price 单位是电池，乘以50转换为 hamster（收益已/2，成本也需/2）；admin 配置优先
      const rawBlindPrice = blindBoxConfig.boxes[blindBoxId]?.blindPrice || info?.blind_price || 0;
      const blindPrice = rawBlindPrice * 50;
      const cost = drawCount * blindPrice;
      const rewardGiftIds = rewardGiftIdsByBox.get(blindBoxId);

      // 礼物列表：从盲盒信息中获取，实际数量从收益记录中统计；奖励礼物名称后标注（奖励）
      const gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }> = [];
      const giftCountMap = blindBoxGiftCountMap.get(blindBoxId);
      if (info?.gifts) {
        for (const g of info.gifts) {
          const actualCount = giftCountMap?.get(g.gift_id);
          const isReward = rewardGiftIds?.has(g.gift_id) ?? false;
          gifts.push({
            gift_id: g.gift_id,
            name: isReward ? `${g.gift_name}（奖励）` : g.gift_name,
            num: actualCount?.num ?? 0,
            hamster: actualCount?.hamster ?? 0,
            img: g.gift_img,
          });
        }
      }

      // 粉丝列表（按次数降序）：选中粉丝时用"仅按时间段过滤"的列表，
      // 保证下拉框仍能显示该时间段内全部粉丝
      const fanMapForBB = fanUids.length > 0
        ? (blindBoxFanMapAll.get(blindBoxId) ?? blindBoxFanMap.get(blindBoxId))
        : blindBoxFanMap.get(blindBoxId);
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

      // 浪漫城堡按粉丝统计：粉丝按"最新一次开城堡"时间降序排（最新在上），
      // 每条记录按时间降序（filteredRecords 已按时间倒序）
      const castleFanMapForBB = blindBoxCastleMap.get(blindBoxId);
      const castleFans = castleFanMapForBB
        ? Array.from(castleFanMapForBB.entries())
            .map(([uid, v]) => ({
              uid: Number(uid),
              uname: v.uname,
              face: castleFaceMap.get(Number(uid)) ?? "",
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
        blindPrice: rawBlindPrice / 2,  // 电池单位，/2 与收益对齐
        anchors,
        dateRange,
        castleFans,
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
      giftTypes: giftSummary.length,
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
      // 本次已判定无收益（或此前已标记）：供前端立即隐藏主播页
      noRevenue: markedNoRevenue || meta?.noRevenue === true,
      fetchedNewPages: fetchedNewPages,
      yesterdayAvailable,
      // 本次 412 退避重试后仍被拦截而收尾，前端提示用户稍后手动刷新。
      // 与客户端 anchor-gifts-client.ts 的 AnchorGiftsResult 同名字段对齐。
      quotaExhausted,
      pendingMonths,
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