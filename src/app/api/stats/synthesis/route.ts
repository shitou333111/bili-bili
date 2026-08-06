import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchSynthesisActivityInfo, fetchSynthesisActivityRecords, fetchTianxuanGiftList, fetchRedPocketGiftList, getUserNameByUid } from "@/lib/bilibili/gift-api";
import {
  getSynthesisCalculator,
  calculateSynthesisCertifications,
  calculateCardFlipCertifications,
  calcHistoricalSynthesisProfit,
  type SynthesisProfitResult,
  type SynthesisActivityProfitResult,
  type SynthesisGiftInfo,
  type SynthesisAnchorInfo,
  type SynthesisCertification,
  type SynthesisActivityStats,
} from "@/lib/gift-db";
import { readPayRecords, readSynthesisRecords, saveSynthesisRecords, getSynthesisActivityInfo, saveSynthesisActivityInfo, getAccumulatedTianxuanGiftIds, getAccumulatedRedPocketGiftIds, getCardFlipGiftImages, getCardFlipGiftImage, saveCardFlipGiftImage } from "@/lib/user-data";
import { SYNTHESIS_CONFIG, type SynthesisActivityConfig } from "@/lib/config";
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

function buildMockActivities(): SynthesisActivityStats[] {
  const anchorNames: Record<number, string> = {
    1: "主播A",
    2: "主播B",
    3: "主播C",
    4: "主播D",
    5: "主播E",
    6: "主播F",
    7: "主播G",
    8: "主播H",
  };

  return SYNTHESIS_CONFIG.current_activity.map((activity, index) => {
    const giftList: SynthesisGiftInfo[] = [
      {
        gift_id: 0,
        gift_name: "永恒誓约",
        gift_img: "",
        gift_price: 30000,
        count: 20 + index * 5,
      },
      {
        gift_id: 0,
        gift_name: "绮梦双生",
        gift_img: "",
        gift_price: 8000,
        count: 80 + index * 10,
      },
      {
        gift_id: 0,
        gift_name: "流萤许愿",
        gift_img: "",
        gift_price: 2000,
        count: 300 + index * 20,
      },
      {
        gift_id: 0,
        gift_name: "心语星辉",
        gift_img: "",
        gift_price: 350,
        count: 1500 + index * 50,
      },
    ];

    const totalEarned = giftList.reduce((sum, g) => sum + g.gift_price * g.count, 0);
    const successCount = giftList.reduce((sum, g) => sum + g.count, 0);
    const synthesisCount = Math.floor(successCount * 10);
    const totalSpent = Math.floor(totalEarned * 0.8) + index * 5000;

    const anchors: SynthesisAnchorInfo[] = [];
    for (let a = 0; a < 8; a++) {
      const share = [0.25, 0.2, 0.15, 0.12, 0.1, 0.08, 0.06, 0.04][a];
      anchors.push({
        ruid: a + 1,
        rname: anchorNames[a + 1],
        totalSpent: Math.floor(totalSpent * share),
        totalEarned: Math.floor(totalEarned * share),
      });
    }

    const detailedRecords = [];
    for (let i = 0; i < 200; i++) {
      const gift = giftList[i % giftList.length];
      const ruid = ((i % 8) + 1);
      const spent = Math.floor(gift.gift_price * (0.5 + Math.random() * 0.5));
      const isFull = i === 5 || i === 12 || i === 45 || i === 78 || i === 120;
      const isLucky = i === 3 || i === 25 || i === 67;
      detailedRecords.push({
        ruid,
        rname: anchorNames[ruid],
        gift_name: gift.gift_name,
        gift_price: gift.gift_price,
        gift_img: "",
        spent,
        profit: gift.gift_price - spent,
        synthetic_result: isFull ? 2 : (isLucky ? 1 : 1),
        date: `2026.07.${String(20 - (i % 30)).padStart(2, "0")} ${String(8 + (i % 12)).padStart(2, "0")}:${String(i * 3 % 60).padStart(2, "0")}`,
        synthetic_time: 1784400000 + i * 3600,
      });
    }

    const certifications: SynthesisCertification[] = [
      {
        type: "lucky",
        ruid: 1,
        rname: "主播A",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 2000,
        profit: 28000,
        date: "2026.07.15 14:30",
      },
      {
        type: "unlucky",
        ruid: 2,
        rname: "主播B",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 28000,
        profit: 2000,
        date: "2026.07.12 20:15",
      },
      {
        type: "lucky",
        ruid: 3,
        rname: "主播C",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 1500,
        profit: 28500,
        date: "2026.07.10 16:45",
      },
      {
        type: "unlucky",
        ruid: 4,
        rname: "主播D",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 29000,
        profit: 1000,
        date: "2026.07.08 10:30",
      },
      {
        type: "rich",
        ruid: 5,
        rname: "主播E",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 0,
        profit: 0,
        date: "2026.07.20",
        count: 7,
      },
      {
        type: "rich",
        ruid: 6,
        rname: "主播F",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 0,
        profit: 0,
        date: "2026.07.18",
        count: 6,
      },
      {
        type: "lucky",
        ruid: 7,
        rname: "主播G",
        gift_name: "永恒誓约",
        gift_price: 30000,
        gift_img: "",
        spent: 2500,
        profit: 27500,
        date: "2026.07.05 09:20",
      },
    ];

    return {
      id: activity.id,
      type: activity.type,
      name: `合成活动-${index + 1}`,
      icon: "",
      profit: {
        totalSpent,
        totalEarned,
        profit: totalEarned - totalSpent,
        drawCount: 0,
        replaceCount: 0,
        synthesisCount,
        successCount,
        giftList,
        anchors,
        detailedRecords,
      },
      certifications,
    };
  });
}

function buildMockSynthesisStats(): SynthesisStatsResponse {
  const historical: SynthesisProfitResult = {
    totalSpent: 500000,
    totalEarned: 800000,
    profit: 300000,
    drawCount: 500000,
    replaceCount: 0,
    synthesisCount: 8000,
    successCount: 8000,
  };

  return { historical, activities: buildMockActivities() };
}

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
    console.log("[SynthesisStats] 未登录，返回模拟数据");
    const mockData = buildMockSynthesisStats();
    return NextResponse.json<ApiResponse<SynthesisStatsResponse>>(
      { code: 0, message: "mock", data: mockData },
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

    const activities: SynthesisActivityStats[] = [];
    const effectiveSynthConfig = await getEffectiveSynthesisConfig();
    for (const activity of effectiveSynthConfig.current_activity) {
      console.log(`[SynthesisStats] 处理活动: ${activity.id}`);
      try {
        const calculator = getSynthesisCalculator(activity.type);
        if (!calculator) {
          console.warn(`[SynthesisStats] 未知活动类型: ${activity.type}`);
          continue;
        }

        console.log(`[SynthesisStats] 获取活动信息: ${activity.info_url}`);
        let info = null;
        if (offline) {
          // 离线模式：仅用本地缓存的活动信息
          info = await getSynthesisActivityInfo(activity.id);
        } else {
          try {
            info = await getSynthesisActivityInfo(activity.id);
            if (info && info.name && (activity.type !== "material_package" || info.resource)) {
              console.log(`[SynthesisStats] 从缓存读取活动信息:`, info);
            } else {
              info = await fetchSynthesisActivityInfo(biliCookie, activity);
              console.log(`[SynthesisStats] 从API获取活动信息:`, info);
              if (info && info.name) {
                await saveSynthesisActivityInfo(activity.id, info);
              }
            }
          } catch (infoErr) {
            console.warn(`[SynthesisStats] 获取活动信息失败（活动可能已结束）:`, infoErr);
          }
        }

        console.log(`[SynthesisStats] 获取活动记录: ${activity.record_url}`);
        let rawRecords: any[] = [];
        if (offline) {
          // 离线模式：仅用本地缓存的活动记录
          rawRecords = await readSynthesisRecords(validSession.mid, validSession.uname || "", activity.id);
          console.log(`[SynthesisStats] 离线模式，读取本地活动记录:`, rawRecords.length);
        } else {
          try {
            rawRecords = await fetchSynthesisActivityRecords(biliCookie, activity);
            console.log(`[SynthesisStats] 活动记录数量:`, rawRecords.length);
            await saveSynthesisRecords(validSession.mid, validSession.uname || "", activity.id, rawRecords, info?.name);
          } catch (recordErr) {
            console.warn(`[SynthesisStats] 获取活动记录失败:`, recordErr);
          }
        }

        // card_flip 类型需要注入礼物图片缓存，因为 info_url 为空，活动信息中不包含礼物图片
        if (activity.type === "card_flip" && info) {
          const giftImageCache = await getCardFlipGiftImages();
          (info as any).gift_image_cache = giftImageCache;
        }

        const profit = calculator.calculate(rawRecords, info);

        // card_flip 类型：为缺少图片的礼物尝试从缓存/付费记录中解析图片
        if (activity.type === "card_flip") {
          for (const gift of profit.giftList) {
            if (!gift.gift_img) {
              const img = await getCardFlipGiftImage(gift.gift_name, validSession.mid, validSession.uname || "");
              if (img) {
                gift.gift_img = img;
                await saveCardFlipGiftImage(gift.gift_name, img);
              }
            }
          }
        }

        const uniqueRuids = new Set<number>();
        for (const anchor of profit.anchors) {
          uniqueRuids.add(anchor.ruid);
        }
        for (const record of profit.detailedRecords) {
          uniqueRuids.add(record.ruid);
        }
        
        // 从付费记录构建 ruid → r_uname 映射（B站API已认证，比 getUserNameByUid 更可靠）
        const payRecordNameMap = new Map<number, string>();
        for (const payRecord of records) {
          if (payRecord.r_uname && !payRecordNameMap.has(payRecord.ruid)) {
            payRecordNameMap.set(payRecord.ruid, payRecord.r_uname);
          }
        }
        
        const namePromises = Array.from(uniqueRuids).map(async (ruid) => {
          const name = await getUserNameByUid(ruid, validSession.mid, validSession.uname || "").catch(() => "");
          return { ruid, name };
        });
        
        const nameResults = await Promise.all(namePromises);
        const nameMap = new Map<number, string>();
        for (const { ruid, name } of nameResults) {
          nameMap.set(ruid, name);
        }
        
        for (const anchor of profit.anchors) {
          // 优先使用付费记录中的 r_uname（B站API已认证），其次使用 nameMap（B站用户名片API）
          const nameMapVal = nameMap.get(anchor.ruid);
          const payName = payRecordNameMap.get(anchor.ruid);
          // nameMap 可能包含 "主播xxx" 的兜底值，此时应回退到付费记录
          const validNameMapVal = (nameMapVal && !nameMapVal.startsWith("主播")) ? nameMapVal : undefined;
          anchor.rname = payName || validNameMapVal || nameMapVal || `主播${anchor.ruid}`;
        }
        for (const record of profit.detailedRecords) {
          const nameMapVal = nameMap.get(record.ruid);
          const payName = payRecordNameMap.get(record.ruid);
          const validNameMapVal = (nameMapVal && !nameMapVal.startsWith("主播")) ? nameMapVal : undefined;
          record.rname = payName || validNameMapVal || nameMapVal || `主播${record.ruid}`;
        }

        // 计算所有可能礼物中的最大价格（优先使用活动信息）
        let maxGiftPrice: number | undefined = undefined;
        let maxGiftImg: string | undefined = undefined;
        if (info?.gift_info && info.gift_info.length > 0) {
          type InfoGift = { gift_price: number; gift_img: string };
          const maxGift = info.gift_info.reduce((a: InfoGift, b: InfoGift) => a.gift_price > b.gift_price ? a : b);
          maxGiftPrice = maxGift.gift_price;
          maxGiftImg = maxGift.gift_img;
        }

        let certifications: SynthesisCertification[];
        if (activity.type === "card_flip") {
          // 翻牌活动使用专门的认证逻辑
          const maxGiftPriceForCert = profit.giftList.length > 0
            ? Math.max(...profit.giftList.map(g => g.gift_price))
            : undefined;
          certifications = calculateCardFlipCertifications(rawRecords, profit.detailedRecords, maxGiftPriceForCert);
        } else {
          certifications = calculateSynthesisCertifications(profit.detailedRecords, maxGiftPrice);
        }

        // 为认证记录填充主播名称（card_flip 类型的认证记录 rname 为空）
        for (const cert of certifications) {
          cert.rname = nameMap.get(cert.ruid) || `主播${cert.ruid}`;
        }

        // 活动图标：优先使用info.icon，其次用所有可能礼物中最大礼物的图片
        const activityIcon = info?.icon || maxGiftImg || (profit.giftList.length > 0 ? profit.giftList.reduce((a, b) => a.gift_price > b.gift_price ? a : b).gift_img : undefined);

        console.log(`[SynthesisStats] 盈亏计算结果: totalSpent=${profit.totalSpent}, totalEarned=${profit.totalEarned}, profit=${profit.profit}, synthesisCount=${profit.synthesisCount}, giftCount=${profit.giftList.length}, anchorCount=${profit.anchors.length}`);
        console.log(`[SynthesisStats] rawRecords length:`, rawRecords.length);
        if (rawRecords.length > 0) {
          console.log(`[SynthesisStats] first record:`, JSON.stringify(rawRecords[0]).substring(0, 200));
        }

        activities.push({
          id: activity.id,
          type: activity.type,
          name: info?.name || activity.id,
          icon: activityIcon,
          profit,
          certifications,
        });
      } catch (err) {
        console.error(`[SynthesisStats] 获取活动 ${activity.id} 失败:`, err);
        activities.push({
          id: activity.id,
          type: activity.type,
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