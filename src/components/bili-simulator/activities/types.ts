"use client";

/**
 * 活动配置系统类型定义
 *
 * 设计目标：B站活动经常更换，活动配置以服务器 admin 配置（.data/admin-config.json）为唯一数据源，
 * 每套活动可自定义：标题、入口图片、URL 模板、必要参数(room_id/uid)、背后玩法算法类型。
 *
 * - algorithmType 决定用哪套 mock 算法（algorithms.ts 注册表 → mock-shim.js 分派）
 * - mode 决定渲染方式：replica=本地复刻页(浏览器 demo，走本地 mock)；
 *                        iframe=嵌入真实 H5(原生客户端 WebView，由原生层拦截 mock)
 */

export type ActivityPageType = "stone-gongfang" | "iframe";

export type ActivityRenderMode = "replica" | "iframe";

/** 活动必要参数：真实 H5 页面需要的目标直播间 room_id 与主播 uid */
export interface ActivityParams {
  /** 目标直播间 room_id（活动页必要参数） */
  roomId: number;
  /** 目标主播 uid（活动页必要参数） */
  uid: number;
  /** 主播昵称（可选，展示用） */
  anchorName?: string;
  /** 真实 H5 页面地址模板，{roomId} / {uid} 会被替换为参数值 */
  url: string;
}

export interface ActivityConfig {
  /** 活动唯一 ID（对应注册表中的 pageType 组件） */
  id: string;
  /** 活动标题 */
  title: string;
  /** 入口卡片图片（public 下的静态资源路径，或外部 URL） */
  entryImage: string;
  /** 页面类型：决定渲染哪个组件 */
  pageType: ActivityPageType;
  /** 渲染模式：replica=本地复刻；iframe=嵌入真实 H5（原生客户端拦截 mock） */
  mode: ActivityRenderMode;
  /** 必要参数（room_id / uid 等） */
  params: ActivityParams;
  /** 活动是否启用（配置切换时保留停用的活动） */
  enabled: boolean;
  /**
   * 算法类型：对应 algorithms.ts 注册表中的一个键，决定 mock-shim 使用哪套 mock 算法
   * 返回当前活动页面的模拟数据。缺省按 "stone-gongfang"（晶石工坊）处理。
   */
  algorithmType?: string;
  /** 算法类型专属参数（透传给 mock-shim 的 CONFIG，可覆盖算法默认值） */
  algorithmParams?: Record<string, unknown>;
}

/** 活动页面组件通用 Props */
export interface ActivityPageProps {
  /** 当前活动配置 */
  config: ActivityConfig;
  /** 返回上一页 */
  onBack: () => void;
  /** 当前登录用户昵称（模拟） */
  userName?: string;
}

/** 根据配置构建真实 H5 页面 URL */
export function buildActivityUrl(config: ActivityConfig): string {
  return config.params.url
    .replace("{roomId}", String(config.params.roomId))
    .replace("{uid}", String(config.params.uid));
}

/**
 * 从 URL 模板中提取字面的 room_id / uid 数值（仅匹配数字，占位符如 {roomId} 不命中）。
 * 用于 roomId / uid 配置为 0 时的兜底默认值：优先取 URL 模板中自带的真实参数。
 */
export function extractRoomUidFromUrl(url: string): { roomId?: number; uid?: number } {
  const out: { roomId?: number; uid?: number } = {};
  const query = (url.split("?")[1] ?? "") + "&" + (url.split("#")[1] ?? "");
  const mRoom = query.match(/[?&]room_id=(\d+)/);
  const mUid = query.match(/[?&]uid=(\d+)/);
  if (mRoom) out.roomId = Number(mRoom[1]);
  if (mUid) out.uid = Number(mUid[1]);
  return out;
}
