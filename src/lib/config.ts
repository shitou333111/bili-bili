/**
 * 项目配置文件
 * 集中管理活动盲盒ID、合成活动信息等可变参数
 */

// ====== 盲盒配置 ======
export const BLIND_BOX_CONFIG = {
  // 心动盲盒（常规）
  xindong: 32251,
  // 幸运盲盒（固定盲盒，始终显示）
  lucky: 35206,
  // 当前活动盲盒（在配置文件中指定，如果不存在则显示"当前无活动盲盒"）
  current_activity_blind_box_id: 35684 as number | null,
  // 盲盒图标映射
  icons: {
    32251: "https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png",
    35206: "https://s1.hdslb.com/bfs/live/d9bf4b2234e854b0badbd509edf59b5bf0361b7f.png",
    35684: "https://s1.hdslb.com/bfs/live/48307f9c584235ade71c59de9c93eaa607b03388.png",
  } as Record<number, string>,
} as const;

// ====== 合成活动配置 ======
export type SynthesisActivityType = "slot_draw" | "material_package" | "card_flip";

export interface SynthesisActivityConfig {
  id: string;
  type: SynthesisActivityType;
  info_url: string;
  record_url: string;
  active?: boolean;
}

export const SYNTHESIS_CONFIG = {
  current_activity: [
    {
      id: "activity-1",
      type: "material_package",
      info_url: "https://api.live.bilibili.com/xlive/custom-activity-interface/general/syntheticpackage/HalfInit?config_id=sp_2076590402963353600",
      record_url: "https://api.live.bilibili.com/xlive/custom-activity-interface/general/syntheticpackage/PlayRecord?config_id=sp_2076590402963353600",
    },
    {
      id: "activity-2",
      type: "slot_draw",
      info_url: "https://api.live.bilibili.com/xlive/custom-activity-interface/general/StarStoneInfo?conf_id=9",
      record_url: "https://api.live.bilibili.com/xlive/custom-activity-interface/general/StarStoneRecord?conf_id=9",
    },
    {
      id: "activity-3",
      type: "card_flip",
      info_url: "",
      record_url: "https://api.live.bilibili.com/xlive/custom-activity-interface/general/cardplay/PlayRecord?config_id=8",
    },
  ] as SynthesisActivityConfig[],
};

// ====== 天选礼物列表接口 ======
export const TIANXUAN_CONFIG = {
  url: "https://api.live.bilibili.com/xlive/general-interface/v1/guardBenefit/GiftPanel",
} as const;

// ====== 红包礼物列表接口 ======
export const RED_POCKET_CONFIG = {
  url: "https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketDetail",
} as const;

// ====== 盲盒检测接口 ======
export const BLIND_BOX_API = {
  // 盲盒信息检测（获取盲盒内礼物列表）
  blindFirstWin: "https://api.live.bilibili.com/xlive/general-interface/v1/blindFirstWin/getInfo",
  // 盲盒抽取记录（需登录态）
  drawStream: "https://api.live.bilibili.com/xlive/general-interface/v1/blind-box/drawStream",
} as const;


