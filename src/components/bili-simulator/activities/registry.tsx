"use client";

/**
 * 活动注册表
 *
 * - 活动配置唯一数据源为服务器 /api/simulator-activities（管理员在 admin 页维护，
 *   含 URL 模板 + 算法类型），不再使用打包静态 public/activities.json；
 * - 本文件把远程配置归一化为 ActivityConfig。
 *
 * 新增一个活动：
 *  1. 若玩法属于已有算法类型：只需在 admin 页新增配置并选择对应算法类型即可，无需改代码；
 *  2. 若玩法全新：在 activities/ 下新建活动目录实现算法（mock-shim.js 分派 + algorithms.ts 注册），
 *     客户端通过前端热更新推送，无需原生包更新。
 */

import { useEffect, useState, type ComponentType } from "react";
import type { ActivityConfig, ActivityPageProps, ActivityRenderMode } from "./types";
import { resolveActivityMode } from "./environment";
import { extractRoomUidFromUrl } from "./types";
import StoneGongfangPage from "./stone-gongfang/StoneGongfangPage";
import { serverFetch } from "@/lib/server-api";

/** 页面类型 → 组件注册表 */
export const ACTIVITY_COMPONENTS: Record<string, ComponentType<ActivityPageProps>> = {
  "stone-gongfang": StoneGongfangPage,
};

/**
 * 把远程活动配置归一化为 ActivityConfig。
 * 远程 admin 配置格式：{ id, title, entryImage, urlTemplate, roomId, uid, enabled, algorithmType, algorithmParams }
 */
function toActivityConfig(raw: unknown): ActivityConfig | null {
  const a = raw as Record<string, any>;
  if (!a || typeof a !== "object") return null;
  const url = typeof a.urlTemplate === "string" ? a.urlTemplate : a.params?.url;
  if (typeof url !== "string" || !url) return null;
  // roomId/uid 未配置（0）时，回退到 URL 模板中自带的字面参数作为默认值
  const fromUrl = extractRoomUidFromUrl(url);
  return {
    id: String(a.id || url),
    title: String(a.title || "活动"),
    entryImage: String(a.entryImage || ""),
    pageType: (a.pageType as ActivityConfig["pageType"]) || "iframe",
    mode: resolveActivityMode((a.mode as ActivityRenderMode | undefined) || "iframe"),
    params: {
      roomId: Number(a.roomId ?? a.params?.roomId ?? 0) || fromUrl.roomId || 0,
      uid: Number(a.uid ?? a.params?.uid ?? 0) || fromUrl.uid || 0,
      url,
    },
    enabled: a.enabled !== false,
    algorithmType: a.algorithmType || "stone-gongfang",
    algorithmParams: a.algorithmParams ?? {},
  };
}

/** 从服务器拉取活动配置（仅启用项） */
async function fetchRemoteActivities(): Promise<ActivityConfig[]> {
  const res = await serverFetch<{ code: number; data?: { activities?: unknown[] } }>(
    "/api/simulator-activities"
  );
  const list = res?.data?.activities;
  if (!Array.isArray(list)) return [];
  return list
    .map(toActivityConfig)
    .filter((a): a is ActivityConfig => !!a && a.enabled);
}

/** 加载活动配置列表（仅返回启用的活动）：唯一数据源为服务器 admin 配置 */
export function useActivities() {
  const [activities, setActivities] = useState<ActivityConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await fetchRemoteActivities();
        if (!cancelled) setActivities(remote);
      } catch {
        // 服务器不可达 / 返回异常 → 无活动入口（不再回退本地配置）
        if (!cancelled) setActivities([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { activities, loading };
}

/** 根据页面类型获取组件（未注册返回 null） */
export function getActivityComponent(
  pageType: string
): ComponentType<ActivityPageProps> | null {
  return ACTIVITY_COMPONENTS[pageType] ?? null;
}
