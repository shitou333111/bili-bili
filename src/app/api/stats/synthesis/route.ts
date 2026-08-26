import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchTianxuanGiftList, fetchRedPocketGiftList, fetchBagList, getUserNameByUid, type BagGiftItem } from "@/lib/bilibili/gift-api";
import {
  calcHistoricalSynthesisProfit,
  calcPayRecordActivityProfit,
  type SynthesisProfitResult,
  type SynthesisActivityProfitResult,
  type SynthesisActivityStats,
} from "@/lib/gift-db";
import { readPayRecords, getAccumulatedTianxuanGiftIds, getAccumulatedRedPocketGiftIds } from "@/lib/user-data";
import type { SynthesisActivityConfig } from "@/lib/config";
import { getEffectiveSynthesisConfig } from "@/lib/config-override";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

// re-export 类型，保持向后兼容（组件从 gift-db 导入）
export type { SynthesisActivityStats } from "@/lib/gift-db";

export type SynthesisStatsResponse = {
  historical: SynthesisProfitResult;
  activities: SynthesisActivityStats[];
  tianxuanGifts?: { id: number; name: string }[];
  redPocketGifts?: { id: number; name: string }[];
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  console.log("[SynthesisStats] sid:", sid);
  const session = await getActiveSessionFromCookie(sid);
  console.log("[SynthesisStats] session:", session ? "found" : "not found");

  if (!session) {
    console.log("[SynthesisStats] 未登录，需要重新登录");
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  console.log("[SynthesisStats] 验证凭证...");
  const offline = isOffline(url);
  let onlineCookie = "";
  if (!offline) {
    const credentialResult = await ensureValidCredential(session);
    console.log("[SynthesisStats] 凭证验证结果:", credentialResult.valid ? "有效" : "失效");
    if (!credentialResult.valid) {
      return NextResponse.json<ApiResponse<null>>(
        { code: 401, message: "needs-relogin", data: null },
        { status: 401 },
      );
    }
    onlineCookie = credentialResult.cookie;
  }

  const validSession = session;

  try {
    const biliCookie = onlineCookie;
    console.log("[SynthesisStats] 开始获取数据...");

    let tianxuanGiftIds: number[] = [];
    let tianxuanGiftList: { id: number; name: string }[] = [];
    if (offline) {
      // 离线模式：仅用本地累积的天选礼物 ID
      tianxuanGiftIds = await getAccumulatedTianxuanGiftIds([]);
    } else {
      try {
        const tianxuanGifts = await fetchTianxuanGiftList(biliCookie);
        const currentIds = tianxuanGifts.map(g => g.id);
        tianxuanGiftList = tianxuanGifts.map(g => ({ id: g.id, name: g.name }));
        tianxuanGiftIds = await getAccumulatedTianxuanGiftIds(currentIds);
      } catch (err) {
        console.error("[SynthesisStats] 获取天选礼物列表失败:", err);
      }
    }

    let redPocketGiftIds: number[] = [];
    let redPocketGiftList: { id: number; name: string }[] = [];
    if (offline) {
      // 离线模式：仅用本地累积的红包礼物 ID
      redPocketGiftIds = await getAccumulatedRedPocketGiftIds([]);
    } else {
      try {
        const redPocketGifts = await fetchRedPocketGiftList(biliCookie);
        const currentRedPocketIds = redPocketGifts.map(g => g.id);
        redPocketGiftList = redPocketGifts.map(g => ({ id: g.id, name: g.name }));
        redPocketGiftIds = await getAccumulatedRedPocketGiftIds(currentRedPocketIds);
      } catch (err) {
        console.error("[SynthesisStats] 获取红包礼物列表失败:", err);
      }
    }

    // 历史总盈亏：基于消费记录(pay-records)按主播/直播间独立累计。
    // 消费记录是全量的（覆盖所有合成活动），而页面上方列出的活动只是其中几个，不全，
    // 因此历史统计从消费记录计算（见下方 calcHistoricalSynthesisProfit），
    // 而不是由少量活动结果累加得到。声明在活动处理完后赋值。
    let historical: SynthesisProfitResult;

    // 付费记录用于构建 ruid → r_uname 名称映射（B站API已认证，比 getUserNameByUid 更可靠）
    const records = await readPayRecords(validSession.mid, validSession.uname || "");

    // 包裹礼物列表：合成出来的礼物在送出前只出现在包裹中（不在消费记录里），
    // 因此需要用包裹礼物与消费记录互补，构成完整的合成产出礼物列表。
    let bagGifts: BagGiftItem[] = [];
    if (!offline) {
      try {
        bagGifts = await fetchBagList(biliCookie);
      } catch (err) {
        console.error("[SynthesisStats] 获取包裹礼物列表失败:", err);
      }
    }

    const activities: SynthesisActivityStats[] = [];
    const effectiveSynthConfig = await getEffectiveSynthesisConfig();
    // 天选/红包礼物在消费记录方式下同样需要排除（产物可能与其重合）
    const excludedGiftIds = new Set<number>([...tianxuanGiftIds, ...redPocketGiftIds]);
    for (const activity of effectiveSynthConfig.current_activity) {
      console.log(`[SynthesisStats] 处理活动: ${activity.id}`);
      try {
        const profit = calcPayRecordActivityProfit(records, activity, excludedGiftIds, bagGifts);
        console.log(`[SynthesisStats] 消费记录方式盈亏: totalSpent=${profit.totalSpent}, totalEarned=${profit.totalEarned}, profit=${profit.profit}, synthesisCount=${profit.synthesisCount}, giftCount=${profit.giftList.length}, anchorCount=${profit.anchors.length}`);

        // 活动图标：优先取配置中最后一个产物的礼物图标（依次查包裹、产物列表），找不到再回退其他产物
        const products = activity.products && activity.products.length > 0 ? activity.products : [];
        const findProductImg = (productName: string): string | undefined => {
          const bagMatch = bagGifts.find((g) => g.gift_name.includes(productName));
          if (bagMatch && bagMatch.img) return bagMatch.img;
          const prodGift = profit.giftList.find((g) => g.gift_name.includes(productName));
          return prodGift?.gift_img;
        };
        let activityIcon = products.length > 0 ? findProductImg(products[products.length - 1]) : undefined;
        if (!activityIcon) {
          for (const p of products) {
            activityIcon = findProductImg(p);
            if (activityIcon) break;
          }
        }
        if (!activityIcon) {
          activityIcon = profit.giftList.length > 0
            ? profit.giftList.reduce((a, b) => (a.gift_price > b.gift_price ? a : b)).gift_img
            : undefined;
        }

        activities.push({
          id: activity.id,
          name: activity.name || activity.id,
          icon: activityIcon,
          start_time: activity.start_time,
          end_time: activity.end_time,
          profit,
          certifications: [],
        });
      } catch (err) {
        console.error(`[SynthesisStats] 获取活动 ${activity.id} 失败:`, err);
        activities.push({
          id: activity.id,
          name: activity.id,
          icon: undefined,
          profit: {
            totalSpent: 0,
            totalEarned: 0,
            profit: 0,
            drawCount: 0,
            replaceCount: 0,
            synthesisCount: 0,
            successCount: 0,
            giftList: [],
            anchors: [],
            detailedRecords: [],
          },
          certifications: [],
        });
      }
    }

    console.log(`[SynthesisStats] 共获取 ${activities.length} 个活动数据`);

    // 历史总盈亏：基于消费记录(pay-records)按主播/直播间独立累计。
    // 消费记录是全量的（覆盖所有合成活动），而页面上方列出的活动只是其中几个，不全，
    // 因此历史统计必须从消费记录计算，而不是由少量活动结果累加得到。
    historical = calcHistoricalSynthesisProfit(records, tianxuanGiftIds, redPocketGiftIds);

    // 补偿历史各主播的昵称（优先用付费记录 r_uname，其次 B站API 查询结果）
    if (historical.anchorStats) {
      const payRecordNameMap = new Map<number, string>();
      for (const payRecord of records) {
        if (payRecord.r_uname && !payRecordNameMap.has(payRecord.ruid)) {
          payRecordNameMap.set(payRecord.ruid, payRecord.r_uname);
        }
      }
      const anchorRuids = Array.from(new Set(historical.anchorStats.map(a => a.ruid)));
      const nameResults = await Promise.all(anchorRuids.map(async (ruid) => {
        const name = await getUserNameByUid(ruid, validSession.mid, validSession.uname || "").catch(() => "");
        return { ruid, name };
      }));
      const nameMap = new Map<number, string>();
      for (const { ruid, name } of nameResults) nameMap.set(ruid, name);
      for (const info of historical.anchorStats) {
        if (info.rname) continue;
        const nameMapVal = nameMap.get(info.ruid);
        const payName = payRecordNameMap.get(info.ruid);
        const validNameMapVal = (nameMapVal && !nameMapVal.startsWith("主播")) ? nameMapVal : undefined;
        info.rname = payName || validNameMapVal || nameMapVal || `主播${info.ruid}`;
      }
    }

    const data: SynthesisStatsResponse = { historical, activities, tianxuanGifts: tianxuanGiftList, redPocketGifts: redPocketGiftList };

    return NextResponse.json<ApiResponse<SynthesisStatsResponse>>(
      { code: 0, message: "ok", data },
      { status: 200 },
    );
  } catch (err) {
    console.error("[SynthesisStats] 统计失败:", err);
    return NextResponse.json<ApiResponse<null>>(
      { code: 500, message: "统计失败", data: null },
      { status: 500 },
    );
  }
}