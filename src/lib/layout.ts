/**
 * 全局布局常量
 * 页面最大宽度由 src/lib/page-config.json 统一配置，TypeScript 和 Rust 都读它。
 */
import pageConfig from "./page-config.json";

export const PAGE_MAX_WIDTH_NUM: number = pageConfig.page_max_width;

// 盲盒卡片背景色板（按盲盒在列表中的展示顺序分配）
// 固定盲盒始终排在前面：心动盲盒(32251) → 下标0 暖米色，幸运盲盒(35206) → 下标1 淡蓝色
// 因此同一个盲盒在“粉丝消费”与“主播数据”中颜色一致。
export const BLIND_BOX_CARD_BG = [
  "bg-[#f9f4ea]", // 心动盲盒 - 暖米色
  "bg-[#eef3fb]", // 幸运盲盒 - 淡蓝色
  "bg-[#fff7ef]", // 淡橙色
  "bg-[#f3f0fa]", // 淡紫色
  "bg-[#eaf7f3]", // 淡青色
  "bg-[#fdf0f4]", // 淡粉色
  "bg-[#f5f0e8]", // 淡驼色
  "bg-[#eef9e6]", // 淡绿色
] as const;

// 根据盲盒在列表中的展示顺序取色
export function getBlindBoxCardBg(orderIndex: number): string {
  return BLIND_BOX_CARD_BG[orderIndex % BLIND_BOX_CARD_BG.length];
}

// 历史总盈亏卡片背景色（与活动卡片色板区分，保证独一无二）
export const HISTORICAL_PNL_BG = "bg-[#f6f6f5]";