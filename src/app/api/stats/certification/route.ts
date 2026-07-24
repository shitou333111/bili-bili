import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { getBlindBoxInfo } from "@/lib/blind-box-db";
import type { ApiResponse } from "@/lib/bilibili/types";
import { promises as fs } from "fs";
import path from "path";

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

// 构建模拟的认证数据（未登录时返回）
function buildMockCertifications(): CertificationResponse {
  const blindBoxName = "心动盲盒";
  const blindBoxImg = "";
  const castleName = "浪漫城堡";
  const castleImg = "";

  const certifications: Certification[] = [
    // 欧皇认证：某一天爆出多个城堡
    {
      date: "2026-07-15",
      type: "lucky",
      drawCount: 50,
      castleCount: 3,
      spent: 50 * XINDONG_PRICE,
      earned: 37350 + 2000,
      profit: 37350 + 2000 - 50 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-07-05",
      type: "lucky",
      drawCount: 30,
      castleCount: 2,
      spent: 30 * XINDONG_PRICE,
      earned: 24900 + 1500,
      profit: 24900 + 1500 - 30 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-06-20",
      type: "lucky",
      drawCount: 80,
      castleCount: 2,
      spent: 80 * XINDONG_PRICE,
      earned: 24900 + 3000,
      profit: 24900 + 3000 - 80 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-05-30",
      type: "lucky",
      drawCount: 45,
      castleCount: 2,
      spent: 45 * XINDONG_PRICE,
      earned: 24900 + 1200,
      profit: 24900 + 1200 - 45 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-04-10",
      type: "lucky",
      drawCount: 60,
      castleCount: 2,
      spent: 60 * XINDONG_PRICE,
      earned: 24900 + 2500,
      profit: 24900 + 2500 - 60 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-02-14",
      type: "lucky",
      drawCount: 25,
      castleCount: 2,
      spent: 25 * XINDONG_PRICE,
      earned: 24900 + 800,
      profit: 24900 + 800 - 25 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2025-12-25",
      type: "lucky",
      drawCount: 70,
      castleCount: 2,
      spent: 70 * XINDONG_PRICE,
      earned: 24900 + 2000,
      profit: 24900 + 2000 - 70 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2025-09-15",
      type: "lucky",
      drawCount: 40,
      castleCount: 2,
      spent: 40 * XINDONG_PRICE,
      earned: 24900 + 1000,
      profit: 24900 + 1000 - 40 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    // 非酋认证：送出大量盲盒但未开出城堡
    {
      date: "2026-07-10",
      type: "unlucky",
      drawCount: 2500,
      castleCount: 0,
      spent: 2500 * XINDONG_PRICE,
      earned: 180000,
      profit: 180000 - 2500 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-06-05",
      type: "unlucky",
      drawCount: 1800,
      castleCount: 0,
      spent: 1800 * XINDONG_PRICE,
      earned: 120000,
      profit: 120000 - 1800 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-03-20",
      type: "unlucky",
      drawCount: 1500,
      castleCount: 0,
      spent: 1500 * XINDONG_PRICE,
      earned: 100000,
      profit: 100000 - 1500 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2025-11-20",
      type: "unlucky",
      drawCount: 2000,
      castleCount: 0,
      spent: 2000 * XINDONG_PRICE,
      earned: 140000,
      profit: 140000 - 2000 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    // 神豪认证：单日开出6个或以上城堡
    {
      date: "2026-07-18",
      type: "rich",
      drawCount: 300,
      castleCount: 8,
      spent: 300 * XINDONG_PRICE,
      earned: 8 * 12450 + 50000,
      profit: 8 * 12450 + 50000 - 300 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-06-15",
      type: "rich",
      drawCount: 250,
      castleCount: 7,
      spent: 250 * XINDONG_PRICE,
      earned: 7 * 12450 + 40000,
      profit: 7 * 12450 + 40000 - 250 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
    {
      date: "2026-04-01",
      type: "rich",
      drawCount: 280,
      castleCount: 6,
      spent: 280 * XINDONG_PRICE,
      earned: 6 * 12450 + 35000,
      profit: 6 * 12450 + 35000 - 280 * XINDONG_PRICE,
      userName: "模拟用户",
      blindBoxName,
      blindBoxImg,
      castleName,
      castleImg,
    },
  ];

  // 按日期降序排列
  certifications.sort((a, b) => b.date.localeCompare(a.date));

  return {
    certifications,
    hasCertification: certifications.length > 0,
  };
}

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
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  const sid = sidMatch?.[1] ?? null;
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    // 未登录时返回模拟的认证数据
    const mockData = buildMockCertifications();
    return NextResponse.json<ApiResponse<CertificationResponse>>(
      { code: 0, message: "mock", data: mockData },
      { status: 200 },
    );
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则返回需要重新登录
  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    return NextResponse.json<ApiResponse<null>>(
      { code: 401, message: "needs-relogin", data: null },
      { status: 401 },
    );
  }

  const validSession = credentialResult.session;

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