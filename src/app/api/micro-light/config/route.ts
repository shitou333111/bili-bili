import { NextResponse } from "next/server";
import { readConfig, seasonIdFor } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * GET /api/micro-light/config
 * 公开活动配置（不含概率等后台细节）：是否开放、奖池、微光天使、规则参数。
 */
export async function GET() {
  const config = await readConfig();
  return NextResponse.json({
    code: 0,
    data: {
      enabled: config.enabled,
      seasonId: config.seasonAuto ? seasonIdFor() : config.seasonId,
      drawWindowHours: config.drawWindowHours,
      monthlyWinCap: config.monthlyWinCap,
      voidScoreThreshold: config.voidScoreThreshold,
      votesPerBattery: config.votesPerBattery,
      prizes: config.prizes.map((p) => ({
        id: p.id,
        kind: p.kind,
        name: p.name,
        img: p.img ?? "",
        battery: p.battery,
        text: p.text,
      })),
      sponsors: config.sponsors,
    },
  });
}
