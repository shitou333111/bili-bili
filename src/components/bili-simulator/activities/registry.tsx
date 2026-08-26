"use client";

/**
 * 活动注册表
 *
 * - 活动配置优先从服务器 /api/simulator-activities 拉取（管理员在 admin 页维护，
 *   含 URL 模板 + 算法类型），失败时回退到打包静态 public/activities.json；
 * - 本文件维护「页面类型 → React 组件」映射，并负责把远程配置归一化为 ActivityConfig。
 *
 * 新增一个活动：
 *  1. 若玩法属于已有算法类型：只需在 admin 页新增配置并选择对应算法类型即可，无需改代码；
 *  2. 若玩法全新：在 activities/ 下新建活动目录实现算法（mock-shim.js 分派 + algorithms.ts 注册），
 *     客户端通过前端热更新推送，无需原生包更新。
 */

import { useEffect, useState, type ComponentType } from "react";
import type { ActivityConfig, ActivityPageProps, ActivityRenderMode } from "./types";
import { resolveActivityMode } from "./environment";
import StoneGongfangPage from "./stone-gongfang/StoneGongfangPage";
import { serverFetch } from "@/lib/server-api";

/** 页面类型 → 组件注册表 */
export const ACTIVITY_COMPONENTS: Record<string, ComponentType<ActivityPageProps>> = {
  "stone-gongfang": StoneGongfangPage,
};

/**
 * 把活动配置归一化为 ActivityConfig。
 * 兼容两种来源：
 *  - 远程 admin 配置：{ id, title, entryImage, urlTemplate, roomId, uid, enabled, algorithmType, algorithmParams }
 *  - 本地 activities.json：{ id, title, entryImage, pageType, mode, params:{url,roomId,uid}, enabled }
 */
function toActivityConfig(raw: unknown): ActivityConfig | null {
  const a = raw as Record<string, any>;
  if (!a || typeof a !== "object") return null;
  const url = typeof a.urlTemplate === "string" ? a.urlTemplate : a.params?.url;
  if (typeof url !== "string" || !url) return null;
  return {
    id: String(a.id || url),
    title: String(a.title || "活动"),
    entryImage: String(a.entryImage || ""),
    pageType: (a.pageType as ActivityConfig["pageType"]) || "iframe",
    mode: resolveActivityMode((a.mode as ActivityRenderMode | undefined) || "iframe"),
    params: {
      roomId: Number(a.roomId ?? a.params?.roomId ?? 0),
      uid: Number(a.uid ?? a.params?.uid ?? 0),
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

/** 从打包静态 activities.json 拉取（本地兜底） */
async function fetchLocalActivities(): Promise<ActivityConfig[]> {
  const res = await fetch("/activities.json");
  const list = (await res.json()) as unknown[];
  return Array.isArray(list)
    ? list.map(toActivityConfig).filter((a): a is ActivityConfig => !!a && a.enabled)
    : [];
}

/** 加载活动配置列表（仅返回启用的活动）：远程优先，失败回退本地 */
export function useActivities() {
  const [activities, setActivities] = useState<ActivityConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const remote = await fetchRemoteActivities();
        // 服务器返回空列表（如老部署的 admin-config.json 尚无 simulator_activities 字段）：
        // 同样回退本地配置，避免模拟器活动入口凭空消失（保持既有体验）。
        if (remote.length > 0) {
          if (!cancelled) setActivities(remote);
          return;
        }
        throw new Error("remote empty");
      } catch {
        // 服务器不可达 / 返回异常 / 空列表 → 回退本地打包配置，保证离线也能展示活动
        try {
          const local = await fetchLocalActivities();
          if (!cancelled) setActivities(local);
        } catch {
          if (!cancelled) setActivities([]);
        }
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
