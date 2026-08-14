"use client";

/**
 * 活动配置系统类型定义
 *
 * 设计目标：B站活动经常更换，通过「配置文件(public/activities.json) + 页面组件注册表」实现
 * 活动可切换，每套活动可自定义：标题、入口图片、页面类型、必要参数(room_id/uid)、渲染模式。
 *
 * - pageType 决定用哪个 React 组件渲染（注册表映射）
 * - mode 决定渲染方式：replica=本地复刻页(浏览器 demo，走本地 mock)；
 *                        iframe=嵌入真实 H5(原生客户端 WebView，由原生层拦截 mock)
 * - 每个活动组件的"背后算法"由其对应的 mockApi 模块实现，与真实接口返回结构保持一致
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
  /** 入口卡片图片（public 下的静态资源路径） */
  entryImage: string;
  /** 页面类型：决定渲染哪个组件 */
  pageType: ActivityPageType;
  /** 渲染模式：replica=本地复刻；iframe=嵌入真实 H5（原生客户端拦截 mock） */
  mode: ActivityRenderMode;
  /** 必要参数（room_id / uid 等） */
  params: ActivityParams;
  /** 活动是否启用（配置切换时保留停用的活动） */
  enabled: boolean;
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
