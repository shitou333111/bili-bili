import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { getBlindBoxInfo } from "@/lib/blind-box-db";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const XINDONG_ID = 32251;
const CASTLE_ID = 32132; // 浪漫城堡
const XINDONG_PRICE = 150; // 心动盲盒单价
const DATA_DIR = path.join(process.cwd(), ".data");

function getBlindBoxRecordsDir(mid: number, uname: string): string {
  const safeName = uname.replace(/[\\/:*?"<>|]/g, "_");
  return path.join(DATA_DIR, `uid_${mid}_${safeName}`);
}

type DrawRecord = {
  gift_id: number;
  gift_name: string;
  gift_num: number;
  timestamp: string;
};

export type Certification = {
  date: string;
  type: "lucky" | "unlucky" | "rich";
  drawCount: number;
  castleCount: number;
  profit: number;
  spent: number;
  earned: number;
  userName: string;
  blindBoxName: string;
  blindBoxImg: string;
  castleName: string;
  castleImg: string;
};

export type CertificationResponse = {
  certifications: Certification[];
  hasCertification: boolean;
};

async function readBlindBoxRecords(mid: number, uname: string, blindBoxId: number): Promise<DrawRecord[]> {
  try {
    const dir = getBlindBoxRecordsDir(mid, uname);
    const filePath = path.join(dir, `blind-box-${blindBoxId}-records.json`);
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed.records ?? [];
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则返回需要重新登录（离线时跳过校验）
  if (!isOffline(url)) {
    const credentialResult = await ensureValidCredential(session);
    if (!credentialResult.valid) {
      return NextResponse.json<ApiResponse<null>>(
        { code: 401, message: "needs-relogin", data: null },
        { status: 401 },
      );
    }
  }

  const validSession = session;

  try {
    const blindBoxInfo = await getBlindBoxInfo(validSession.mid, validSession.uname, XINDONG_ID);
    const records = await readBlindBoxRecords(validSession.mid, validSession.uname, XINDONG_ID);

    if (records.length === 0) {
      return NextResponse.json<ApiResponse<CertificationResponse>>(
        {
          code: 0,
          message: "ok",
          data: { certifications: [], hasCertification: false },
        },
        { status: 200 },
      );
    }

    // 构建 gift_id -> price 映射表
    const priceMap = new Map<number, number>();
    if (blindBoxInfo?.gifts) {
      for (const g of blindBoxInfo.gifts) {
        priceMap.set(g.gift_id, g.price);
      }
    }

    const castleGift = blindBoxInfo?.gifts?.find((g) => g.gift_id === CASTLE_ID);

    // 按天聚合
    const dailyMap = new Map<string, {
      drawCount: number;
      castleCount: number;
      earned: number;
    }>();

    for (const record of records) {
      const date = record.timestamp.split(" ")[0]; // "2026-05-21"
      let daily = dailyMap.get(date);
      if (!daily) {
        daily = { drawCount: 0, castleCount: 0, earned: 0 };
        dailyMap.set(date, daily);
      }
      daily.drawCount += record.gift_num;
      if (record.gift_id === CASTLE_ID) {
        daily.castleCount += record.gift_num;
      }
      const price = priceMap.get(record.gift_id) ?? 0;
      daily.earned += price * record.gift_num;
    }

    // 找出认证
    const certifications: Certification[] = [];
    const blindBoxImg = blindBoxInfo?.blind_box_img ?? "";
    const castleImg = castleGift?.gift_img ?? "";
    const castleName = castleGift?.gift_name ?? "浪漫城堡";

    for (const [date, daily] of dailyMap) {
      const spent = daily.drawCount * XINDONG_PRICE;
      const profit = daily.earned - spent;

      // 欧皇: 至少一个城堡 + 平均不到100个盲盒就出一个城堡
      if (daily.castleCount >= 1 && (daily.drawCount / daily.castleCount) < 100) {
        certifications.push({
          date,
          type: "lucky",
          drawCount: daily.drawCount,
          castleCount: daily.castleCount,
          profit,
          spent,
          earned: daily.earned,
          userName: validSession.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }

      // 非酋: 超过1000个盲盒 + 没有城堡
      if (daily.drawCount > 1000 && daily.castleCount === 0) {
        certifications.push({
          date,
          type: "unlucky",
          drawCount: daily.drawCount,
          castleCount: 0,
          profit,
          spent,
          earned: daily.earned,
          userName: validSession.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }

      // 神豪: 单日开出6个或以上城堡
      if (daily.castleCount >= 6) {
        certifications.push({
          date,
          type: "rich",
          drawCount: daily.drawCount,
          castleCount: daily.castleCount,
          profit,
          spent,
          earned: daily.earned,
          userName: validSession.uname,
          blindBoxName: "心动盲盒",
          blindBoxImg,
          castleName,
          castleImg,
        });
      }
    }

    // 按日期降序排列
    certifications.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json<ApiResponse<CertificationResponse>>(
      {
        code: 0,
        message: "ok",
        data: {
          certifications,
          hasCertification: certifications.length > 0,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    console.error("[Certification] 获取认证数据失败:", err);
    return NextResponse.json<ApiResponse<null>>(
      { code: 500, message: "获取认证数据失败", data: null },
      { status: 500 },
    );
  }
}