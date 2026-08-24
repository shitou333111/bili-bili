/**
 * Tauri 客户端 - 收益记录获取
 * 在 Tauri 环境下，直接调用 B站 API 获取消费记录
 *
 * 逻辑与 src/app/api/revenue/pay-record/route.ts 对应，但运行在客户端。
 */

import type { Platform } from "./platform/types";
import { ensureValidCredentialClient } from "./bilibili/cookie-refresh-client";
import { md5 } from "./md5";

// ==================== 类型定义 ====================

type PayRecordItem = {
  id: number;
  gift_num: number;
  gift_num_unit: string;
  coin: string;
  pay_coin: string;
  ruid: number;
  gift_id: number;
  timestamp: number;
  room_id: number;
  r_uname: string;
  gift_name: string;
  gift_img: string;
  coin_type: string;
  is_guard: number;
  is_discount: number;
  bag_desc: string;
  discount_desc: string;
  status_msg: string;
  receive_title: string;
  refund_price: string;
  mtime: number;
};

type PayRecordResponse = {
  code: number;
  message: string;
  data?: {
    list: PayRecordItem[];
    params?: {
      next_id?: number;
      month?: string;
    };
  };
};

type PayRecordSnapshot = {
  source: "real";
  month: string;
  nextId: number;
  totalRecords: number;
  totalCoins: number;
  giftCatalog: Array<{
    giftName: string;
    giftImg: string;
    giftId: number;
    latestTimestamp: number;
  }>;
  records: Array<PayRecordItem & {
    totalCoins: number;
    giftNameKey: string;
  }>;
};

// ==================== 常量 ====================

const DEFAULT_APP_KEY = "1d8b6e7d45233436";
const DEFAULT_APP_SECRET = "560c52ccd288fed045859ed18bffd973";
// 每页请求条数：B站上限 50（实测 page_size=100 也只会返回 50 条/页）。
// 设 50 即为接口能返回的最大值，总请求数约为 20/页 的 1/2.5。
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;
const REQUEST_RETRY_COUNT = 3;
const REQUEST_BACKOFF_MS = 500;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

// ==================== 签名函数 ====================

function signParams(params: Record<string, string>): string {
  const sortedEntries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  const query = sortedEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return md5(`${query}${DEFAULT_APP_SECRET}`);
}

// ==================== URL 构建 ====================

function buildPayRecordUrl(cookie: string, nextId?: number): string {
  const params: Record<string, string> = {
    actionKey: "appkey",
    appkey: DEFAULT_APP_KEY,
    build: "8870400",
    c_locale: "zh-Hans_CN",
    channel: "oppo",
    coin_type: "gold",
    device: "android",
    disable_rcmd: "0",
    mobi_app: "android",
    page_size: String(PAGE_SIZE),
    platform: "android",
    s_locale: "zh-Hans_CN",
    statistics: JSON.stringify({ appId: 1, platform: 3, version: "8.87.0", abtest: "" }),
    ts: Math.floor(Date.now() / 1000).toString(),
    version: "8.87.0",
  };

  if (nextId) {
    params.next_id = String(nextId);
  }

  params.sign = signParams(params);

  const url = new URL("https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// ==================== 数据处理 ====================

function getMaxId(records: Array<{ id: number }>): number {
  if (records.length === 0) return 0;
  return Math.max(...records.map((r) => r.id));
}

function buildSnapshot(records: PayRecordItem[], month: string): PayRecordSnapshot {
  const allRecords = records.map((r) => ({
    ...r,
    totalCoins: Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0,
    giftNameKey: r.gift_name,
  }));

  const giftCatalog = Array.from(
    allRecords.reduce((map, record) => {
      const key = `${record.gift_id}_${record.gift_name}`;
      if (!map.has(key)) {
        map.set(key, {
          giftName: record.gift_name,
          giftImg: record.gift_img,
          giftId: record.gift_id,
          latestTimestamp: record.timestamp,
        });
      }
      return map;
    }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>()).values(),
  );

  const totalCoins = allRecords.reduce((sum, r) => sum + r.totalCoins, 0);

  return {
    source: "real",
    month,
    nextId: allRecords.length > 0 ? allRecords[allRecords.length - 1].id : 0,
    totalRecords: allRecords.length,
    totalCoins,
    giftCatalog,
    records: allRecords,
  };
}

// ==================== 主函数 ====================

/**
 * 带重试的 payRecord 请求。
 * 网络瞬时失败（如 Tauri HTTP 插件连接/TLS 抖动）时指数退避重试；
 * 412 限流时冷却后重试，避免一次性丢弃整个增量拉取。
 */
async function fetchPayRecordPageWithRetry(
  platform: Platform,
  url: string,
  cookie: string,
): Promise<PayRecordResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt++) {
    try {
      const response = await platform.fetchBilibiliJson<PayRecordResponse>({
        url,
        cookie,
        mobile: true,
      });
      // 已拿到业务响应（无论 code 是否 0），交由调用方处理，不再重试
      return response;
    } catch (err: any) {
      lastErr = err;
      const isRateLimit = err?.message?.includes("412");
      if (isRateLimit) {
        console.warn(`[PayRecordClient] 第 ${attempt + 1} 次请求触发412限流，冷却 ${RATE_LIMIT_COOLDOWN_MS}ms 后重试`);
        await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
      } else {
        const delay = REQUEST_BACKOFF_MS * Math.pow(2, attempt);
        if (attempt < REQUEST_RETRY_COUNT) {
          console.warn(`[PayRecordClient] 请求失败，等待 ${delay}ms 后重试 ${attempt + 1}/${REQUEST_RETRY_COUNT + 1}: ${err?.message || err}`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }
  throw lastErr;
}

export async function fetchPayRecords(
  platform: Platform,
  refresh?: boolean,
  onProgress?: (p: { text: string; ratio?: number; current?: number; total?: number }) => void,
): Promise<{ code: number; message: string; data?: PayRecordSnapshot }> {
  const state = await platform.getSessionState();
  const sid = state.currentSid;
  if (!sid) {
    return { code: -1, message: "未登录" };
  }

  const session = state.sessions.find((s) => s.sid === sid);
  if (!session) {
    return { code: -1, message: "会话无效" };
  }

  // 客户端凭证验证与自动刷新（仅非 server 账号有 B站 Cookie）
  // SESSDATA 失效时用 refresh_token 自动刷新，避免频繁要求重新登录
  let cookie: string;
  if (session.source !== "server") {
    const credResult = await ensureValidCredentialClient(platform, session);
    if (!credResult.valid) {
      console.warn("[PayRecordClient] 凭证失效且刷新失败，需重新登录:", credResult.reason);
      return { code: -101, message: "needs-relogin" };
    }
    cookie = credResult.cookie;
  } else {
    cookie = session.biliCookies?.length
      ? session.biliCookies.join("; ")
      : `SESSDATA=${session.biliSessdata}`;
  }

  if (!cookie) {
    return { code: -1, message: "无有效 B站 Cookie" };
  }

  const dataDir = `${await platform.getDataDir()}/uid_${session.mid}`;
  const recordsPath = `${dataDir}/pay-records.json`;

  // 读取已有记录
  let existingRecords: PayRecordItem[] = [];
  try {
    if (await platform.exists(recordsPath)) {
      const raw = await platform.readFile(recordsPath);
      const parsed = JSON.parse(raw);
      existingRecords = Array.isArray(parsed) ? parsed : (parsed.records ?? []);
    }
  } catch {
    // 文件不存在或解析失败，从头开始
  }

  const existingMaxId = getMaxId(existingRecords);
  console.log(`[PayRecordClient] 已有 ${existingRecords.length} 条记录，最新id=${existingMaxId}`);

  // 回溯窗口：活动退款（标记"已退回"）是在原时期的消费记录上原地修改，不是新建记录。
  // 因此增量更新时，首先按原方案确定"上次更新点"（本地最大 id 对应记录），
  // 再在更新点基础上额外向前回溯 1 周：重新拉取更新点往前 1 周窗口内的记录，
  // 用可能被修改（退款）的最新版本覆盖本地旧记录。
  const RETROSPECT_SECONDS = 7 * 24 * 3600; // 1 周
  // 上次更新点 = 本地最大 id 记录的时间戳（B站记录 id 单调递减，最大 id 即本地最新记录）
  const updatePointTimestamp = (existingMaxId > 0
    ? existingRecords.find((r) => r.id === existingMaxId)?.timestamp
    : undefined) ?? 0;
  // 回溯截止 = 更新点往前 1 周；无本地记录时为 0，等同全量拉取
  const cutoffTimestamp = updatePointTimestamp > 0 ? updatePointTimestamp - RETROSPECT_SECONDS : 0;

  // 纯服务器收集账号（source=server）无 B站 Cookie，无法从 B站 拉取增量，直接读本地缓存
  if (session.source === "server") {
    const cachedSnapshot = buildSnapshot(existingRecords, new Date().toISOString().slice(0, 7).replace("-", ""));
    return existingRecords.length > 0
      ? { code: 0, message: "cached snapshot", data: cachedSnapshot }
      : { code: 0, message: "empty cached", data: cachedSnapshot };
  }

  try {
    // 从 B站 获取新数据（增量）
    const allRecords: PayRecordItem[] = [];
    let nextId: number | undefined;
    let month = "";
    let pageCount = 0;
    const seenIds = new Set<number>();

    do {
      pageCount++;
      if (pageCount > MAX_PAGES) {
        console.log(`[PayRecordClient] 已达到最大页数限制 ${MAX_PAGES}，停止翻页`);
        break;
      }

      const url = buildPayRecordUrl(cookie, nextId);
      const response = await fetchPayRecordPageWithRetry(platform, url, cookie);

      // B站 SESSDATA 失效：返回特殊 code 和 message，让上层（fetchData）调 handleAuthExpired 跳 /login
      // 不在这里 throw，避免 Promise.all 整体 reject 吃掉 accountsRes 的结果
      if (response.code === -101 || response.code === 3 || (response.message && response.message.includes("未登录"))) {
        console.warn(`[PayRecordClient] B站凭证失效（code=${response.code}, msg=${response.message}），需重新登录`);
        return { code: -101, message: "needs-relogin" };
      }

      if (response.code !== 0 || !response.data?.list) {
        throw new Error(response.message || "payRecord request failed");
      }

      const list = response.data.list;
      if (list.length === 0) break;

      if (!month) {
        month = response.data.params?.month || "";
      }

      let hasNewRecord = false;
      let reachedCutoff = false;
      for (const item of list) {
        // 记录按时间倒序返回（新在前）。已回溯超过 1 周窗口（timestamp 早于截止时间），
        // 后续只会更旧，无需再拉取，停止翻页。
        if (cutoffTimestamp > 0 && item.timestamp < cutoffTimestamp) {
          reachedCutoff = true;
          break;
        }
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        allRecords.push(item);
        hasNewRecord = true;
      }

      if (reachedCutoff) {
        console.log(`[PayRecordClient] 第 ${pageCount} 页已回溯超过 1 周窗口，停止翻页（增量+回溯完成）`);
        break;
      }

      if (!hasNewRecord) {
        console.log(`[PayRecordClient] 第 ${pageCount} 页全部重复，停止翻页`);
        break;
      }

      nextId = response.data.params?.next_id;
      console.log(`[PayRecordClient] 第 ${pageCount} 页: ${list.length} 条, nextId=${nextId}`);
      onProgress?.({
        text: `正在获取消费记录，已请求 ${pageCount} 页（${allRecords.length} 条）`,
        current: allRecords.length,
        total: 0,
      });
    } while (nextId);

    // 合并：新记录在前，已有记录在后
    const mergedRecords = existingMaxId > 0
      ? [...allRecords, ...existingRecords]
      : allRecords;

    // 去重
    const seenIds2 = new Set<number>();
    const dedupedRecords = mergedRecords.filter((r) => {
      if (seenIds2.has(r.id)) return false;
      seenIds2.add(r.id);
      return true;
    });

    // 保存到本地文件
    await platform.mkdir(dataDir);
    const totalCoins = dedupedRecords.reduce((sum, r) => {
      const coins = Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0;
      return sum + coins;
    }, 0);
    const fileData = {
      exportedAt: new Date().toISOString(),
      totalRecords: dedupedRecords.length,
      totalCoins,
      records: dedupedRecords,
    };
    await platform.writeFile(recordsPath, JSON.stringify(fileData, null, 2));

    console.log(`[PayRecordClient] 新增 ${allRecords.length} 条，合并后共 ${dedupedRecords.length} 条`);

    const snapshot = buildSnapshot(dedupedRecords, month);
    return { code: 0, message: "real snapshot", data: snapshot };
  } catch (err) {
    console.error("[PayRecordClient] 获取数据失败:", err);

    // 降级：返回已有数据
    if (existingRecords.length > 0) {
      const snapshot = buildSnapshot(
        existingRecords,
        new Date().toISOString().slice(0, 7).replace("-", ""),
      );
      return { code: 0, message: "cached snapshot", data: snapshot };
    }

    return { code: -1, message: err instanceof Error ? err.message : "获取数据失败" };
  }
}

/**
 * 快速模式（本地优先）：只读本地缓存，不发 B站 请求，立即返回。
 * 对应服务器 /api/revenue/pay-record?fast=1 的逻辑。
 */
export async function fetchCachedPayRecords(
  platform: Platform,
): Promise<{ code: number; message: string; data?: PayRecordSnapshot }> {
  const state = await platform.getSessionState();
  const sid = state.currentSid;
  if (!sid) {
    return { code: -1, message: "未登录" };
  }
  const session = state.sessions.find((s) => s.sid === sid);
  if (!session) {
    return { code: -1, message: "会话无效" };
  }

  const recordsPath = `${await platform.getDataDir()}/uid_${session.mid}/pay-records.json`;
  let existingRecords: PayRecordItem[] = [];
  try {
    if (await platform.exists(recordsPath)) {
      const raw = await platform.readFile(recordsPath);
      const parsed = JSON.parse(raw);
      existingRecords = Array.isArray(parsed) ? parsed : (parsed.records ?? []);
    }
  } catch {
    // 文件不存在或解析失败
  }

  if (existingRecords.length === 0) {
    const snapshot = buildSnapshot([], new Date().toISOString().slice(0, 7).replace("-", ""));
    return { code: 0, message: "empty cached", data: snapshot };
  }

  const snapshot = buildSnapshot(existingRecords, new Date().toISOString().slice(0, 7).replace("-", ""));
  return { code: 0, message: "cached snapshot", data: snapshot };
}