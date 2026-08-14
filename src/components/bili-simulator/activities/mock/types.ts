"use client";

/**
 * 活动接口响应契约（与真实 B站接口返回结构完全一致）
 *
 * 这是「原生客户端拦截」与「本地 mock」共同遵循的数据契约：
 * - 原生客户端：WebView 拦截 shouldInterceptRequest / WKURLSchemeHandler 命中
 *   StarStoneDraw / StarStoneReplace / StarStoneCompose 时，返回与下面相同的 JSON。
 * - 浏览器 demo：本地 mockApi 直接产出相同结构。
 *
 * 三个接口：
 *  - StarStoneDraw    ：抽取一个槽位的材料（扣 draw_price 电池）
 *  - StarStoneReplace ：替换一个槽位的材料（扣 replace_price 电池）
 *  - StarStoneCompose ：合成礼物（按槽位材料总值决定合成的礼物）
 */

export interface ActivityGiftInfo {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  gift_price: number;
}

/** draw / replace 公共返回结构 */
export interface StarStoneCommonData {
  act_id: number;
  activity_name: string;
  start_time: number;
  end_time: number;
  cur_timestamp: number;
  /** 最近中奖滚动消息 */
  carousel_list: string[];
  /** 抽取价格（电池） */
  draw_price: number;
  /** 替换价格（电池） */
  replace_price: number;
  /** 当前可获得的礼物信息 */
  gift_info: ActivityGiftInfo[];
  /** 6 个槽位的材料值，形如 {"1":5,"2":2,"3":4,"4":7,"5":6,"6":5} */
  slot_info: string;
}

export interface StarStoneDrawResult {
  code: number;
  message: string;
  ttl: number;
  data: StarStoneCommonData;
}

export interface StarStoneReplaceResult {
  code: number;
  message: string;
  ttl: number;
  data: StarStoneCommonData;
}

export interface StarStoneComposeResult {
  code: number;
  message: string;
  ttl: number;
  data: {
    gift_info: ActivityGiftInfo;
  };
}
