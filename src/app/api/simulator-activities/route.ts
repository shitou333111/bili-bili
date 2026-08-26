import { NextResponse } from "next/server";
import { readAdminConfig, type SimulatorActivityConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

/**
 * 公开API：返回模拟器页面的活动入口配置（无需管理员权限）。
 * 仅返回启用(enabled)的活动，含算法类型 algorithmType 与算法参数 algorithmParams，
 * 由模拟器页面据此打开真实 H5 并注入对应算法类型的 mock-shim。
 * 玩法算法本身走前端热更新（mock-shim.js），无需原生包更新。
 */
export async function GET() {
  const config = await readAdminConfig();
  const activities: SimulatorActivityConfig[] = Array.isArray(config?.simulator_activities)
    ? config!.simulator_activities.filter((a) => a && a.enabled !== false)
    : [];
  return NextResponse.json({
    code: 0,
    data: { activities },
  });
}
