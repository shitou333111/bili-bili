/**
 * Tauri 客户端 - 主播礼物数据获取
 * 
 * 在 Tauri 环境下，直接调用 B站 API（通过平台层解决 CORS），
 * 数据存储在本地文件系统。
 * 
 * 逻辑与 src/app/api/anchor/gifts/route.ts 对应，但运行在客户端。
 */

import type { Platform } from "./platform/types";
import type { AuthSession } from "./auth/session";

// 类型定义（与 API route 保持一致）
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
    total_page: number;
    total_count: number;
    total_hamster: number;
    list: BiliGiftRecord[];
  };
};

// 常量
const REQUEST_INTERVAL_MS = 1500;
const SLOW_REQUEST_INTERVAL_MS = 4000;
const PAGE_RETRY_COUNT = 3;
const PAGE0_RETRY_COUNT = 5;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const MONTH_CONCURRENCY = 1;
const CONSECUTIVE_MATCH_THRESHOLD = 5;

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function generateMonthChunks(start: string, end: string): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  const startDate = new Date(
    parseInt(start.slice(0, 4)),
    parseInt(start.slice(4, 6)) - 1,
    parseInt(start.slice(6, 8)),
  );
  const endDate = new Date(
    parseInt(end.slice(0, 4)),
    parseInt(end.slice(4, 6)) - 1,
    parseInt(end.slice(6, 8)),
  );

  let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  while (current <= endDate) {
    const year = current.getFullYear();
    const month = current.getMonth() + 1;
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    if (lastDay > endDate) {
      chunks.push({
        start: formatDate(firstDay),
        end: formatDate(endDate),
      });
    } else {
      chunks.push({
        start: formatDate(firstDay),
        end: formatDate(lastDay),
      });
    }
    current.setMonth(current.getMonth() + 1);
  }
  return chunks;
}

function getYesterdayStr(): string {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijing = new Date(utc + 8 * 3600000);
  beijing.setDate(beijing.getDate() - 1);
  return formatDate(beijing);
}

function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

function recordKey(r: BiliGiftRecord): string {
  return `${r.uid}|${r.time}|${r.gift_id}|${r.num}`;
}

function buildRecordKeyCounter(records: BiliGiftRecord[]): Map<string, number> {
  const counter = new Map<string, number>();
  for (const r of records) {
    const key = recordKey(r);
    counter.set(key, (counter.get(key) ?? 0) + 1);
  }
  return counter;
}

async function fetchGiftStreamPage(
  platform: Platform,
  cookie: string,
  csrf: string,
  page: number,
  begin: string,
  end: string,
  buvidCookie?: string,
): Promise<BiliGiftStreamResponse> {
  const url = `https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getGiftStreamList?${new URLSearchParams({
    page: String(page),
    begin,
    end,
    csrf,
    csrf_token: csrf,
  }).toString()}`;

  let fullCookie = cookie;
  if (buvidCookie) {
    fullCookie = `${cookie}; ${buvidCookie}`;
  }

  return platform.fetchBilibiliJson<BiliGiftStreamResponse>({
    url,
    cookie: fullCookie,
    live: true,
  });
}

/**
 * Tauri 客户端拉取主播礼物数据
 * 
 * 流程：
 * 1. 从 platform store 读取当前 session
 * 2. 验证 B站 凭证
 * 3. 读取已有记录和元数据
 * 4. 计算需要拉取的月份范围
 * 5. 逐月拉取 B站 API
 * 6. 保存到本地文件
 * 7. 上传到服务器
 */
export async function fetchAnchorGifts(
  platform: Platform,
  refresh?: boolean,
): Promise<unknown> {
  const state = await platform.getSessionState();
  const sid = state.currentSid;
  if (!sid) {
    return { code: -1, message: "未登录" };
  }

  const session = state.sessions.find((s) => s.sid === sid);
  if (!session) {
    return { code: -1, message: "会话无效" };
  }

  // 验证 B站 凭证
  const cookie = session.biliCookies?.length
    ? session.biliCookies.join("; ")
    : `SESSDATA=${session.biliSessdata}`;

  try {
    const navResult = await platform.fetchBilibiliJson<{
      code: number;
      data?: { isLogin: boolean };
    }>({
      url: "https://api.bilibili.com/x/web-interface/nav",
      cookie,
    });

    if (navResult.code !== 0 || !navResult.data?.isLogin) {
      return { code: -1, message: "B站凭证已失效，请重新登录" };
    }
  } catch {
    return { code: -1, message: "B站凭证验证失败" };
  }

  const csrf = session.biliCookies
    ?.find((c) => c.startsWith("bili_jct="))
    ?.split("=")[1] ?? "";

  // 读取已有记录和元数据
  const dataDir = `${platform.getDataDir()}/uid_${session.mid}_${session.uname.replace(/[\\/:*?"<>|]/g, "_")}`;
  const recordsPath = `${dataDir}/anchor-gifts-records.json`;

  let existingRecords: BiliGiftRecord[] = [];
  let meta: { end_date?: string; total_page?: number } | null = null;

  if (await platform.exists(recordsPath)) {
    try {
      const raw = await platform.readFile(recordsPath);
      const parsed = JSON.parse(raw);
      existingRecords = parsed.records ?? [];
      if (parsed.end_date) {
        meta = { end_date: parsed.end_date, total_page: parsed.total_page };
      }
    } catch {}
  }

  const yesterdayStr = getYesterdayStr();

  // 计算起始日期
  const startDate = (() => {
    if (meta?.end_date && !refresh) {
      return meta.end_date;
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

  if (startDate > yesterdayStr) {
    return { code: 0, data: { records: existingRecords, newPages: 0 } };
  }

  const buvidCookie = await platform.getBuvidCookie().catch(() => "");
  const chunks = generateMonthChunks(startDate, yesterdayStr);

  console.log(`[AnchorGifts-Tauri] 获取数据: ${startDate} ~ ${yesterdayStr}, ${chunks.length}个月`);

  const existingKeyCounter = existingRecords.length > 0
    ? buildRecordKeyCounter(existingRecords)
    : undefined;

  let allRecords = [...existingRecords];
  let fetchedPages = 0;
  let hasNewRecords = false;

  // 逐月拉取（并发数=1 避免限流）
  for (const chunk of chunks) {
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
        if (result.code === 1301000) {
          console.log(`[AnchorGifts-Tauri] ${chunk.start}~${chunk.end} 数据已过期，跳过`);
          break;
        }
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      } catch (err: any) {
        if (err?.message?.includes("412")) {
          rateLimited = true;
          await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
        } else {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    if (!firstPage || firstPage.code === 1301000) continue;

    const totalPages = firstPage.data?.total_page ?? 0;
    if (totalPages === 0) continue;

    if (firstPage.data?.list?.length) {
      records.push(...firstPage.data.list);
    }

    // 翻页
    for (let p = 1; p < totalPages; p++) {
      // 连续匹配检测
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
            await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS + attempt * 10_000));
          } else {
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
      }
      if (!success) {
        // 保存部分数据，下次继续
        const allSorted = allRecords.sort((a, b) => b.time.localeCompare(a.time));
        await platform.writeFile(recordsPath, JSON.stringify({
          last_fetch: getBeijingTime(),
          end_date: chunk.start,
          total_page: (meta?.total_page ?? 0) + fetchedPages,
          total_count: allSorted.length,
          records: allSorted,
        }, null, 2));
        return { code: 0, data: { records: allSorted, newPages: fetchedPages, partial: true } };
      }
    }

    // 去重并合并
    for (const r of records) {
      if (existingKeyCounter) {
        const key = recordKey(r);
        const existingCount = existingKeyCounter.get(key) ?? 0;
        if (existingCount > 0) {
          existingKeyCounter.set(key, existingCount - 1);
          continue;
        }
      }
      allRecords.push(r);
      hasNewRecords = true;
    }
    fetchedPages += Math.min(records.length > 0 ? 1 : 0, totalPages);
  }

  const allSorted = allRecords.sort((a, b) => b.time.localeCompare(a.time));
  await platform.writeFile(recordsPath, JSON.stringify({
    last_fetch: getBeijingTime(),
    end_date: yesterdayStr,
    total_page: (meta?.total_page ?? 0) + fetchedPages,
    total_count: allSorted.length,
    records: allSorted,
  }, null, 2));

  // 上传到服务器
  if (hasNewRecords) {
    try {
      const files: Record<string, string> = {};
      files["anchor-gifts-records.json"] = JSON.stringify({
        last_fetch: getBeijingTime(),
        end_date: yesterdayStr,
        total_count: allSorted.length,
        records: allSorted,
      });
      await platform.uploadUserData(session.mid, session.uname, files);
      console.log("[AnchorGifts-Tauri] 数据已上传到服务器");
    } catch (err) {
      console.warn("[AnchorGifts-Tauri] 数据上传失败:", err);
    }
  }

  return { code: 0, data: { records: allSorted, newPages: fetchedPages } };
}