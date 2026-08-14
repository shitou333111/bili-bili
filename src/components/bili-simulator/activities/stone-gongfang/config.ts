"use client";

import type { ActivityGiftInfo } from "../mock/types";

/**
 * 山海工坊（晶石工坊）活动配置
 *
 * 这里的参数就是该活动的「背后算法」：槽位数量、材料数值范围、抽取/替换价格、
 * 滚动消息池、合成礼物表。调整这些即可改变活动玩法。
 */

export const STONE_GONGFANG = {
  act_id: 110558,
  activity_name: "山海工坊",
  start_time: 1786161600,
  end_time: 1786723199,

  /** 槽位数量（固定 6 个） */
  slotCount: 6,
  /** 每个槽位材料数值范围 */
  slotMin: 1,
  slotMax: 7,

  /** 抽取一次消耗电池 */
  draw_price: 3000,
  /** 替换一次消耗电池（mock-shim.js 中按相同素材数动态计算，此处为本地复刻页默认值） */
  replace_price: 2800,

  /** 抽取/替换时可获得的礼物（接口返回的 gift_info 数组） */
  draw_gift_info: [
    {
      gift_id: 35729,
      gift_name: "纸船渡海",
      gift_img:
        "https://i0.hdslb.com/bfs/live/064740d9cb3dcb3e5f8a17e918059caec74ce329.png",
      gift_price: 12000,
    },
  ] as ActivityGiftInfo[],

  /** 滚动祝贺语池（carousel_list 从中随机/轮换取） */
  carousel_pool: [
    "恭喜Phoenix在山海工坊中获取护城大王",
    "恭喜AC4o2在山海工坊中获取山河入画",
    "恭喜Caictou在山海工坊中获取山河入画",
    "恭喜小羊嘎嘎嘎在山海工坊中获取护城大王",
    "恭喜某个优雅的男人在山海工坊中获取护城大王",
    "恭喜哦豁down在山海工坊中获取山河入画",
    "恭喜心寒的老父亲在山海工坊中获取护城大王",
    "恭喜Kono在山海工坊中获取山河入画",
  ],

  /**
   * 合成礼物表：按 6 个槽位材料总值（阈值 minTotal）决定合成出的礼物。
   * 从高到低匹配，总值越高合成礼物越大。
   */
  compose_gifts: [
    {
      minTotal: 24,
      gift: {
        gift_id: 35730,
        gift_name: "海图一角",
        gift_img:
          "https://i0.hdslb.com/bfs/live/4e94e3f83d45d24c66b086d5c1ccdea711bd0c44.png",
        gift_price: 25000,
      } as ActivityGiftInfo,
    },
    {
      minTotal: 0,
      gift: {
        gift_id: 35729,
        gift_name: "纸船渡海",
        gift_img:
          "https://i0.hdslb.com/bfs/live/064740d9cb3dcb3e5f8a17e918059caec74ce329.png",
        gift_price: 12000,
      } as ActivityGiftInfo,
    },
  ],
};
