/**
 * 礼物汇总合并工具
 *
 * B站礼物 ID 可能随版本变更（下架 / 换新 ID），同一名字的礼物在历史记录中可能对应多个
 * gift_id（如"白羊娃娃"旧 id 34933、现 id 34928）。为保证主播页展示不分裂成多个条目，
 * 统一按名称合并：
 * - num / hamster 累加为一条
 * - 代表 gift_id 优先保留"能在当前礼物目录查到图标"的有效 ID（即最新 ID）
 * - 图标：代表 ID 查不到时按名称回退
 * - 空名称的礼物按各自 gift_id 独立成组，避免误合并
 *
 * 服务端（app/api/anchor/gifts/route.ts）、Tauri 客户端（anchor-gifts-client.ts）、
 * 前端按 records 重新聚合（AnchorDataModule.tsx）共用此函数，保证三处显示一致。
 */
export function buildGiftSummary(
  items: Array<{ gift_id: number; name: string; num: number; hamster: number }>,
  resolveImg: (giftId: number, name: string) => string,
): Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }> {
  const byName = new Map<string, { gift_id: number; name: string; num: number; hamster: number; img: string }>();
  // 已被占用的代表 gift_id：同一 ID 只允许作为一个组的代表，
  // 避免"同 ID 在历史记录中留下不同名字"或切换代表时撞车导致两个组共享同一 ID
  const usedIds = new Set<number>();
  for (const item of items) {
    const key = item.name || `#${item.gift_id}`;
    const img = resolveImg(item.gift_id, item.name);
    const existing = byName.get(key);
    if (existing) {
      existing.num += item.num;
      existing.hamster += item.hamster;
      // 代表 ID 优先换成能查到图标（当前目录存在）的有效 ID；
      // 目标 ID 已被其它组占用时保持原代表（图标靠名称回退兜底）
      if (!existing.img && img && !usedIds.has(item.gift_id)) {
        usedIds.delete(existing.gift_id);
        existing.gift_id = item.gift_id;
        existing.img = img;
        usedIds.add(item.gift_id);
      }
    } else {
      byName.set(key, { gift_id: item.gift_id, name: item.name, num: item.num, hamster: item.hamster, img });
      usedIds.add(item.gift_id);
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.hamster - a.hamster);
}
