/**
 * 盲盒有效配置（纯函数，无 fs；服务端与 Tauri 客户端共用，避免多处实现漂移）。
 *
 * 数据源：admin-config.json 的 blind_boxes（每个盲盒含完整礼物列表）。
 * 本模块把它归一化成便于运行时消费的形态：盲盒单价、礼物 id 列表、奖励礼物 id/名称。
 */

export type EffectiveBlindBoxGift = {
  giftId: number;
  giftName: string;
  /** 电池单价 */
  price: number;
  img: string;
  /** true = 额外奖励礼物（成本 0，仅计价值） */
  isReward: boolean;
};

export type EffectiveBlindBoxBox = {
  id: number;
  name: string;
  icon: string;
  /** 盲盒单价（电池）；0 = 未配置，调用方回退礼物目录 */
  blindPrice: number;
  /** 全部礼物 gift_id（含奖励礼物；gift_id=0 的奖励礼物不在此列） */
  giftIds: number[];
  /** 奖励礼物 gift_id（成本 0） */
  rewardGiftIds: Set<number>;
  /** 奖励礼物名称（包裹 bag_list 按名称匹配用） */
  rewardGiftNames: string[];
  /** 完整礼物明细（含过期盲盒的名称/价格/图标，用于元数据回填） */
  gifts: EffectiveBlindBoxGift[];
};

export type EffectiveBlindBoxBoxes = Record<number, EffectiveBlindBoxBox>;

/** 由 admin 配置的 blind_boxes 原始数组构建有效盲盒映射（容错任意输入） */
export function buildEffectiveBlindBoxBoxes(rawBoxes: unknown): EffectiveBlindBoxBoxes {
  const out: EffectiveBlindBoxBoxes = {};
  if (!Array.isArray(rawBoxes)) return out;

  for (const raw of rawBoxes) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const id = Number(b.id) || 0;
    if (id <= 0) continue;

    const gifts = Array.isArray(b.gifts) ? b.gifts : [];
    const giftIds: number[] = [];
    const rewardGiftIds = new Set<number>();
    const rewardGiftNames: string[] = [];
    const effectiveGifts: EffectiveBlindBoxGift[] = [];

    for (const rawGift of gifts) {
      const g = (rawGift ?? {}) as Record<string, unknown>;
      const giftId = Number(g.gift_id) || 0;
      const name = String(g.gift_name ?? "").trim();
      const isReward = g.is_reward === true;
      effectiveGifts.push({
        giftId,
        giftName: name,
        price: Number(g.price) || 0,
        img: String(g.gift_img ?? ""),
        isReward,
      });
      if (giftId > 0) giftIds.push(giftId);
      if (isReward) {
        if (giftId > 0) rewardGiftIds.add(giftId);
        if (name) rewardGiftNames.push(name);
      }
    }

    out[id] = {
      id,
      name: String(b.name ?? ""),
      icon: String(b.icon ?? ""),
      blindPrice: Number(b.blind_price) || 0,
      giftIds,
      rewardGiftIds,
      rewardGiftNames,
      gifts: effectiveGifts,
    };
  }

  return out;
}