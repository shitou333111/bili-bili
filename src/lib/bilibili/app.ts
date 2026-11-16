import { createHash } from "crypto";
import { fetchBilibiliJson } from "@/lib/bilibili/client";
import type { AuthSession } from "@/lib/auth/session";
import type { PayRecordSnapshot } from "@/lib/revenue";

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

const DEFAULT_APP_KEY = "1d8b6e7d45233436";
const DEFAULT_APP_SECRET = process.env.BILI_APP_SECRET || "560c52ccd288fed045859ed18bffd973";

function formatCoin(value: string) {
  return Number(value.replace(/,/g, "")) || 0;
}

function signParams(params: Record<string, string>) {
  const sortedEntries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  const query = sortedEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return createHash("md5").update(`${query}${DEFAULT_APP_SECRET}`).digest("hex");
}

function buildPayRecordUrl(session: AuthSession, nextId?: number) {
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
    page_size: "50", // B站上限 50（实测 page_size=100 也只返回 50 条/页）
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
  return {
    url: url.toString(),
    cookie: session.biliCookies?.length
      ? session.biliCookies.join("; ")
      : `SESSDATA=${session.biliSessdata}`,
  };
}

const REQUEST_RETRY_COUNT = 3;
const REQUEST_BACKOFF_MS = 1000;
/**
 * 翻页节流（与客户端 src/lib/pay-record-client.ts 保持一致）：
 * 实测 200ms/页会触发账号级 412 封禁（约 18 分钟自动解除），500ms/页 可安全跑完 281 页，
 * 这里取 1000ms 留一倍余量。全量只在首次拉取，慢一点可以接受（406 页 ≈ 7 分钟，
 * 与 nginx 对 /api/revenue/pay-record 放的 900s 超时匹配）。
 */
const PAGE_INTERVAL_MS = 500;
/** 本轮已触发过 412 后，剩余翻页改用更保守的间隔 */
const PAGE_INTERVAL_AFTER_412_MS = 3000;
/**
 * 412 冷却：短冷却（之前 10s × 3 次）在账号级封禁（实测 ~18 分钟）面前毫无意义，
 * 改成 8 分钟 → 15 分钟，最多 2 次，期间不放弃本次拉取。
 */
const RATE_LIMIT_RETRY_COUNT = 2;
const RATE_LIMIT_COOLDOWN_MS = 8 * 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 15 * 60_000;
/** B站 风控/限流业务码：HTTP 200 但 code 非 0，冷却重试同一页即可恢复 */
const RISK_LIMIT_CODES = new Set([-352, -412, -509, -799]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单页请求带重试。
 * - 网络抖动：1s/2s/4s 指数退避，最多 3 次；
 * - 412 / 风控业务码：账号级限流，冷却 8~15 分钟后再试（最多 2 次），
 *   并通过 onRateLimit 让调用方降低后续翻页速率。
 * 大账号要连续翻数百页（如 2 万条 ≈ 406 页），结尾任意一页失败都不应让整批已拉到的数据前功尽弃。
 */
async function fetchPayRecordPageWithRetry(
  url: string,
  cookie: string,
  onRateLimit?: () => void,
): Promise<PayRecordResponse> {
  let lastErr: unknown;
  let networkAttempt = 0;
  let rateLimitHits = 0;

  const coolDown = async (reason: string): Promise<boolean> => {
    rateLimitHits++;
    onRateLimit?.();
    if (rateLimitHits > RATE_LIMIT_RETRY_COUNT) return false;
    const cooldown = Math.min(
      RATE_LIMIT_COOLDOWN_MS * Math.pow(2, rateLimitHits - 1),
      RATE_LIMIT_MAX_COOLDOWN_MS,
    );
    console.warn(
      `[PayRecord] ${reason}（第 ${rateLimitHits}/${RATE_LIMIT_RETRY_COUNT} 次），冷却 ${Math.round(cooldown / 1000)}s 后重试`,
    );
    await sleep(cooldown);
    return true;
  };

  for (;;) {
    try {
      const response = await fetchBilibiliJson<PayRecordResponse>({ url, cookie, mobile: true });
      if (RISK_LIMIT_CODES.has(response.code)) {
        if (await coolDown(`触发限流/风控 code=${response.code} ${response.message || ""}`)) continue;
      }
      return response;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("412")) {
        if (await coolDown("触发 412 限流")) continue;
        break;
      }
      networkAttempt++;
      if (networkAttempt > REQUEST_RETRY_COUNT) break;
      const delay = REQUEST_BACKOFF_MS * Math.pow(2, networkAttempt - 1);
      console.warn(`[PayRecord] 请求失败，等待 ${delay}ms 后重试 ${networkAttempt}/${REQUEST_RETRY_COUNT}：${message}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function fetchRealPayRecordSnapshot(
  session: AuthSession,
  _nextId?: number,
  cutoffTimestamp?: number,
  onProgress?: (p: { text: string; current?: number; total?: number }) => void,
): Promise<PayRecordSnapshot> {
  if (!session.biliSessdata) {
    throw new Error("SESSDATA 不能为空");
  }

  const MAX_PAGES = 1000;
  const allRecords: PayRecordItem[] = [];
  let nextId: number | undefined = _nextId;
  let prevNextId: number | undefined;
  let month = "";
  let pageCount = 0;
  let actualPageSize = 0; // 首页实际返回条数：作为"每页容量"基准，避免 B站 忽略 page_size 时误判末页
  const seenIds = new Set<number>();
  /** 本轮是否已触发过限流：触发后剩余翻页降速 */
  let sawRateLimit = false;

  // 自动翻页，直到没有更多记录
  do {
    pageCount++;

    // 安全检查：超过最大页数
    if (pageCount > MAX_PAGES) {
      console.log(`[PayRecord] 已达到最大页数限制 ${MAX_PAGES}，停止翻页`);
      break;
    }

    const { url, cookie } = buildPayRecordUrl(session, nextId);
    const response = await fetchPayRecordPageWithRetry(url, cookie, () => {
      sawRateLimit = true;
    });

    if (response.code !== 0 || !response.data?.list) {
      throw new Error(response.message || "payRecord request failed");
    }

    const list = response.data.list;
    if (list.length === 0) {
      console.log(`[PayRecord] 第${pageCount}页返回空列表，停止翻页`);
      break;
    }

    // 以首页实际返回条数作为每页容量基准（B站可能不遵循 page_size 参数，按默认20返回）
    if (actualPageSize === 0) actualPageSize = list.length;

    // 检查是否有新记录（去重），并按回溯时间窗口停止翻页
    let newCount = 0;
    let reachedCutoff = false;
    for (const item of list) {
      // 记录按时间倒序返回（新在前）。已回溯超过窗口（timestamp 早于截止时间），后续只会更旧，停止。
      if (cutoffTimestamp && item.timestamp < cutoffTimestamp) {
        reachedCutoff = true;
        break;
      }
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        allRecords.push(item);
        newCount++;
      }
    }
    // Stop if we reached the retrospective cutoff
    if (reachedCutoff) {
      console.log(`[PayRecord] 已回溯超过回溯窗口，停止翻页（增量+回溯完成）`);
      break;
    }

    month = response.data.params?.month ?? month;
    prevNextId = nextId;
    nextId = response.data.params?.next_id;

    console.log(`[PayRecord] 第${pageCount}页获取完成，本页${list.length}条（新增${newCount}条），累计${allRecords.length}条，nextId=${nextId ?? "无"}`);

    // 上报页级进度（WEB 端经 pay-record-progress 内存表 + 轮询抵达前端，文案与 APP 一致）
    onProgress?.({
      text: `正在获取消费记录，已请求 ${pageCount} 页（${allRecords.length} 条）`,
      current: allRecords.length,
      total: 0,
    });

    // 如果没有新记录，说明已经获取完所有数据
    if (newCount === 0) {
      console.log(`[PayRecord] 无新增记录，停止翻页`);
      break;
    }

    // 如果 next_id 不再变化，说明已到末尾
    if (nextId === prevNextId) {
      console.log(`[PayRecord] next_id 未变化，停止翻页`);
      break;
    }

    // 如果返回记录数少于每页实际容量，说明是最后一页
    if (list.length < actualPageSize) {
      console.log(`[PayRecord] 本页不足${actualPageSize}条，已到最后一页`);
      break;
    }

    // 页间主动降速：连续数百次请求是触发 412 的主因（见 PAGE_INTERVAL_MS 注释）。
    // 放在所有 break 判断之后，最后一页无需再等。
    await sleep(sawRateLimit ? PAGE_INTERVAL_AFTER_412_MS : PAGE_INTERVAL_MS);
  } while (nextId && nextId > 0);

  // 按时间戳降序排列（最新在前）
  allRecords.sort((a, b) => b.timestamp - a.timestamp);

  const records = allRecords.map((record) => ({
    ...record,
    totalCoins: formatCoin(record.pay_coin || record.coin),
    giftNameKey: record.gift_name,
  }));

  const giftCatalog = Array.from(
    records.reduce((map, record) => {
      if (!map.has(record.giftNameKey)) {
        map.set(record.giftNameKey, {
          giftName: record.gift_name,
          giftImg: record.gift_img,
          giftId: record.gift_id,
          latestTimestamp: record.timestamp,
        });
      }
      return map;
    }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>()).values(),
  );

  const totalCoins = records.reduce((sum, record) => sum + record.totalCoins, 0);

  console.log(`[PayRecord] 全部获取完成，共${pageCount}页，${records.length}条记录，${totalCoins}电池`);

  return {
    source: "real",
    month: month || new Date().toISOString().slice(0, 7).replace("-", ""),
    nextId: records.length > 0 ? records[records.length - 1].id : 0,
    totalRecords: records.length,
    totalCoins,
    giftCatalog,
    records,
  };
}

export async function fetchSnapshotWithFallback(session: AuthSession | null) {
  if (!session) {
    throw new Error("未登录");
  }
  if (!session.biliSessdata) {
    throw new Error("缺少 SESSDATA");
  }

  // 不传 nextId，从第一页（最新记录）开始，自动翻页获取全部
  return fetchRealPayRecordSnapshot(session);
}
