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
/** 大账号（数百页）拉取时的落盘间隔：每 N 页把手头记录写盘并记录断点，中断后不必从头再来 */
const CHECKPOINT_PAGES = 20;
const REQUEST_RETRY_COUNT = 3;
/** 网络瞬时失败重试间隔：1s → 2s → 4s（限流加强后，短间隔重试只会更快撞墙） */
const REQUEST_BACKOFF_MS = 1000;
/**
 * 412 限流：账号级封禁（实测同一出口 IP 的其他账号正常，只有被限流的账号持续 412，
 * 封禁约 18 分钟自动解除，期间继续请求不会延长封禁）。
 * 冷却 8 分钟 → 15 分钟，最多 2 次；仍失败就先落盘已拉数据，下次刷新从断点续拉。
 */
const RATE_LIMIT_RETRY_COUNT = 2;
const RATE_LIMIT_COOLDOWN_MS = 8 * 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 15 * 60_000;
/**
 * 翻页节流（实测数据，账号 I-2-3，281 页 / 13987 条，从零全量）：
 * - 200ms/页（旧值，约 5 次/秒）：触发账号级 412 封禁，约 18 分钟自动解除；
 * - 500ms/页：全量 173s，0 次 412；
 * - 1000ms/页：全量 316s，0 次 412；
 * - 1500ms/页：全量 447s，0 次 412。
 * 取其 1000ms 作为默认值（比验证过的 500ms 再留一倍余量，代价只多 2.5 分钟；
 * 全量只在首次拉取，慢一点可以接受）。想更快可改回 500。
 */
const PAGE_INTERVAL_MS = 500;
/** 本轮已触发过 412 后，剩余翻页改用更保守的间隔 */
const PAGE_INTERVAL_AFTER_412_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** B站 风控/限流业务码：HTTP 200 但 code 非 0，冷却重试即可恢复，不能直接判死整批拉取 */
const RISK_LIMIT_CODES = new Set([-352, -412, -509, -799]);

/**
 * 带重试的 payRecord 请求。
 * - 网络瞬时失败（Tauri HTTP 插件连接/TLS 抖动）指数退避，最多 3 次；
 * - 限流（HTTP 412 或 code -352/-412/-509/-799 风控）是账号级封禁（实测持续约 18 分钟），
 *   短间隔重试没有意义：长冷却后最多再试 2 次，仍失败就先落盘、下次刷新从断点续拉；
 * - onRateLimit 让调用方降低后续翻页速率，并把等待状态展示给用户。
 */
async function fetchPayRecordPageWithRetry(
  platform: Platform,
  url: string,
  cookie: string,
  onRateLimit?: (message: string) => void,
): Promise<PayRecordResponse> {
  let lastErr: unknown;
  let networkAttempt = 0;
  let rateLimitHits = 0;

  const coolDown = async (reason: string): Promise<boolean> => {
    rateLimitHits++;
    if (rateLimitHits > RATE_LIMIT_RETRY_COUNT) {
      onRateLimit?.(`${reason}，已停止本次拉取（已拉到的记录已保存，下次刷新继续）`);
      return false;
    }
    const cooldown = Math.min(
      RATE_LIMIT_COOLDOWN_MS * Math.pow(2, rateLimitHits - 1),
      RATE_LIMIT_MAX_COOLDOWN_MS,
    );
    console.warn(
      `[PayRecordClient] ${reason}（第 ${rateLimitHits}/${RATE_LIMIT_RETRY_COUNT} 次），冷却 ${cooldown}ms 后重试`,
    );
    onRateLimit?.(`${reason}，等待约 ${Math.round(cooldown / 60_000)} 分钟后自动重试（已拉取的数据不会丢失）`);
    await sleep(cooldown);
    return true;
  };

  for (;;) {
    try {
      const response = await platform.fetchBilibiliJson<PayRecordResponse>({
        url,
        cookie,
        mobile: true,
      });
      // 风控/限流业务码：冷却重试同一页，而不是把它当业务错误整批丢弃
      if (RISK_LIMIT_CODES.has(response.code)) {
        const retry = await coolDown(`触发限流/风控 code=${response.code} ${response.message || ""}`);
        if (retry) continue;
      }
      // 其他情况（含 0 / 未登录 / 真业务错误）交由调用方处理
      return response;
    } catch (err: any) {
      lastErr = err;
      if (err?.message?.includes("412")) {
        const retry = await coolDown("触发 412 限流");
        if (retry) continue;
        break;
      }
      networkAttempt++;
      if (networkAttempt > REQUEST_RETRY_COUNT) break;
      const delay = REQUEST_BACKOFF_MS * Math.pow(2, networkAttempt - 1);
      console.warn(
        `[PayRecordClient] 请求失败，等待 ${delay}ms 后重试 ${networkAttempt}/${REQUEST_RETRY_COUNT}: ${err?.message || err}`,
      );
      await sleep(delay);
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

  // 读取已有记录 + 上次中断留下的"续拉游标"（pullCursor.nextId）
  let existingRecords: PayRecordItem[] = [];
  let pendingCursor = 0;
  try {
    if (await platform.exists(recordsPath)) {
      const raw = await platform.readFile(recordsPath);
      const parsed = JSON.parse(raw);
      existingRecords = Array.isArray(parsed) ? parsed : (parsed.records ?? []);
      if (!Array.isArray(parsed)) pendingCursor = Number(parsed?.pullCursor?.nextId) || 0;
    }
  } catch {
    // 文件不存在或解析失败，从头开始
  }

  const existingMaxId = getMaxId(existingRecords);
  console.log(
    `[PayRecordClient] 已有 ${existingRecords.length} 条记录，最新id=${existingMaxId}` +
      (pendingCursor > 0 ? `，待续拉游标=${pendingCursor}` : ""),
  );

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

  // 本次已拉到的记录 / 月份 / 断点游标：catch 中也要用（中断时先落盘再降级）
  const allRecords: PayRecordItem[] = [];
  let month = "";
  let resumeCursor = pendingCursor;
  const seenIds = new Set<number>();
  let pageCount = 0;
  /** 翻页间隔（触发 412 后自动加大，两段拉取共用） */
  let pageInterval = PAGE_INTERVAL_MS;

  /** 合并本次拉到的新记录与本地已有记录（新在前、按 id 去重、时间倒序）。 */
  const mergeFetched = (fresh: PayRecordItem[]): PayRecordItem[] => {
    const merged = existingMaxId > 0 ? [...fresh, ...existingRecords] : fresh;
    const seen = new Set<number>();
    const list = merged.filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    // 断点续拉会把更早的记录追加在后面，统一按时间倒序保证"新 → 旧"
    list.sort((a, b) => b.timestamp - a.timestamp);
    return list;
  };

  /** 落盘（cursor > 0 = 还有更深处没拉完，下次刷新从这里续拉）。 */
  const persistRecords = async (list: PayRecordItem[], cursor: number) => {
    await platform.mkdir(dataDir);
    const totalCoins = list.reduce((sum, r) => {
      const coins = Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0;
      return sum + coins;
    }, 0);
    await platform.writeFile(
      recordsPath,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          totalRecords: list.length,
          totalCoins,
          records: list,
          ...(cursor > 0 ? { pullCursor: { nextId: cursor } } : {}),
        },
        null,
        2,
      ),
    );
  };

  try {
    /**
     * 翻页拉取。
     * @param startNextId 起始游标（undefined = 从最新记录开始）
     * @param useCutoff 是否在回溯窗口处停止；续拉历史阶段必须关掉
     *                  （深处的记录本来就早于窗口，否则一进循环就停，永远补不完）
     */
    const fetchPages = async (
      startNextId: number | undefined,
      useCutoff: boolean,
    ): Promise<"ok" | "auth"> => {
      let nextId: number | undefined = startNextId;
      let prevNextId: number | undefined;
      do {
        pageCount++;
        if (pageCount > MAX_PAGES) {
          console.log(`[PayRecordClient] 已达到最大页数限制 ${MAX_PAGES}，停止翻页`);
          return "ok";
        }

        // 页间主动降速：几百页连打最容易触发 412，一旦被限流整批拉取就得降级成部分数据
        if (pageCount > 1 && pageInterval > 0) await sleep(pageInterval);

        const url = buildPayRecordUrl(cookie, nextId);
        const response = await fetchPayRecordPageWithRetry(platform, url, cookie, (message) => {
          pageInterval = PAGE_INTERVAL_AFTER_412_MS;
          onProgress?.({ text: message, current: allRecords.length, total: 0 });
        });

        // B站 SESSDATA 失效：返回特殊 code 和 message，让上层（fetchData）调 handleAuthExpired 跳 /login
        // 不在这里 throw，避免 Promise.all 整体 reject 吃掉 accountsRes 的结果
        if (response.code === -101 || response.code === 3 || (response.message && response.message.includes("未登录"))) {
          console.warn(`[PayRecordClient] B站凭证失效（code=${response.code}, msg=${response.message}），需重新登录`);
          return "auth";
        }

        if (response.code !== 0 || !response.data?.list) {
          throw new Error(response.message || "payRecord request failed");
        }

        const list = response.data.list;
        if (list.length === 0) {
          resumeCursor = 0;
          return "ok";
        }

        if (!month) {
          month = response.data.params?.month || "";
        }

        let hasNewRecord = false;
        let reachedCutoff = false;
        for (const item of list) {
          // 记录按时间倒序返回（新在前）。已回溯超过 1 周窗口（timestamp 早于截止时间），
          // 后续只会更旧，无需再拉取，停止翻页。
          if (useCutoff && cutoffTimestamp > 0 && item.timestamp < cutoffTimestamp) {
            reachedCutoff = true;
            break;
          }
          if (seenIds.has(item.id)) continue;
          seenIds.add(item.id);
          allRecords.push(item);
          hasNewRecord = true;
        }

        const next = response.data.params?.next_id;
        resumeCursor = next ?? 0;

        // 游标原地打转（B站 偶发返回同一个 next_id）：说明已经翻到尽头，再请求只会重复
        if (next && next === prevNextId) {
          console.log(`[PayRecordClient] 第 ${pageCount} 页 next_id 未变化（${next}），已到末尾，停止翻页`);
          resumeCursor = 0;
          return "ok";
        }
        prevNextId = next;

        if (reachedCutoff) {
          console.log(`[PayRecordClient] 第 ${pageCount} 页已回溯超过 1 周窗口，停止翻页（增量+回溯完成）`);
          resumeCursor = 0;
          return "ok";
        }
        if (!next) return "ok";
        if (!hasNewRecord) {
          console.log(`[PayRecordClient] 第 ${pageCount} 页全部重复，停止翻页`);
          resumeCursor = 0;
          return "ok";
        }

        console.log(`[PayRecordClient] 第 ${pageCount} 页: ${list.length} 条, nextId=${next}`);
        onProgress?.({
          text: `正在获取消费记录，已请求 ${pageCount} 页（${allRecords.length} 条）`,
          current: allRecords.length,
          total: 0,
        });

        // 大账号（数百页）：每 20 页落盘一次。中途失败/退出也不必从零重来，界面更不会归零
        if (pageCount % CHECKPOINT_PAGES === 0) {
          await persistRecords(mergeFetched(allRecords), resumeCursor);
        }

        nextId = next;
      } while (nextId);

      return "ok";
    };

    // 第一段：从最新记录开始做增量（带 1 周回溯窗口）
    if ((await fetchPages(undefined, cutoffTimestamp > 0)) === "auth") {
      return { code: -101, message: "needs-relogin" };
    }

    // 第二段：上次在更深处中断过 → 从断点继续把历史补齐（不带窗口限制）
    if (pendingCursor > 0) {
      resumeCursor = pendingCursor;
      console.log(`[PayRecordClient] 从断点 nextId=${pendingCursor} 继续补拉历史记录`);
      if ((await fetchPages(pendingCursor, false)) === "auth") {
        return { code: -101, message: "needs-relogin" };
      }
    }

    const mergedRecords = mergeFetched(allRecords);
    await persistRecords(mergedRecords, resumeCursor);

    console.log(
      `[PayRecordClient] 新增 ${allRecords.length} 条，合并后共 ${mergedRecords.length} 条` +
        (resumeCursor > 0 ? `（历史仍未拉完，已记录断点 nextId=${resumeCursor}）` : ""),
    );

    const snapshot = buildSnapshot(
      mergedRecords,
      month || new Date().toISOString().slice(0, 7).replace("-", ""),
    );
    return { code: 0, message: "real snapshot", data: snapshot };
  } catch (err) {
    console.error("[PayRecordClient] 获取数据失败:", err);

    // 中断降级：本次已拉到的记录先落盘并返回，绝不因为尾部失败把整批数据丢掉（大账号 400+ 页尤其可惜）
    if (allRecords.length > 0) {
      try {
        const mergedRecords = mergeFetched(allRecords);
        await persistRecords(mergedRecords, resumeCursor);
        const snapshot = buildSnapshot(
          mergedRecords,
          month || new Date().toISOString().slice(0, 7).replace("-", ""),
        );
        console.warn(
          `[PayRecordClient] 已中断，先把已拉到的 ${mergedRecords.length} 条落盘返回` +
            (resumeCursor > 0 ? `，下次从 nextId=${resumeCursor} 续拉` : ""),
        );
        return { code: 0, message: "partial snapshot", data: snapshot };
      } catch (saveErr) {
        console.error("[PayRecordClient] 中断记录落盘失败:", saveErr);
      }
    }

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