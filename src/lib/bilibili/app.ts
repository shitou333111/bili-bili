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
    page_size: "20",
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

export async function fetchRealPayRecordSnapshot(
  session: AuthSession,
  _nextId?: number,
  existingMaxId?: number,
): Promise<PayRecordSnapshot> {
  if (!session.biliSessdata) {
    throw new Error("SESSDATA 不能为空");
  }

  const PAGE_SIZE = 20;
  const MAX_PAGES = 1000;
  const allRecords: PayRecordItem[] = [];
  let nextId: number | undefined = _nextId;
  let prevNextId: number | undefined;
  let month = "";
  let pageCount = 0;
  const seenIds = new Set<number>();

  // 自动翻页，直到没有更多记录
  do {
    pageCount++;

    // 安全检查：超过最大页数
    if (pageCount > MAX_PAGES) {
      console.log(`[PayRecord] 已达到最大页数限制 ${MAX_PAGES}，停止翻页`);
      break;
    }

    const { url, cookie } = buildPayRecordUrl(session, nextId);
    const response = await fetchBilibiliJson<PayRecordResponse>({
      url,
      cookie,
      mobile: true,
    });

    if (response.code !== 0 || !response.data?.list) {
      throw new Error(response.message || "payRecord request failed");
    }

    const list = response.data.list;
    if (list.length === 0) {
      console.log(`[PayRecord] 第${pageCount}页返回空列表，停止翻页`);
      break;
    }

    // 检查是否有新记录（去重），并检查与已有数据的重叠
    let newCount = 0;
    let hasOverlap = false;
    for (const item of list) {
      if (existingMaxId && item.id <= existingMaxId) {
        hasOverlap = true;
        continue; // Skip this record (already exists)
      }
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        allRecords.push(item);
        newCount++;
      }
    }
    // Stop if we found overlap
    if (hasOverlap) {
      console.log(`[PayRecord] 与已有数据重叠，停止翻页（已有最大id=${existingMaxId}）`);
      break;
    }

    month = response.data.params?.month ?? month;
    prevNextId = nextId;
    nextId = response.data.params?.next_id;

    console.log(`[PayRecord] 第${pageCount}页获取完成，本页${list.length}条（新增${newCount}条），累计${allRecords.length}条，nextId=${nextId ?? "无"}`);

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

    // 如果返回记录数少于 page_size，说明是最后一页
    if (list.length < PAGE_SIZE) {
      console.log(`[PayRecord] 本页不足${PAGE_SIZE}条，已到最后一页`);
      break;
    }
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
