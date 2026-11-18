/**
 * 红包礼物分类列表（服务端）
 *
 * 唯一来源：admin 配置中的 red_pocket_gifts —— 由管理员手动维护（B站没有稳定接口能拿到新红包礼物）。
 * 该列表只用于「标记消费记录中的礼物类型」，例如计算合成盈亏时扣除红包礼物；
 * 与自动抢红包的扫描列表（RedPocketActiveList）无关。
 */
import { readAdminConfig, type SpecialGiftItem } from "./admin-config";

export async function getEffectiveRedPocketGifts(): Promise<SpecialGiftItem[]> {
  const config = await readAdminConfig();
  return (config?.red_pocket_gifts ?? []).filter((g) => g.id > 0);
}
