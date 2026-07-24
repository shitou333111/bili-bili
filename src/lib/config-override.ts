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
};

export async function getEffectiveBlindBoxConfig(): Promise<EffectiveBlindBoxConfig> {
  const adminConfig = await readAdminConfig();
  if (!adminConfig) {
    return {
      xindong: BLIND_BOX_CONFIG.xindong,
      current_activity_blind_box_ids: BLIND_BOX_CONFIG.current_activity_blind_box_id ? [BLIND_BOX_CONFIG.current_activity_blind_box_id] : [],
      current_activity_blind_box_id: BLIND_BOX_CONFIG.current_activity_blind_box_id,
      icons: BLIND_BOX_CONFIG.icons,
    };
  }
  const icons: Record<number, string> = { ...BLIND_BOX_CONFIG.icons };
  const validBoxIds = new Set<number>();
  validBoxIds.add(BLIND_BOX_CONFIG.xindong); // 心动盲盒始终有效
  for (const box of adminConfig.blind_boxes) {
    if (box.id > 0) {
      icons[box.id] = box.icon;
      validBoxIds.add(box.id);
    }
  }
  // 只保留仍然存在于 blind_boxes 列表中的 ID，过滤掉已删除盲盒的幽灵引用
  const filteredIds = (adminConfig.current_activity_blind_box_ids ?? []).filter((id) => validBoxIds.has(id));
  // 确保心动盲盒始终在列表中
  if (!filteredIds.includes(BLIND_BOX_CONFIG.xindong)) {
    filteredIds.unshift(BLIND_BOX_CONFIG.xindong);
  }
  return {
    xindong: BLIND_BOX_CONFIG.xindong,
    current_activity_blind_box_ids: filteredIds,
    current_activity_blind_box_id: filteredIds.length > 0 ? filteredIds[0] : null,
    icons,
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
