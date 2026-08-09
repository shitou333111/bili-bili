/**
 * Tauri 客户端 - 收益记录获取
 * 在 Tauri 环境下，直接调用 B站 API 获取消费记录
 *
 * 逻辑与 src/app/api/revenue/pay-record/route.ts 对应，但运行在客户端。
 */

import type { Platform } from "./platform/types";

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
const PAGE_SIZE = 20;
const MAX_PAGES = 1000;
const REQUEST_RETRY_COUNT = 3;
const REQUEST_BACKOFF_MS = 1000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;

// ==================== MD5 实现（纯 JS，用于客户端签名） ====================

// 端口abl 的 MD5 实现（基于 crypto-js 核心逻辑简化）
function md5(string: string): string {
  function rotateLeft(lValue: number, iShiftBits: number): number {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }
  function addUnsigned(lX: number, lY: number): number {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) {
      return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    }
    if (lX4 | lY4) {
      return lResult ^ 0x40000000 ^ 0x80000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }
  function F(x: number, y: number, z: number): number { return (x & y) | ((~x) & z); }
  function G(x: number, y: number, z: number): number { return (x & z) | (y & (~z)); }
  function H(x: number, y: number, z: number): number { return x ^ y ^ z; }
  function I(x: number, y: number, z: number): number { return y ^ (x | (~z)); }
  function FF(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function GG(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function HH(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function II(a: number, b: number, c: number, d: number, x: number, s: number, ac: number): number {
    a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
    return addUnsigned(rotateLeft(a, s), b);
  }
  function convertToWordArray(str: string): number[] {
    const lWordCount = ((str.length + 8 - (str.length + 8) % 64) / 64 + 1) * 16;
    const lWordArray: number[] = new Array(lWordCount - 1);
    let lBytePosition = 0;
    let lByteCount = 0;
    while (lByteCount < str.length) {
      lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordPosition] = (lWordArray[lWordPosition] | (str.charCodeAt(lByteCount) << lBytePosition));
      lByteCount++;
    }
    lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordPosition] = lWordArray[lWordPosition] | (0x80 << lBytePosition);
    lWordArray[lWordCount - 2] = str.length << 3;
    lWordArray[lWordCount - 1] = str.length >>> 29;
    return lWordArray;
  }
  function wordToHex(lValue: number): string {
    let wordToHexValue = "";
    let wordToHexValueTemp = "";
    for (let lCount = 0; lCount <= 3; lCount++) {
      lByte = (lValue >>> (lCount * 8)) & 255;
      wordToHexValueTemp = "0" + lByte.toString(16);
      wordToHexValue = wordToHexValue + wordToHexValueTemp.substr(wordToHexValueTemp.length - 2, 2);
    }
    return wordToHexValue;
  }
  let lWordPosition: number;
  let lByte: number;
  const x = convertToWordArray(string);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478);
    d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
    c = FF(c, d, a, b, x[k + 2], S13, 0x242070db);
    b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf);
    d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
    c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613);
    b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8);
    d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
    c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1);
    b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122);
    d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
    c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e);
    b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562);
    d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
    c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51);
    b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d);
    d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
    c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681);
    b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6);
    d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
    c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87);
    b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905);
    d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
    c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9);
    b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942);
    d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
    c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122);
    b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44);
    d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
    c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60);
    b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6);
    d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
    c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085);
    b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039);
    d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
    c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8);
    b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244);
    d = II(d, a, b, c, x[k + 13], S42, 0x432aff97);
    c = II(c, d, a, b, x[k + 10], S43, 0xab9423a7);
    b = II(b, c, d, a, x[k + 7], S44, 0xfc93a039);
    a = II(a, b, c, d, x[k + 4], S41, 0x655b59c3);
    d = II(d, a, b, c, x[k + 1], S42, 0x8f0ccc92);
    c = II(c, d, a, b, x[k + 14], S43, 0xffeff47d);
    b = II(b, c, d, a, x[k + 11], S44, 0x85845dd1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f);
    d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
    c = II(c, d, a, b, x[k + 6], S43, 0xa3014314);
    b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
    a = II(a, b, c, d, x[k + 2], S41, 0xf7537e82);
    d = II(d, a, b, c, x[k + 9], S42, 0xbd3af235);
    c = II(c, d, a, b, x[k + 0], S43, 0x2ad7d2bb);
    b = II(b, c, d, a, x[k + 5], S44, 0xeb86d391);
    a = addUnsigned(a, AA);
    b = addUnsigned(b, BB);
    c = addUnsigned(c, CC);
    d = addUnsigned(d, DD);
  }
  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
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

  const cookie = session.biliCookies?.length
    ? session.biliCookies.join("; ")
    : `SESSDATA=${session.biliSessdata}`;

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

      if (response.code !== 0 || !response.data?.list) {
        throw new Error(response.message || "payRecord request failed");
      }

      const list = response.data.list;
      if (list.length === 0) break;

      if (!month) {
        month = response.data.params?.month || "";
      }

      let hasNewRecord = false;
      let reachedExisting = false;
      for (const item of list) {
        // 已命中本地已有记录（id 单调递减，遇到 <= existingMaxId 即后续均为旧数据），停止翻页
        if (existingMaxId > 0 && item.id <= existingMaxId) {
          reachedExisting = true;
          break;
        }
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        allRecords.push(item);
        hasNewRecord = true;
      }

      if (reachedExisting) {
        console.log(`[PayRecordClient] 第 ${pageCount} 页已命中已有记录，停止翻页（增量完成）`);
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