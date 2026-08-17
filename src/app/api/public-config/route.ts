import { NextResponse } from "next/server";
import { readAdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

/**
 * 公开API：返回无需管理员权限即可查看的公共配置项。
 * 目前包含：
 *  - real_activity_url: 黑抽（真实合成活动）页面 URL 模板，为空表示管理员未配置，应禁用黑抽入口
 */
export async function GET() {
  const config = await readAdminConfig();
  return NextResponse.json({
    code: 0,
    data: {
      real_activity_url: config?.real_activity_url ?? "",
    },
  });
}
