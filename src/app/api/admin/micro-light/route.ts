import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { normalizeConfig, readConfig, readDraws, seasonIdFor, writeConfig } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

/**
 * GET /api/admin/micro-light
 * 返回备用药活动完整配置 + 全部抽奖记录 + 当前赛季号。
 */
export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  const [config, draws] = await Promise.all([readConfig(), readDraws()]);
  return NextResponse.json({
    code: 0,
    data: {
      config: {
        ...config,
        seasonAuto: config.seasonAuto,
        currentSeasonId: seasonIdFor(),
      },
      draws: draws.sort((a, b) => new Date(b.drawnAt).getTime() - new Date(a.drawnAt).getTime()),
    },
  });
}

/** POST /api/admin/micro-light —— 保存活动配置（奖品 / 开关 / 参数 / 微光天使） */
export async function POST(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求格式错误" }, { status: 400 });
  }
  const config = await writeConfig(normalizeConfig(body));
  return NextResponse.json({ code: 0, message: "配置已保存", data: { config } });
}
