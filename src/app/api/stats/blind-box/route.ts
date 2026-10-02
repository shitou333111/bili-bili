import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBlindBoxDrawStream, fetchBagList } from "@/lib/bilibili/gift-api";
import { getEffectiveBlindBoxConfig } from "@/lib/config-override";
import { ensureGiftCatalogLoaded, getGiftImg, getGiftName, getGiftPrice } from "@/lib/gift-catalog";
import { isOffline } from "@/lib/offline";
import {
  collectRewardGifts,
  computeBlindBoxFromRecords,
  type BlindBoxCalcRecord,
  type BlindBoxGiftMeta,
  type BlindBoxRewardBagGift,
} from "@/lib/blind-box-calc";
import { readPayRecords } from "@/lib/user-data";
import type { ApiResponse } from "@/lib/bilibili/types";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// 盲盒抽取记录存储类型（字段名与API返回一致）
type BlindBoxDrawRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  original_gift_id: number;
  original_gift_name: string;
  gift_img: string;
  timestamp: string; // API返回的时间字段
  ruid: number;
  rname: string;
};

// 城堡统计类型
type CastleStat = {
  ruid: number;
  rname: string;
  totalCount: number;
  dates: Array<{ date: string; count: number }>;
};

// 盲盒盈亏结果类型
type BlindBoxProfitResult = {
  blindBoxId: number;
  blindBoxName: string;
  blindBoxImg: string;
  blindPrice: number;
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  recordCount: number;
  /** 全部记录的时间范围 */
  dateRange: { start: string; end: string } | null;
  /** 全部记录的主播列表（按送出个数降序） */
  anchors: Array<{ ruid: number; rname: string; count: number }>;
  /** 当前筛选条件 */
  filter: { ruid: number | null; dateRange: string };
  gifts: Array<{
    gift_id: number;
    gift_name: string;
    gift_img: string;
    unitPrice: number;
    count: number;
    totalValue: number;
  }>;
  /** 城堡统计（仅心动盲盒） */
  castleStats: CastleStat[];
  /** 城堡礼物信息 */
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
  /**
   * 浏览器端本地筛选所需的一次性载荷（精简记录 + 元数据）。
   * WEB 端只在冷启动/刷新时请求本接口拿全量数据，之后切换主播/时间段全部本地重算，0 请求。
   * 计算语义与 `src/lib/blind-box-calc.ts` 为镜像实现，两边修改需同步。
   */
  records?: BlindBoxCalcRecord[];
  /** ruid → 主播昵称 */
  anchorNames?: Record<number, string>;
  /** gift_id → 礼物名称/图标/单价 */
  giftMeta?: Record<number, BlindBoxGiftMeta>;
  /** 该盲盒的额外奖励礼物（包裹补充，成本 0），供浏览器端本地重算 */
  rewardGifts?: BlindBoxRewardBagGift[];
};

// 数据存储目录
const DATA_DIR = path.join(process.cwd(), ".data");

// 浪漫城堡 gift_id
const CASTLE_ID = 32132;

function getBlindBoxRecordsDir(mid: number, _uname?: string): string {
  return path.join(DATA_DIR, `uid_${mid}`);
}

// 确保目录存在
async function ensureDir(dir: string) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // 目录已存在
  }
}

// 在目录中查找匹配前缀和后缀的文件
async function findFileByPrefix(dir: string, prefix: string, suffix: string): Promise<string | null> {
  try {
    const files = await fs.readdir(dir);
    const match = files.find(f => f.startsWith(prefix) && f.endsWith(suffix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

// 清理文件名中的非法字符
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

// 获取北京时间字符串
function getBeijingTime(): string {
  const now = new Date();
  const offset = 8 * 60;
  const local = new Date(now.getTime() + offset * 60 * 1000);
  return local.toISOString().replace("T", " ").slice(0, 19);
}

// 读取已存储的盲盒记录
async function readBlindBoxRecords(mid: number, uname: string, blindBoxId: number): Promise<BlindBoxDrawRecord[]> {
  await ensureDir(DATA_DIR);
  const dir = getBlindBoxRecordsDir(mid, uname);
  await fs.mkdir(dir, { recursive: true });
  const filePath = await findFileByPrefix(dir, `blind-box-${blindBoxId}`, "-records.json");
  if (!filePath) return [];
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

// 获取已存储记录的最新时间戳
function getLatestTimestamp(records: BlindBoxDrawRecord[]): string | undefined {
  if (records.length === 0) return undefined;
  let latest = records[0].timestamp;
  for (const r of records) {
    if (r.timestamp > latest) latest = r.timestamp;
  }
  return latest;
}

// 保存盲盒记录
async function saveBlindBoxRecords(mid: number, uname: string, blindBoxId: number, records: BlindBoxDrawRecord[], blindBoxName?: string) {
  await ensureDir(DATA_DIR);
  const dir = getBlindBoxRecordsDir(mid, uname);
  await fs.mkdir(dir, { recursive: true });
  const safeName = blindBoxName ? sanitizeFileName(blindBoxName) : "";
  const fileName = safeName
    ? `blind-box-${blindBoxId}-${safeName}-records.json`
    : `blind-box-${blindBoxId}-records.json`;
  const filePath = path.join(dir, fileName);

  // 删除旧文件
  if (safeName) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (f.startsWith(`blind-box-${blindBoxId}`) && f.endsWith("-records.json") && f !== fileName) {
          await fs.unlink(path.join(dir, f));
          console.log(`[BlindBoxRecords] 删除旧文件: ${f}`);
        }
      }
    } catch { /* ignore */ }
  }

  const data = {
    exportedAt: getBeijingTime(),
    records,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// 合并新旧记录，去重
function mergeRecords(existing: BlindBoxDrawRecord[], newRecords: BlindBoxDrawRecord[]): BlindBoxDrawRecord[] {
  const sortedExisting = [...existing].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const sortedNew = [...newRecords].sort((a, b) => {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  if (sortedExisting.length === 0) {
    return sortedNew;
  }

  const existingLatestTime = sortedExisting[0].timestamp;
  let overlapIndex = -1;

  for (let i = 0; i < sortedNew.length; i++) {
    if (sortedNew[i].timestamp === existingLatestTime) {
      overlapIndex = i;
      break;
    }
  }

  if (overlapIndex === -1) {
    const newLatestTime = sortedNew[0].timestamp;
    if (new Date(newLatestTime).getTime() > new Date(existingLatestTime).getTime()) {
      return [...sortedNew, ...sortedExisting];
    }
    return sortedExisting;
  }

  const newRecordsToAdd = sortedNew.slice(0, overlapIndex);
  return [...newRecordsToAdd, ...sortedExisting];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则返回需要重新登录（离线时跳过校验）
  const offline = isOffline(url);
  if (!offline) {
    const credentialResult = await ensureValidCredential(session);
    if (!credentialResult.valid) {
      return NextResponse.json<ApiResponse<null>>(
        { code: 401, message: "needs-relogin", data: null },
        { status: 401 },
      );
    }
  }

  const validSession = session;

  // 解析筛选参数（支持按盲盒ID分别筛选：ruid_32251=xxx, dateRange_32251=thisMonth）

  try {
    await ensureGiftCatalogLoaded();
    const biliCookie = validSession.biliCookies?.join("; ") || `SESSDATA=${validSession.biliSessdata}`;

    const effectiveBlindBoxConfig = await getEffectiveBlindBoxConfig();
    const currentIds = effectiveBlindBoxConfig.current_activity_blind_box_ids ?? [];

    // 只包含在 admin 中勾选的盲盒
    const blindBoxIds = currentIds.filter((id) => id > 0);
    if (blindBoxIds.length === 0) {
      // 如果没有勾选任何盲盒，返回空结果
      return NextResponse.json({ code: 0, message: "ok", data: { blindBoxes: [], totalProfit: 0, hasActivityBlindBox: false } });
    }

    const results: BlindBoxProfitResult[] = [];

    // 请求级拉取一次包裹礼物（奖励礼物来源于包裹）；仅当有盲盒配置了奖励礼物时才请求
    const anyReward = blindBoxIds.some(
      (id) => (effectiveBlindBoxConfig.boxes[id]?.rewardGiftNames.length ?? 0) > 0,
    );
    const bagGifts = !offline && anyReward ? await fetchBagList(biliCookie) : [];
    // 请求级读取一次消费记录：奖励礼物送出后进入消费记录（bag_desc="包裹道具"），与包裹互补
    const payRecords = anyReward ? await readPayRecords(validSession.mid, validSession.uname || "") : [];

    for (const blindBoxId of blindBoxIds) {
      try {
        // 解析该盲盒的筛选参数
        const filterRuid = url.searchParams.get(`ruid_${blindBoxId}`);
        const filterDateRange = url.searchParams.get(`dateRange_${blindBoxId}`) ?? "all";
        const ruid = filterRuid ? Number(filterRuid) : null;

        // 读取已存储的记录（先读取，用于增量获取）
        const existingRecords = await readBlindBoxRecords(validSession.mid, validSession.uname, blindBoxId);

        // 获取已存储记录的最新时间戳，用于增量获取
        const latestTimestamp = getLatestTimestamp(existingRecords);

        // 增量获取新记录（离线时跳过，仅用本地缓存）
        const newRecords = offline
          ? []
          : await fetchBlindBoxDrawStream(blindBoxId, biliCookie, latestTimestamp);

        // 合并记录
        const mergedRecords = newRecords.length > 0
          ? [...newRecords, ...existingRecords]
          : existingRecords;

        // admin 配置优先（含过期盲盒完整信息），礼物目录兜底
        const boxCfg = effectiveBlindBoxConfig.boxes[blindBoxId];

        // 盲盒名称（用于文件名）
        const blindBoxNameForFile = boxCfg?.name || getGiftName(blindBoxId) || undefined;

        // 保存（只有有新记录时才保存）
        if (newRecords.length > 0) {
          await saveBlindBoxRecords(validSession.mid, validSession.uname, blindBoxId, mergedRecords, blindBoxNameForFile);
        }

        console.log(`[BlindBoxStats] 盲盒 ${blindBoxId}: 新记录 ${newRecords.length} 条, 已存储 ${existingRecords.length} 条, 合并后 ${mergedRecords.length} 条`);

        // 元数据取值顺序：admin 配置 → 礼物目录 → 0（过期盲盒在目录中无价/无数据）
        const blindPrice = boxCfg?.blindPrice || getGiftPrice(blindBoxId) || 0;
        const blindBoxName = boxCfg?.name || getGiftName(blindBoxId) || `盲盒_${blindBoxId}`;
        const blindBoxImg = boxCfg?.icon || getGiftImg(blindBoxId) || "";

        // 礼物元数据：admin 配置优先，抽取记录/礼物目录兜底
        const giftMeta: Record<number, BlindBoxGiftMeta> = {};
        for (const g of boxCfg?.gifts ?? []) {
          if (g.giftId > 0) giftMeta[g.giftId] = { name: g.giftName, img: g.img, price: g.price };
        }
        for (const r of mergedRecords) {
          if (giftMeta[r.gift_id]) continue;
          giftMeta[r.gift_id] = {
            name: r.gift_name || getGiftName(r.gift_id),
            img: getGiftImg(r.gift_id) || r.gift_img,
            price: getGiftPrice(r.gift_id),
          };
        }
        // 盲盒本身用已解析好的名称/图标
        giftMeta[blindBoxId] = { name: blindBoxName, img: blindBoxImg, price: blindPrice };
        // 浪漫城堡（心动盲盒的本地重算需要它的名称/图标/单价）
        if (blindBoxId === 32251 && !giftMeta[CASTLE_ID]) {
          giftMeta[CASTLE_ID] = { name: getGiftName(CASTLE_ID), img: getGiftImg(CASTLE_ID), price: getGiftPrice(CASTLE_ID) };
        }

        // 奖励礼物：包裹（未送出）+ 消费记录（已送出）两来源互补，
        // 与合成活动的合成产物口径一致（详见 collectRewardGifts）。
        const rewardGifts: BlindBoxRewardBagGift[] = collectRewardGifts(
          (boxCfg?.gifts ?? []).filter((g) => g.isReward),
          bagGifts,
          payRecords,
        );

        const anchorNames: Record<number, string> = {};
        for (const r of mergedRecords) {
          if (anchorNames[r.ruid] === undefined) anchorNames[r.ruid] = r.rname;
        }

        const calcRecords: BlindBoxCalcRecord[] = mergedRecords.map((r) => ({
          gift_id: r.gift_id,
          gift_num: r.gift_num,
          ruid: r.ruid,
          timestamp: r.timestamp,
        }));

        // 计算盈亏（镜像实现：src/lib/blind-box-calc.ts，两边语义必须一致）
        const calc = computeBlindBoxFromRecords({
          blindBoxId,
          records: calcRecords,
          anchorNames,
          giftMeta,
          blindPrice,
          blindBoxName,
          blindBoxImg,
          filter: { ruid, dateRange: filterDateRange },
          rewardGifts,
        });

        // 浏览器端本地筛选所需的一次性载荷（精简记录 + 元数据，切筛选 0 请求）
        const profit: BlindBoxProfitResult = {
          ...calc,
          records: calcRecords,
          anchorNames,
          giftMeta,
          rewardGifts,
        };

        results.push(profit);
      } catch (err) {
        console.error(`[BlindBoxStats] 处理盲盒 ${blindBoxId} 失败:`, err);
      }
    }

    return NextResponse.json<ApiResponse<BlindBoxProfitResult[]>>(
      { code: 0, message: "ok", data: results },
      { status: 200 },
    );
  } catch (err) {
    console.error("[BlindBoxStats] 统计失败:", err);
    return NextResponse.json<ApiResponse<null>>(
      { code: 500, message: "统计失败", data: null },
      { status: 500 },
    );
  }
}