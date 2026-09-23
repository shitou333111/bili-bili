/**
 * Server-only: 读取 admin-config.json 覆盖默认配置
 * 只能在 API 路由（server-side）中使用，不能在客户端组件中导入
 */
import { readAdminConfig } from "./admin-config";
import { BLIND_BOX_CONFIG, SYNTHESIS_CONFIG, type SynthesisActivityConfig } from "./config";

export type EffectiveBlindBoxConfig = {
  xindong: number;
  current_activity_blind_box_ids: number[];
  current_activity_blind_box_id: number | null;
  icons: Record<number, string>;
  names: Record<number, string>;
  /** 盲盒盈亏查询配置：admin 指定的可查询盈亏的盲盒 id（有序，供"全部盲盒"下拉 + 弹幕查询） */
  profitIds: number[];
};

export async function getEffectiveBlindBoxConfig(): Promise<EffectiveBlindBoxConfig> {
  const adminConfig = await readAdminConfig();
  const names: Record<number, string> = {};
  for (const box of adminConfig?.blind_boxes ?? []) {
    if (box.id > 0 && box.name) names[box.id] = box.name;
  }
  if (!adminConfig) {
    // 活动盲盒在最前，随后心动、幸运
    const ids: number[] = [];
    if (BLIND_BOX_CONFIG.current_activity_blind_box_id) ids.push(BLIND_BOX_CONFIG.current_activity_blind_box_id);
    if (!ids.includes(BLIND_BOX_CONFIG.xindong)) ids.push(BLIND_BOX_CONFIG.xindong);
    if (!ids.includes(BLIND_BOX_CONFIG.lucky)) ids.push(BLIND_BOX_CONFIG.lucky);
    return {
      xindong: BLIND_BOX_CONFIG.xindong,
      current_activity_blind_box_ids: ids,
      current_activity_blind_box_id: ids.length > 0 ? ids[0] : null,
      icons: BLIND_BOX_CONFIG.icons,
      names,
      profitIds: ids,
    };
  }
  const icons: Record<number, string> = { ...BLIND_BOX_CONFIG.icons };
  const validBoxIds = new Set<number>();
  validBoxIds.add(BLIND_BOX_CONFIG.xindong); // 心动盲盒始终有效
  validBoxIds.add(BLIND_BOX_CONFIG.lucky); // 幸运盲盒始终有效
  for (const box of adminConfig.blind_boxes) {
    if (box.id > 0) {
      icons[box.id] = box.icon;
      validBoxIds.add(box.id);
    }
  }
  // 只保留仍然存在于 blind_boxes 列表中的 ID，过滤掉已删除盲盒的幽灵引用
  const checkedIds = new Set((adminConfig.current_activity_blind_box_ids ?? []).filter((id) => validBoxIds.has(id)));
  // 卡片盲盒完全按 admin 勾选控制（无心动/幸运特殊路径），按 blind_boxes 顺序输出
  const filteredIds: number[] = [];
  for (const box of adminConfig.blind_boxes) {
    if (box.id > 0 && checkedIds.has(box.id)) filteredIds.push(box.id);
  }
  // 盈亏查询范围完全按 admin 勾选控制（过滤幽灵引用并去重），为空即不涵盖任何盲盒
  const profitIds = (adminConfig.blind_box_profit_ids ?? [])
    .filter((id) => validBoxIds.has(id))
    .filter((id, i, arr) => arr.indexOf(id) === i);
  return {
    xindong: BLIND_BOX_CONFIG.xindong,
    current_activity_blind_box_ids: filteredIds,
    current_activity_blind_box_id: filteredIds.length > 0 ? filteredIds[0] : null,
    icons,
    names,
    profitIds,
  };
}

export async function getEffectiveSynthesisConfig() {
  const adminConfig = await readAdminConfig();
  if (!adminConfig) return SYNTHESIS_CONFIG;
  // 只返回 active !== false 的活动
  return {
    current_activity: (adminConfig.synthesis_activities as SynthesisActivityConfig[]).filter((a) => a.active !== false),
  };
}
