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

/** 消费记录计算方式下的合成活动配置 */
export interface SynthesisActivityConfig {
  id: string;
  active?: boolean;
  /** 活动名称 */
  name?: string;
  /** 材料抽取窗口起点（unix 秒，可选，不填则无下界） */
  start_time?: number;
  /** 材料抽取窗口终点（unix 秒，可选，不填则无上界）；产物送出窗口为 [start_time, end_time + 49h] */
  end_time?: number;
  /** 该活动的产物礼物名称列表（用于匹配消费记录/包裹中的 gift_name） */
  products?: string[];
  /** 该活动的素材礼物名称列表（用于匹配消费记录中的 gift_name） */
  materials?: string[];
}

export const SYNTHESIS_CONFIG = {
  current_activity: [
    {
      id: "activity-5",
      name: "玲珑宝斋",
      products: ["相识玉扣", "常伴珠钗", "缘起瓷瓶", "倾心宝冠", "万象天衣"],
      materials: ["玲珑宝斋-锦囊", "玲珑宝斋-瓷瓶", "玲珑宝斋-银盒", "玲珑宝斋-云锦", "玲珑宝斋-玉函"],
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


