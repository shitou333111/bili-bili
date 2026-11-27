/**
 * 黑白榜卡片元数据（Server-only）
 *
 * 盲盒卡片 = admin「盲盒盈亏 - 卡片」勾选的盲盒；
 * 合成卡片 = admin 中 active 的合成活动 + 单独一个「一年内总合成」卡片。
 */

import { getEffectiveBlindBoxConfig, getEffectiveSynthesisConfig } from "./config-override";
import { BLIND_BOX_CONFIG } from "./config";
import { ensureGiftCatalogLoaded, getGiftImg, getGiftName, getGiftImgByName, getGiftList } from "./gift-catalog";
import {
  ALL_BLIND_CARD,
  blindCardKey,
  synCardKey,
  SYN_YEAR_CARD,
  type LeaderboardCardMeta,
  type LeaderboardMeta,
  type LeaderboardPeriodKey,
  type LeaderboardTopGift,
  type LeaderboardView,
} from "./leaderboard-types";
import { beijingDateKey, lastPastFridayKey } from "./leaderboard-time";

const PERIOD_LABEL: Record<LeaderboardPeriodKey, string> = {
  today: "今天",
  lastFriday: "上周五",
  activity: "活动期",
  year: "一年内",
};

/** 「一年内总合成」卡片图标：空心圆圈（内联 SVG，不依赖礼物目录） */
const YEAR_CARD_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%235b3fa8' stroke-width='2'/%3E%3C/svg%3E";

/** 心动 / 幸运盲盒：长期存在，用「今天 / 上周五」口径 */
const PERMANENT_BLIND_BOX_IDS = new Set<number>([BLIND_BOX_CONFIG.xindong, BLIND_BOX_CONFIG.lucky]);

/** 盲盒可爆出的最大礼物：含奖励礼物，取单价最高者 */
function topBlindBoxGift(box: { gifts: Array<{ giftId: number; giftName: string; price: number; img: string; isReward: boolean }> } | undefined): LeaderboardTopGift | undefined {
  if (!box) return undefined;
  let best: LeaderboardTopGift | null = null;
  for (const g of box.gifts) {
    if (!(g.price > 0)) continue;
    if (!best || g.price > best.price) {
      best = {
        id: g.giftId,
        name: g.giftName || getGiftName(g.giftId),
        img: g.img || getGiftImg(g.giftId),
        price: g.price,
      };
    }
  }
  return best ?? undefined;
}

/** 合成活动可产出的最大礼物：产物中按礼物目录单价取最高者 */
function topSynthesisGift(productNames: string[] | undefined): LeaderboardTopGift | undefined {
  let best: LeaderboardTopGift | null = null;
  const list = getGiftList();
  for (const name of productNames ?? []) {
    const item = list.find((g) => g.name === name);
    if (!item) continue;
    const price = item.coin_type === "gold" && item.price ? Math.round(item.price / 100) : 0;
    if (!(price > 0)) continue;
    if (!best || price > best.price) {
      best = {
        id: item.id,
        name,
        img: item.img_basic || getGiftImgByName(name),
        price,
      };
    }
  }
  return best ?? undefined;
}

export async function buildLeaderboardMeta(): Promise<LeaderboardMeta> {
  // 只读本地礼物目录（不联网），用于补全名称/图标；失败不影响主流程
  try {
    await ensureGiftCatalogLoaded({ allowNetwork: false });
  } catch {
    // ignore
  }

  const blindCfg = await getEffectiveBlindBoxConfig();
  const blindCards: LeaderboardCardMeta[] = [];
  // 「单位电池」备注只放在第一张非心动/幸运的盲盒卡上（这类卡没有时间切换，空间充足）
  let unitNoteAssigned = false;
  for (const id of blindCfg.current_activity_blind_box_ids) {
    const box = blindCfg.boxes[id];
    const title = box?.name || blindCfg.names[id] || getGiftName(id) || `盲盒 ${id}`;
    const icon = box?.icon || blindCfg.icons[id] || getGiftImg(id);
    const permanent = PERMANENT_BLIND_BOX_IDS.has(id);
    const unitNote = !permanent && !unitNoteAssigned;
    if (unitNote) unitNoteAssigned = true;
    blindCards.push({
      key: blindCardKey(id),
      tab: "blind",
      title,
      icon: icon || undefined,
      topGift: topBlindBoxGift(box),
      unitNote: unitNote || undefined,
      views: ["user", "anchor"],
      periods: permanent
        ? [
            { key: "today", label: PERIOD_LABEL.today },
            { key: "lastFriday", label: PERIOD_LABEL.lastFriday },
          ]
        : [{ key: "activity", label: PERIOD_LABEL.activity }],
      defaultView: "user",
      defaultPeriod: permanent ? "today" : "activity",
    });
  }

  // 「全部盲盒」聚合卡（仅主播盲盒视图）：对应软件内盲盒页最下方的"全部盲盒"盈亏，
  // 只统计 admin「盈亏」勾选的盲盒。放在盲盒卡片列表最后。
  const profitIds = blindCfg.profitIds ?? [];
  if (profitIds.length > 0) {
    blindCards.push({
      key: ALL_BLIND_CARD,
      tab: "blind",
      title: "全部盲盒",
      hideTopGift: true,
      boxes: profitIds.map((id) => {
        const box = blindCfg.boxes[id];
        return {
          id,
          name: box?.name || blindCfg.names[id] || getGiftName(id) || `盲盒 ${id}`,
          icon: box?.icon || blindCfg.icons[id] || getGiftImg(id) || "",
        };
      }),
      views: ["anchor"],
      periods: [{ key: "activity", label: "累计" }],
      defaultView: "anchor",
      defaultPeriod: "activity",
    });
  }

  const synthesisCfg = await getEffectiveSynthesisConfig();
  const synthesisCards: LeaderboardCardMeta[] = [];
  // 每个页面单独判断：「单位电池」放在合成页第一张有空间的卡片上
  let synthesisUnitNoteAssigned = false;
  for (const activity of synthesisCfg.current_activity) {
    const topGift = topSynthesisGift(activity.products);
    // 活动图标与软件内一致：取价值最高的产物；取不到时回退配置中最后一个产物
    const products = activity.products ?? [];
    const fallbackName = products.length > 0 ? products[products.length - 1] : "";
    const icon = topGift?.img || (fallbackName ? getGiftImgByName(fallbackName) : "");
    const unitNote = !synthesisUnitNoteAssigned;
    if (unitNote) synthesisUnitNoteAssigned = true;
    synthesisCards.push({
      key: synCardKey(activity.id),
      tab: "synthesis",
      title: activity.name || activity.id,
      icon: icon || undefined,
      topGift,
      unitNote: unitNote || undefined,
      views: ["user"],
      // 合成活动只有一个「活动期」口径，无需时间按钮组
      periods: [{ key: "activity", label: PERIOD_LABEL.activity }],
      defaultView: "user",
      defaultPeriod: "activity",
    });
  }
  synthesisCards.push({
    key: SYN_YEAR_CARD,
    tab: "synthesis",
    title: "一年内总合成",
    icon: YEAR_CARD_ICON,
    // 一年内总合成包含多个活动，无法确定一个「最大礼物」，不展示礼物列
    hideTopGift: true,
    unitNote: !synthesisUnitNoteAssigned || undefined,
    views: ["user"],
    periods: [{ key: "year", label: PERIOD_LABEL.year }],
    defaultView: "user",
    defaultPeriod: "year",
  });

  return {
    tabs: [
      { key: "blind", title: "盲盒黑白榜", cards: blindCards },
      { key: "synthesis", title: "合成黑白榜", cards: synthesisCards },
    ],
    lastFridayKey: lastPastFridayKey(),
    todayKey: beijingDateKey(),
  };
}

export function findCardMeta(meta: LeaderboardMeta, cardKey: string): LeaderboardCardMeta | null {
  for (const tab of meta.tabs) {
    const found = tab.cards.find((c) => c.key === cardKey);
    if (found) return found;
  }
  return null;
}

export function resolveView(card: LeaderboardCardMeta, view: unknown): LeaderboardView {
  return card.views.includes(view as LeaderboardView) ? (view as LeaderboardView) : card.defaultView;
}
