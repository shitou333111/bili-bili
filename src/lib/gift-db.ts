import { promises as fs, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { RawGiftRecord } from "@/lib/revenue";
import type { CardFlipRawRecord } from "@/lib/bilibili/gift-api";

// ====== 合成活动盈亏统计 ======

export type SynthesisProfitResult = {
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  replaceCount: number;
  synthesisCount: number;
  successCount: number;
  giftList?: SynthesisGiftInfo[];
  detailedRecords?: SynthesisDetailedRecord[];
};

export type SynthesisGiftInfo = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  gift_price: number;
  count: number;
};

export type SynthesisAnchorInfo = {
  ruid: number;
  rname: string;
  totalSpent: number;
  totalEarned: number;
};

export type SynthesisDetailedRecord = {
  ruid: number;
  rname: string;
  gift_name: string;
  gift_price: number;
  gift_img: string;
  spent: number;
  profit: number;
  synthetic_result: number;
  date: string;
  synthetic_time: number;
  coin_type?: string;
  gift_id?: number;
};

export type SynthesisActivityProfitResult = SynthesisProfitResult & {
  giftList: SynthesisGiftInfo[];
  anchors: SynthesisAnchorInfo[];
  detailedRecords: SynthesisDetailedRecord[];
};

export type SynthesisCertification = {
  type: "lucky" | "unlucky" | "rich";
  ruid: number;
  rname: string;
  gift_name: string;
  gift_price: number;
  gift_img: string;
  spent: number;
  profit: number;
  date: string;
  count?: number;
};

/**
 * 抽槽类活动原始记录
 * record_type: 1=抽取, 3=替换, 4=合成
 */
export type SlotDrawRecord = {
  goods_num: number;
  pay_price: number;
  refund_price: number;
  record_type: number;
  status: number;
  mtime: string;
  gift_info: {
    gift_id: number;
    gift_name: string;
    gift_img: string;
    gift_price: number;
  } | null;
  ruid: number;
};

/** 盈亏计算器策略接口 */
export interface SynthesisProfitCalculator {
  calculate(records: any[], activityInfo?: any): SynthesisActivityProfitResult;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}.${month}.${day} ${hours}:${minutes}`;
}

/** 抽槽类活动计算器（6槽抽取/替换/合成） */
class SlotDrawCalculator implements SynthesisProfitCalculator {
  calculate(records: SlotDrawRecord[], activityInfo?: any): SynthesisActivityProfitResult {
    let totalSpent = 0;
    let totalEarned = 0;
    let drawCount = 0;
    let replaceCount = 0;
    let synthesisCount = 0;
    const giftMap = new Map<number, SynthesisGiftInfo>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageMap = new Map<string, string>();
    if (activityInfo?.gift_info) {
      for (const gift of activityInfo.gift_info) {
        giftImageMap.set(gift.gift_name, gift.gift_img);
      }
    }

    const anchorCurrentGift = new Map<number, { name: string; price: number; img: string } | null>();

    // 第一遍：找出所有完成过合成的主播（有record_type=4记录）
    // 未完成合成的主播，其抽取/替换花费会在活动结束时返还，不计入成本
    const synthesizedAnchors = new Set<number>();
    for (const record of records) {
      if (record.status === 1 && record.record_type === 4 && record.gift_info) {
        synthesizedAnchors.add(record.ruid);
      }
    }

    for (const record of records) {
      if (record.status !== 1) continue;

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: "",
        totalSpent: 0,
        totalEarned: 0,
      };

      const timestamp = Math.floor(new Date(record.mtime.replace(/-/g, "/")).getTime() / 1000);
      const dateStr = record.mtime.replace(/-/g, ".");

      if (record.record_type === 4 && record.gift_info) {
        const price = record.gift_info.gift_price / 100;
        totalEarned += price;
        anchor.totalEarned += price;
        synthesisCount++;

        const existing = giftMap.get(record.gift_info.gift_id);
        if (existing) {
          existing.count++;
        } else {
          const giftImg = giftImageMap.get(record.gift_info.gift_name) || record.gift_info.gift_img;
          giftMap.set(record.gift_info.gift_id, {
            gift_id: record.gift_info.gift_id,
            gift_name: record.gift_info.gift_name,
            gift_img: giftImg,
            gift_price: price,
            count: 1,
          });
        }

        const giftImg = giftImageMap.get(record.gift_info.gift_name) || record.gift_info.gift_img;
        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_info.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent: 0,
          profit: price,
          synthetic_result: 1,
          date: dateStr,
          synthetic_time: timestamp,
        });

        anchorCurrentGift.set(record.ruid, {
          name: record.gift_info.gift_name,
          price,
          img: giftImg,
        });
      } else if (record.record_type === 1 || record.record_type === 3) {
        // 只计算完成过合成的主播的抽取/替换花费
        if (!synthesizedAnchors.has(record.ruid)) {
          continue;
        }
        const spent = record.pay_price / 100;
        totalSpent += spent;
        anchor.totalSpent += spent;
        if (record.record_type === 1) {
          drawCount++;
        } else {
          replaceCount++;
        }

        const currentGift = anchorCurrentGift.get(record.ruid);
        const giftName = currentGift?.name || "未合成";
        const giftImg = currentGift?.img || "";
        const giftPrice = currentGift?.price || 0;

        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: giftName,
          gift_price: giftPrice,
          gift_img: giftImg,
          spent,
          profit: -spent,
          synthetic_result: 0,
          date: dateStr,
          synthetic_time: timestamp,
        });
      }

      anchorMap.set(record.ruid, anchor);
    }

    const giftList = Array.from(giftMap.values()).sort((a, b) => b.gift_price - a.gift_price);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
      totalSpent,
      totalEarned,
      profit: totalEarned - totalSpent,
      drawCount,
      replaceCount,
      synthesisCount,
      successCount: synthesisCount,
      giftList,
      anchors,
      detailedRecords,
    };
  }
}

/** 材料合成类活动记录 */
export type MaterialPackageRecord = {
  ruid: number;
  synthetic_time: number;
  synthetic_result: number;
  gift_name: string;
  gift_price: number;
  materials: Array<{ name: string; num: number }>;
  materials_price: number;
};

/** 材料合成类活动计算器（多档位材料合成） */
class MaterialPackageCalculator implements SynthesisProfitCalculator {
  calculate(records: MaterialPackageRecord[], activityInfo?: any): SynthesisActivityProfitResult {
    let totalSpent = 0;
    let totalEarned = 0;
    let synthesisCount = 0;
    let successCount = 0;
    const giftMap = new Map<string, SynthesisGiftInfo & { gift_key: string }>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageMap = new Map<string, string>();
    if (activityInfo?.resource) {
      for (const [key, value] of Object.entries(activityInfo.resource)) {
        if (key.startsWith("gift_") && typeof value === "string") {
          giftImageMap.set(key, value);
        }
      }
    }

    const giftPriceMap = new Map<number, string>();
    for (const [key, img] of giftImageMap.entries()) {
      const idx = parseInt(key.split("_")[1]);
      giftPriceMap.set(idx, img);
    }

    for (const record of records) {
      const isFull = record.synthetic_result === 2;
      const spent = isFull ? 0 : record.materials_price / 100;
      totalSpent += spent;
      synthesisCount++;

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalSpent += spent;

      const price = record.gift_price / 100;
      let giftImg = "";
      const priceLevel = Math.floor(price / 1000);
      const img1 = giftPriceMap.get(1);
      const img2 = giftPriceMap.get(2);
      const img3 = giftPriceMap.get(3);
      const img4 = giftPriceMap.get(4);
      if (price >= 8000 && img3) {
        giftImg = img3;
      } else if (price >= 2000 && img2) {
        giftImg = img2;
      } else if (price >= 350 && img1) {
        giftImg = img1;
      } else if (img4) {
        giftImg = img4;
      }

      if (record.synthetic_result !== 0) {
        totalEarned += price;
        successCount++;
        anchor.totalEarned += price;

        const key = record.gift_name;
        const existing = giftMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          giftMap.set(key, {
            gift_id: 0,
            gift_name: record.gift_name,
            gift_img: giftImg,
            gift_price: price,
            count: 1,
            gift_key: key,
          } as SynthesisGiftInfo & { gift_key: string });
        }

        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent,
          profit: price - spent,
          synthetic_result: record.synthetic_result,
          date: formatTimestamp(record.synthetic_time),
          synthetic_time: record.synthetic_time,
        });
      } else {
        detailedRecords.push({
          ruid: record.ruid,
          rname: "",
          gift_name: record.gift_name,
          gift_price: price,
          gift_img: giftImg,
          spent,
          profit: -spent,
          synthetic_result: 0,
          date: formatTimestamp(record.synthetic_time),
          synthetic_time: record.synthetic_time,
        });
      }

      anchorMap.set(record.ruid, anchor);
    }

    const giftList = Array.from(giftMap.values())
      .sort((a, b) => b.gift_price - a.gift_price)
      .map(({ gift_key, ...rest }) => rest);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
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
    };
  }
}

/** 卡牌翻牌类活动计算器（9张卡牌翻牌） */
class CardFlipCalculator implements SynthesisProfitCalculator {
  private static readonly FLIP_COSTS = [50, 112, 172, 316, 620, 1025, 2033];

  calculate(records: CardFlipRawRecord[], activityInfo?: any): SynthesisActivityProfitResult {
    let totalSpent = 0;
    let totalEarned = 0;
    let synthesisCount = 0;
    let successCount = 0;
    const giftMap = new Map<string, SynthesisGiftInfo>();
    const anchorMap = new Map<number, SynthesisAnchorInfo>();
    const detailedRecords: SynthesisDetailedRecord[] = [];

    const giftImageCache: Record<string, string> = activityInfo?.gift_image_cache || {};

    for (const record of records) {
      synthesisCount++;

      // 计算花费：遍历 card_idx，已翻好卡数决定当次花费
      let roundCost = 0;
      let goodCount = 0;
      let totalFlips = 0;
      let badCardCount = 0;
      let endedByBadCard = false;

      for (const idx of record.card_idx) {
        if (idx === -1) continue; // 用户主动退出，不产生花费
        roundCost += CardFlipCalculator.FLIP_COSTS[goodCount] || 0;
        totalFlips++;
        if (idx >= 1 && idx <= 7) {
          goodCount++;
        } else if (idx >= 8 && idx <= 9) {
          badCardCount++;
          endedByBadCard = true;
        }
      }

      const reward = record.reward_value / 100;
      totalSpent += roundCost;
      totalEarned += reward;

      if (goodCount > 0) {
        successCount++;
      }

      // 主播聚合
      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalSpent += roundCost;
      anchor.totalEarned += reward;
      anchorMap.set(record.ruid, anchor);

      // 礼物聚合：跳过 reward_value=0 的记录（首翻坏牌即结束，无实际奖励）
      const giftImg = giftImageCache[record.reward_name] || "";
      if (record.reward_value > 0 && record.reward_name) {
        const existing = giftMap.get(record.reward_name);
        if (existing) {
          existing.count++;
        } else {
          giftMap.set(record.reward_name, {
            gift_id: 0,
            gift_name: record.reward_name,
            gift_img: giftImg,
            gift_price: reward,
            count: 1,
          });
        }
      }

      // 日期：优先使用 settle_time
      const settleTime = (record as any).settle_time as number | undefined;
      const dateStr = settleTime ? formatTimestamp(settleTime) : "";

      // 详细记录（所有记录都保留，包括坏牌被迫结束的）
      detailedRecords.push({
        ruid: record.ruid,
        rname: "",
        gift_name: record.reward_name,
        gift_price: reward,
        gift_img: giftImg,
        spent: roundCost,
        profit: reward - roundCost,
        synthetic_result: goodCount > 0 ? 1 : 0,
        date: dateStr,
        synthetic_time: settleTime || 0,
      });
    }

    const giftList = Array.from(giftMap.values()).sort((a, b) => b.gift_price - a.gift_price);
    const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    return {
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
    };
  }
}

/** 计算器注册表 */
const calculators: Record<string, SynthesisProfitCalculator> = {
  slot_draw: new SlotDrawCalculator(),
  material_package: new MaterialPackageCalculator(),
  card_flip: new CardFlipCalculator(),
};

/** 根据活动类型获取盈亏计算器 */
export function getSynthesisCalculator(type: string): SynthesisProfitCalculator | null {
  return calculators[type] || null;
}

/** 翻牌活动认证计算 */
export function calculateCardFlipCertifications(
  rawRecords: CardFlipRawRecord[],
  detailedRecords: SynthesisDetailedRecord[],
  maxGiftPrice?: number,
): SynthesisCertification[] {
  const certifications: SynthesisCertification[] = [];
  if (!maxGiftPrice || maxGiftPrice <= 0 || rawRecords.length === 0) return certifications;

  // 按日期+主播分组
  const dailyMap = new Map<string, { records: typeof rawRecords; ruid: number }>();
  for (const record of rawRecords) {
    const settleTime = (record as any).settle_time as number | undefined;
    if (!settleTime) continue;
    const dateStr = new Date(settleTime * 1000).toISOString().slice(0, 10).replace(/-/g, ".");
    const key = `${dateStr}_${record.ruid}`;
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { records: [], ruid: record.ruid });
    }
    dailyMap.get(key)!.records.push(record);
  }

  for (const [key, { records: dayRecords, ruid }] of dailyMap) {
    const dateStr = key.split("_")[0];

    // 统计当天该主播的所有翻牌数据
    let totalFlips = 0;
    let totalBadCards = 0;
    let totalCost = 0;
    let totalReward = 0;
    let maxGoodCount = 0;
    let roundsWithMaxGift = 0;
    const roundGoodCounts: number[] = [];

    for (const record of dayRecords) {
      let goodCount = 0;
      let badCount = 0;
      let roundFlips = 0;
      let roundCost = 0;
      const costs = [50, 112, 172, 316, 620, 1025, 2033];

      for (const idx of record.card_idx) {
        if (idx === -1) continue;
        roundCost += costs[goodCount] || 0;
        roundFlips++;
        if (idx >= 1 && idx <= 7) goodCount++;
        else if (idx >= 8 && idx <= 9) badCount++;
      }

      totalFlips += roundFlips;
      totalBadCards += badCount;
      totalCost += roundCost;
      totalReward += record.reward_value / 100;
      roundGoodCounts.push(goodCount);

      if (goodCount > maxGoodCount) maxGoodCount = goodCount;
      if (record.reward_value / 100 >= maxGiftPrice) roundsWithMaxGift++;
    }

    // 欧皇：当天只尝试了一次（1局），且一气呵成翻了7张好牌获得最大礼物
    if (dayRecords.length === 1 && maxGoodCount === 7 && roundsWithMaxGift >= 1) {
      const settleTime = (dayRecords[0] as any).settle_time as number;
      const giftImg = detailedRecords.find(r => r.ruid === ruid && r.gift_price >= maxGiftPrice)?.gift_img || "";
      certifications.push({
        type: "lucky",
        ruid,
        rname: "",
        gift_name: dayRecords[0].reward_name,
        gift_price: dayRecords[0].reward_value / 100,
        gift_img: giftImg,
        spent: totalCost,
        profit: totalReward - totalCost,
        date: formatTimestamp(settleTime),
      });
    }

    // 非酋：当天翻了超过100次牌，其中一半以上是凶牌
    if (totalFlips > 100 && totalBadCards > totalFlips / 2) {
      const settleTime = (dayRecords[0] as any).settle_time as number;
      certifications.push({
        type: "unlucky",
        ruid,
        rname: "",
        gift_name: `${totalFlips}次翻牌`,
        gift_price: 0,
        gift_img: "",
        spent: totalCost,
        profit: totalReward - totalCost,
        date: formatTimestamp(settleTime),
        count: totalBadCards,
      });
    }
  }

  return certifications;
}

export function calculateSynthesisCertifications(
  detailedRecords: SynthesisDetailedRecord[],
  maxGiftPriceFromInfo?: number,
): SynthesisCertification[] {
  const certifications: SynthesisCertification[] = [];

  if (detailedRecords.length === 0) {
    return certifications;
  }

  // 确定最大礼物价格：必须从活动信息中获取，不能回退到实际记录的最大价格
  // 因为欧皇/非酋认证只针对活动定义的最大礼物（如30000电池），而不是用户实际合成过的最大礼物
  if (!maxGiftPriceFromInfo || maxGiftPriceFromInfo <= 0) {
    console.log("[calculateSynthesisCertifications] 活动信息中无最大礼物价格，不生成认证");
    return certifications;
  }
  const maxGiftPrice = maxGiftPriceFromInfo;

  console.log("[calculateSynthesisCertifications] 最大礼物价格:", maxGiftPrice);

  // 只考虑最大价格的礼物记录
  const maxPriceRecords = detailedRecords.filter(r => r.gift_price === maxGiftPrice);
  console.log("[calculateSynthesisCertifications] 最大礼物记录数:", maxPriceRecords.length, "总记录数:", detailedRecords.length);

  if (maxPriceRecords.length === 0) {
    console.log("[calculateSynthesisCertifications] 没有合成出最大礼物，不生成认证");
    return certifications;
  }

  const accumulatedMap = new Map<number, number>();
  const successRecords: Array<{
    ruid: number;
    rname: string;
    gift_name: string;
    gift_price: number;
    gift_img: string;
    totalSpent: number;
    profit: number;
    date: string;
    isFull: boolean;
  }> = [];

  for (let i = maxPriceRecords.length - 1; i >= 0; i--) {
    const record = maxPriceRecords[i];
    const accumulated = accumulatedMap.get(record.ruid) || 0;
    const newAccumulated = accumulated + record.spent;
    if (record.synthetic_result !== 0) {
      successRecords.push({
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        totalSpent: newAccumulated,
        profit: record.gift_price - newAccumulated,
        date: record.date,
        isFull: record.synthetic_result === 2,
      });
      accumulatedMap.set(record.ruid, 0);
    } else {
      accumulatedMap.set(record.ruid, newAccumulated);
    }
  }

  successRecords.reverse();

  for (const record of successRecords) {
    if (record.isFull) {
      certifications.push({
        type: "unlucky",
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        spent: record.totalSpent,
        profit: record.profit,
        date: record.date,
      });
    } else if (record.totalSpent < record.gift_price * 0.1) {
      certifications.push({
        type: "lucky",
        ruid: record.ruid,
        rname: record.rname,
        gift_name: record.gift_name,
        gift_price: record.gift_price,
        gift_img: record.gift_img,
        spent: record.totalSpent,
        profit: record.profit,
        date: record.date,
      });
    }
  }

  const dailyMaxGiftCounts = new Map<string, number>();
  for (const record of successRecords) {
    const dateKey = `${record.date.split(" ")[0]}_${record.ruid}`;
    dailyMaxGiftCounts.set(dateKey, (dailyMaxGiftCounts.get(dateKey) || 0) + 1);
  }

  for (const [dateKey, count] of dailyMaxGiftCounts) {
    if (count >= 6) {
      const [date, ruidStr] = dateKey.split("_");
      const ruid = parseInt(ruidStr);
      const firstRecord = successRecords.find(r => r.date.startsWith(date) && r.ruid === ruid);
      if (firstRecord) {
        certifications.push({
          type: "rich",
          ruid: firstRecord.ruid,
          rname: firstRecord.rname,
          gift_name: firstRecord.gift_name,
          gift_price: firstRecord.gift_price,
          gift_img: firstRecord.gift_img,
          spent: 0,
          profit: 0,
          date: date,
          count,
        });
      }
    }
  }

  return certifications;
}

/**
 * 计算历史合成活动盈亏（从消费记录中统计）
 * 逻辑：
 * - 花费 = gift_id === 1 的记录总价（合成材料，1电池），排除已退回
 * - 收益 = bag_desc === "包裹道具" 且排除天选礼物和红包礼物的记录总价（合成产物）
 */
export function calcHistoricalSynthesisProfit(
  records: RawGiftRecord[],
  tianxuanGiftIds: number[] = [],
  redPocketGiftIds: number[] = [],
): SynthesisProfitResult {
  // 天选和红包可能有重合，取并集
  const excludedGiftIds = new Set([...tianxuanGiftIds, ...redPocketGiftIds]);

  let totalSpent = 0;
  let totalEarned = 0;
  let drawCount = 0;
  let synthesisCount = 0;

  const spentRecords: RawGiftRecord[] = [];
  const earnedRecords: RawGiftRecord[] = [];

  for (const record of records) {
    const coins = Number((record.pay_coin || record.coin || "0").replace(/,/g, ""));
    
    if (record.status_msg === "已退回") {
      continue;
    }
    
    if (record.gift_id === 1) {
      totalSpent += coins;
      drawCount += record.gift_num;
      spentRecords.push(record);
    } else if (record.bag_desc === "包裹道具" && !excludedGiftIds.has(record.gift_id)) {
      totalEarned += coins;
      synthesisCount += record.gift_num;
      earnedRecords.push(record);
    }
  }

  // 构建礼物列表（按 gift_id 聚合）
  const giftMap = new Map<number, SynthesisGiftInfo>();
  const detailedRecords: SynthesisDetailedRecord[] = [];

  for (const r of earnedRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    const price = r.gift_num > 0 ? Math.round(coins / r.gift_num) : coins;
    const existing = giftMap.get(r.gift_id);
    if (existing) {
      existing.count += r.gift_num;
    } else {
      giftMap.set(r.gift_id, {
        gift_id: r.gift_id,
        gift_name: r.gift_name,
        gift_img: r.gift_img || "",
        gift_price: price,
        count: r.gift_num,
      });
    }
    detailedRecords.push({
      ruid: r.ruid,
      rname: r.r_uname || "",
      gift_name: r.gift_name,
      gift_price: price,
      gift_img: r.gift_img || "",
      spent: 0,
      profit: coins,
      synthetic_result: 1,
      date: r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "",
      synthetic_time: r.timestamp || 0,
      coin_type: r.coin_type,
      gift_id: r.gift_id,
    });
  }

  for (const r of spentRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    detailedRecords.push({
      ruid: r.ruid,
      rname: r.r_uname || "",
      gift_name: r.gift_name,
      gift_price: coins,
      gift_img: r.gift_img || "",
      spent: coins,
      profit: -coins,
      synthetic_result: 0,
      date: r.timestamp ? new Date(r.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "",
      synthetic_time: r.timestamp || 0,
      coin_type: r.coin_type,
      gift_id: r.gift_id,
    });
  }

  const giftList = Array.from(giftMap.values());

  console.log(`[calcHistoricalSynthesisProfit] 总记录数: ${records.length}`);
  console.log(`[calcHistoricalSynthesisProfit] 花费记录数: ${spentRecords.length}, 总花费: ${totalSpent}`);
  console.log(`[calcHistoricalSynthesisProfit] 收益记录数: ${earnedRecords.length}, 总收益: ${totalEarned}`);
  console.log(`[calcHistoricalSynthesisProfit] 礼物种类: ${giftList.length}, 详细记录: ${detailedRecords.length}`);
  console.log(`[calcHistoricalSynthesisProfit] 天选礼物ID列表(${tianxuanGiftIds.length}):`, tianxuanGiftIds);
  console.log(`[calcHistoricalSynthesisProfit] 红包礼物ID列表(${redPocketGiftIds.length}):`, redPocketGiftIds);
  console.log(`[calcHistoricalSynthesisProfit] 合并排除列表(${excludedGiftIds.size}):`, [...excludedGiftIds]);
  
  // 诊断：输出所有 bag_desc==="包裹道具" 的记录分类
  const allPackageRecords = records.filter(r => r.bag_desc === "包裹道具" && r.status_msg !== "已退回");
  const excludedRecords = allPackageRecords.filter(r => excludedGiftIds.has(r.gift_id));
  const includedRecords = allPackageRecords.filter(r => !excludedGiftIds.has(r.gift_id));
  console.log(`[calcHistoricalSynthesisProfit] 所有包裹道具记录: ${allPackageRecords.length}, 被排除(天选+红包): ${excludedRecords.length}, 计入合成: ${includedRecords.length}`);
  
  if (excludedRecords.length > 0) {
    console.log(`[calcHistoricalSynthesisProfit] 被排除的包裹道具详情:`);
    for (const r of excludedRecords.slice(0, 10)) {
      console.log(`  ${r.gift_name}(id:${r.gift_id}, inTianxuan:${tianxuanGiftIds.includes(r.gift_id)}, inRedPocket:${redPocketGiftIds.includes(r.gift_id)})`);
    }
  }
  
  if (earnedRecords.length > 0) {
    console.log(`[calcHistoricalSynthesisProfit] 前10条收益记录示例:`);
    for (let i = 0; i < Math.min(10, earnedRecords.length); i++) {
      const r = earnedRecords[i];
      console.log(`  - ${r.gift_name} (id:${r.gift_id}, coin_type:${r.coin_type || "(空)"}, bag_desc:${r.bag_desc}, coins:${r.pay_coin || r.coin}, num:${r.gift_num})`);
    }
  }

  return {
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    replaceCount: 0,
    synthesisCount,
    successCount: synthesisCount,
    giftList,
    detailedRecords,
  };
}

// ====== 筛选工具 ======

// ====== 礼物数据库（用于主播数据页面显示礼物图标） ======

const GIFT_DB_PATH = path.join(process.cwd(), ".data", "gift-db.json");

export type GiftDbEntry = {
  name: string;
  img: string;
};

export type GiftDb = {
  gifts: Record<number, GiftDbEntry>;
  red_pocket_gift_ids?: number[];
  last_red_pocket_update?: string;
  tianxuan_gift_ids?: number[];
  last_tianxuan_update?: string;
};

export function loadGiftDb(): GiftDb {
  try {
    if (existsSync(GIFT_DB_PATH)) {
      const raw = readFileSync(GIFT_DB_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("[GiftDB] 读取 gift-db.json 失败:", e);
  }
  return { gifts: {} };
}

export function saveGiftDb(db: GiftDb): void {
  try {
    const dir = path.dirname(GIFT_DB_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(GIFT_DB_PATH, JSON.stringify(db, null, 2), "utf-8");
  } catch (e) {
    console.error("[GiftDB] 保存 gift-db.json 失败:", e);
  }
}

/** 批量保存礼物信息到 gift-db.json */
export function saveGiftsToDb(giftInfos: Array<{ gift_id: number; name: string; img: string }>): void {
  const db = loadGiftDb();
  if (!db.gifts) db.gifts = {};
  let changed = false;
  for (const g of giftInfos) {
    if (!db.gifts[g.gift_id] || !db.gifts[g.gift_id].img) {
      db.gifts[g.gift_id] = { name: g.name, img: g.img };
      changed = true;
    }
  }
  if (changed) {
    saveGiftDb(db);
  }
}

/** 根据 gift_id 获取礼物图片，没找到返回空字符串 */
export function getGiftImg(giftId: number): string {
  const db = loadGiftDb();
  return db.gifts?.[giftId]?.img ?? "";
}