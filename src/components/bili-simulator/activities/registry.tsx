"use client";

/**
 * 活动注册表
 *
 * - public/activities.json 提供可切换的活动配置数据（标题/入口图/页面类型/参数）
 * - 本文件维护「页面类型 → React 组件」映射，并负责加载活动配置
 *
 * 新增一个活动：
 *  1. 在 activities/ 下新建活动目录，实现页面组件 + mockApi（背后算法）
 *  2. 在本文件 ACTIVITY_COMPONENTS 中登记 pageType → 组件
 *  3. 在 public/activities.json 中增加一条配置（可替换/停用旧活动）
 */

import { useEffect, useState, type ComponentType } from "react";
import type { ActivityConfig, ActivityPageProps } from "./types";
import { resolveActivityMode } from "./environment";
import StoneGongfangPage from "./stone-gongfang/StoneGongfangPage";

/** 页面类型 → 组件注册表 */
export const ACTIVITY_COMPONENTS: Record<string, ComponentType<ActivityPageProps>> = {
  "stone-gongfang": StoneGongfangPage,
};

/** 加载活动配置列表（仅返回启用的活动） */
export function useActivities() {
  const [activities, setActivities] = useState<ActivityConfig[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/activities.json")
      .then((r) => r.json())
      .then((list: ActivityConfig[]) => {
        setActivities(
          Array.isArray(list)
            ? list
                .filter((a) => a.enabled)
                .map((a) => ({ ...a, mode: resolveActivityMode(a.mode) }))
            : []
        );
      })
      .catch(() => setActivities([]))
      .finally(() => setLoading(false));
  }, []);

  return { activities, loading };
}

/** 根据页面类型获取组件（未注册返回 null） */
export function getActivityComponent(
  pageType: string
): ComponentType<ActivityPageProps> | null {
  return ACTIVITY_COMPONENTS[pageType] ?? null;
}
