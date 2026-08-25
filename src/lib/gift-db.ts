import type { RawGiftRecord } from "@/lib/revenue";
import type { BagGiftItem } from "@/lib/bilibili/gift-api";
import type { SynthesisActivityConfig } from "@/lib/config";

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
  /** 按主播维度的历史合成盈亏统计（仅历史总盈亏卡片使用） */
  anchorStats?: SynthesisAnchorProfitInfo[];
};

export type SynthesisAnchorProfitInfo = {
  ruid: number;
  rname: string;
  /** 合成功数（不区分价值，即合成产物的 gift_num 总和） */
  count: number;
  /** 价值（合成产物总价） */
  value: number;
  /** 花费（合成材料总价） */
  spent: number;
  /** 盈亏 = 价值 - 花费 */
  profit: number;
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
  /** 合成产物记录的数量（包裹礼物补充时若大于1则为多条聚合数量） */
  gift_num?: number;
  /** 消费记录方式：素材记录关联的产物名（用于卡片按产物聚合花费） */
  product_name?: string;
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

export type SynthesisActivityStats = {
  id: string;
  type?: string;
  name: string;
  icon?: string;
  start_time?: number;
  end_time?: number;
  profit: SynthesisActivityProfitResult;
  certifications: SynthesisCertification[];
};

/**
 * 计算历史合成活动盈亏（从消费记录中统计，按主播/直播间独立累计）
 *
 * 历史总盈亏覆盖所有合成活动（消费记录是全量的），而页面上方列举的活动只是其中几个，
 * 因此历史统计必须基于消费记录。同时，每个主播的花费与收益在其各自直播间内独立累计，
 * 避免跨直播间混算导致"0 礼物但有花费"或"有礼物但无花费"的误统计。
 *
 * 逻辑（与之前一致，仅增加按主播维度聚合）：
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

    // 礼物天选（gift_id=1 但 gift_name="礼物天选"）不是合成材料花费，排除
    if (record.gift_id === 1 && record.gift_name === "礼物天选") {
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

  // 按主播/直播间独立累计（花费=合成材料，价值=合成产物）
  const anchorMap = new Map<number, SynthesisAnchorProfitInfo>();
  for (const r of spentRecords) {
    const cur = anchorMap.get(r.ruid) || {
      ruid: r.ruid,
      rname: r.r_uname || "",
      count: 0,
      value: 0,
      spent: 0,
      profit: 0,
    };
    cur.spent += Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    if (r.r_uname) cur.rname = cur.rname || r.r_uname;
    anchorMap.set(r.ruid, cur);
  }
  for (const r of earnedRecords) {
    const coins = Number((r.pay_coin || r.coin || "0").replace(/,/g, ""));
    const cur = anchorMap.get(r.ruid) || {
      ruid: r.ruid,
      rname: r.r_uname || "",
      count: 0,
      value: 0,
      spent: 0,
      profit: 0,
    };
    cur.value += coins;
    cur.count += r.gift_num;
    if (r.r_uname) cur.rname = cur.rname || r.r_uname;
    anchorMap.set(r.ruid, cur);
  }
  for (const info of anchorMap.values()) {
    info.profit = info.value - info.spent;
  }
  const anchorStats = Array.from(anchorMap.values()).sort((a, b) => b.value - a.value);

  const giftList = Array.from(giftMap.values());

  console.log(`[calcHistoricalSynthesisProfit] 总记录数: ${records.length}`);
  console.log(`[calcHistoricalSynthesisProfit] 花费记录数: ${spentRecords.length}, 总花费: ${totalSpent}`);
  console.log(`[calcHistoricalSynthesisProfit] 收益记录数: ${earnedRecords.length}, 总收益: ${totalEarned}`);
  console.log(`[calcHistoricalSynthesisProfit] 礼物种类: ${giftList.length}, 详细记录: ${detailedRecords.length}, 主播数: ${anchorStats.length}`);

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
    anchorStats,
  };
}

/**
 * 按消费记录计算单个合成活动的盈亏（method = "payrecord"）
 *
 * 直播间错位问题不存在：某直播间合成的礼物只能送给该主播，产物记录的 ruid 即可信，
 * 因此按 ruid（直播间/主播）独立累计 spent/earned，规则参考 calcHistoricalSynthesisProfit。
 *
 * 时间窗口（起止时间均可选，不填则对应方向无边界，即使用全部消费记录）：
 * - 材料抽取消费记录严格在 [start_time, end_time] 内
 * - 合成产物送出记录截止到 end_time + 48h，为容错使用 end_time + 49h 作为实际截止
 *
 * 层次匹配：
 * - 每个层次由「产物礼物名称 + 材料消费礼物名称」定义（名称用 includes 关键词匹配）
 * - 材料名称可能各层相同（如都叫"抽取素材"），若该层填了素材单价则只计入单价一致的记录
 *   （单价 = 记录 pay_coin / gift_num，容差 0.01），未填单价的层次接受任意价格
 * - 同一层素材总价也可能变化（抽取时可自定义数量），因此必须逐记录累加 pay_coin，
 *   不能以单价 × 记录数估算
 *
 * 包裹礼物补充（bagGifts）：
 * 合成产物礼物在未送出前不会消费（不出现于消费记录），而是暂存于包裹（bag_list）。
 * 用活动各层次的产物礼物名称匹配包裹中的礼物，区分其所属主播后补充计入产出，
 * 使包裹礼物与消费记录互补构成完整的合成产物列表。
 */
export function calcPayRecordActivityProfit(
  records: RawGiftRecord[],
  config: SynthesisActivityConfig,
  excludedGiftIds: Set<number> = new Set(),
  bagGifts: BagGiftItem[] = [],
): SynthesisActivityProfitResult {
  const products = config.products || [];
  const materials = config.materials || [];
  // 起止时间可选：未填则对应方向不设边界（范围 = 所有消费记录）
  const startTs = config.start_time;
  const endTs = config.end_time;
  const productEndTs = endTs === undefined ? Number.POSITIVE_INFINITY : endTs + 49 * 3600;
  const inMaterialWindow = (ts: number) =>
    (startTs === undefined || ts >= startTs) && (endTs === undefined || ts <= endTs);
  const inProductWindow = (ts: number) =>
    (startTs === undefined || ts >= startTs) && ts <= productEndTs;
  // 素材/产物直接按消费记录 gift_name 模糊匹配；无需把产物与素材一一对应，也无需素材单价区分
  const inMaterials = (giftName: string) => materials.some((m) => giftName.includes(m));
  const inProducts = (giftName: string) => products.some((p) => giftName.includes(p));

  let totalSpent = 0;
  let totalEarned = 0;
  let drawCount = 0;
  let synthesisCount = 0;

  const giftMap = new Map<number, SynthesisGiftInfo>();
  const anchorMap = new Map<number, SynthesisAnchorInfo>();
  const detailedRecords: SynthesisDetailedRecord[] = [];

  const coinsOf = (record: RawGiftRecord) => Number((record.pay_coin || record.coin || "0").replace(/,/g, ""));
  const dateStrOf = (ts: number) =>
    ts ? new Date(ts * 1000).toISOString().slice(0, 10).replace(/-/g, ".") : "";

  for (const record of records) {
    if (record.status_msg === "已退回") continue;
    // 礼物天选（gift_id=1 但 gift_name="礼物天选"）不是合成材料花费，排除
    if (record.gift_id === 1 && record.gift_name === "礼物天选") continue;

    const ts = record.timestamp || 0;
    const coins = coinsOf(record);

    // 素材：gift_name 匹配 materials 中任一名称，且时间在材料窗口内
    if (inMaterialWindow(ts) && coins > 0 && materials.length > 0 && inMaterials(record.gift_name)) {
      totalSpent += coins;
      drawCount += record.gift_num;

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: record.r_uname || "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalSpent += coins;
      if (record.r_uname) anchor.rname = anchor.rname || record.r_uname;
      anchorMap.set(record.ruid, anchor);

      detailedRecords.push({
        ruid: record.ruid,
        rname: record.r_uname || "",
        gift_name: record.gift_name,
        gift_price: record.gift_num > 0 ? coins / record.gift_num : coins,
        gift_img: record.gift_img || "",
        spent: coins,
        profit: -coins,
        synthetic_result: 0,
        date: dateStrOf(ts),
        synthetic_time: ts,
        coin_type: record.coin_type,
        gift_id: record.gift_id,
      });
      continue; // 一条记录只归入一个角色，避免同时被当作产物
    }

    // 产物：包裹道具 + gift_name 匹配 products 中任一名称 + 时间在产物窗口内
    if (
      record.bag_desc === "包裹道具" &&
      !excludedGiftIds.has(record.gift_id) &&
      inProductWindow(ts) &&
      products.length > 0 &&
      inProducts(record.gift_name)
    ) {
      totalEarned += coins;
      synthesisCount += record.gift_num;

      const price = record.gift_num > 0 ? Math.round(coins / record.gift_num) : coins;
      const existing = giftMap.get(record.gift_id);
      if (existing) {
        existing.count += record.gift_num;
      } else {
        giftMap.set(record.gift_id, {
          gift_id: record.gift_id,
          gift_name: record.gift_name,
          gift_img: record.gift_img || "",
          gift_price: price,
          count: record.gift_num,
        });
      }

      const anchor = anchorMap.get(record.ruid) || {
        ruid: record.ruid,
        rname: record.r_uname || "",
        totalSpent: 0,
        totalEarned: 0,
      };
      anchor.totalEarned += coins;
      if (record.r_uname) anchor.rname = anchor.rname || record.r_uname;
      anchorMap.set(record.ruid, anchor);

      detailedRecords.push({
        ruid: record.ruid,
        rname: record.r_uname || "",
        gift_name: record.gift_name,
        gift_price: price,
        gift_img: record.gift_img || "",
        spent: 0,
        profit: coins,
        synthetic_result: 1,
        date: dateStrOf(ts),
        synthetic_time: ts,
        coin_type: record.coin_type,
        gift_id: record.gift_id,
      });
    }
  }

  // ===== 包裹礼物补充 =====
  // 合成产物礼物在未送出前不会出现在消费记录中，会暂存于包裹（bag_list）。
  // 用活动的产物礼物匹配包裹礼物，并区分其所属主播后补充计入产出。
  if (bagGifts.length > 0 && products.length > 0) {
    // 消费记录假定最新在前，取每条 r_uname 首次出现的 ruid（当前昵称 → 最新 UID 映射）
    const nameRuids = new Map<string, number>();
    for (const n of records) {
      if (n.r_uname && !nameRuids.has(n.r_uname)) nameRuids.set(n.r_uname, n.ruid);
    }
    // room_id → ruid 映射（未锁定的当前直播间礼物归属）
    const roomRuids = new Map<number, number>();
    for (const r of records) {
      if (!roomRuids.has(r.room_id)) roomRuids.set(r.room_id, r.ruid);
    }
    const anchorNameMatcher = /该礼物仅限([^的]+)的直播间使用/;

    for (const g of bagGifts) {
      if (!inProducts(g.gift_name)) continue;

      // 归属主播：未锁定 → 当前直播间（room_id=23915535）；锁定 → 从 locked_text 解析主播名再映射最新 ruid
      let ruid: number | undefined;
      if (!g.is_locked) {
        ruid = roomRuids.get(23915535);
      } else {
        const m = g.locked_text.match(anchorNameMatcher);
        const anchorName = m ? m[1] : "";
        ruid = nameRuids.get(anchorName);
      }
      if (ruid === undefined) continue; // 无法归属，保守跳过该礼物

      const earned = g.price * g.gift_num;
      totalEarned += earned;
      synthesisCount += g.gift_num;

      const anchor = anchorMap.get(ruid) || {
        ruid,
        rname: "",
        totalSpent: 0,
        totalEarned: 0,
      };
      if (!anchor.rname) {
        for (const r of records) {
          if (r.ruid === ruid && r.r_uname) {
            anchor.rname = r.r_uname;
            break;
          }
        }
      }
      anchor.totalEarned += earned;
      anchorMap.set(ruid, anchor);

      const existing = giftMap.get(g.gift_id);
      if (existing) {
        existing.count += g.gift_num;
      } else {
        giftMap.set(g.gift_id, {
          gift_id: g.gift_id,
          gift_name: g.gift_name,
          gift_img: g.img,
          gift_price: Math.round(g.price),
          count: g.gift_num,
        });
      }

      detailedRecords.push({
        ruid,
        rname: anchor.rname,
        gift_name: g.gift_name,
        gift_price: g.price,
        gift_img: g.img,
        spent: 0,
        profit: earned,
        synthetic_result: 1,
        date: "",
        synthetic_time: 0,
        gift_id: g.gift_id,
        gift_num: g.gift_num,
      });
    }
  }

  const giftList = Array.from(giftMap.values());
  const anchors = Array.from(anchorMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

  console.log(`[calcPayRecordActivityProfit] 活动 ${config.id} 总记录数: ${records.length}, 包裹补充礼物: ${bagGifts.length}`);
  console.log(`[calcPayRecordActivityProfit] 花费记录: ${totalSpent}, 收益记录: ${totalEarned}, 盈亏: ${totalEarned - totalSpent}`);
  console.log(`[calcPayRecordActivityProfit] 礼物种类: ${giftList.length}, 详细记录: ${detailedRecords.length}, 主播数: ${anchors.length}`);

  return {
    totalSpent,
    totalEarned,
    profit: totalEarned - totalSpent,
    drawCount,
    replaceCount: 0,
    synthesisCount,
    successCount: synthesisCount,
    giftList,
    anchors,
    detailedRecords,
  };
}