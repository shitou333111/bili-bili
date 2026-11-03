/**
 * 试玩抽奖：用与正式抽奖完全相同的概率算法随机出一个奖品，
 * 但不写入任何抽奖记录、不占用 PK 局的抽奖名额。
 *
 * 期望值固定为 100 电池（等价于 100 × votesPerBattery 票），
 * 便于用户在页面上直观感受奖池概率与动画效果。
 */

import { NextResponse } from "next/server";

import { readConfig, rollPrize } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const config = await readConfig();
    const roll = rollPrize(config, 100 * config.votesPerBattery);
    const prize = roll.prize;

    return NextResponse.json({
      code: 0,
      data: {
        targetEv: roll.targetEv,
        probabilities: roll.probabilities,
        prize: prize
          ? {
              id: prize.id,
              kind: prize.kind,
              name: prize.name,
              img: prize.img ?? "",
              text: prize.text,
              battery: prize.battery,
            }
          : null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { code: 500, message: err instanceof Error ? err.message : "试玩失败" },
      { status: 500 },
    );
  }
}
