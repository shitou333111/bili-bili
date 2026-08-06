import { NextResponse } from "next/server";
import { buildMockPayRecordSnapshot } from "@/lib/revenue";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchRealPayRecordSnapshot } from "@/lib/bilibili/app";
import { saveGiftsToDb } from "@/lib/gift-db";
import { readPayRecords, savePayRecords, getMaxId, type RawGiftRecord } from "@/lib/user-data";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  // fallback: query 参数 _sid（Tauri WebView 可能不发送 cookie）
  if (!sid) {
    sid = url.searchParams.get("_sid") ?? null;
  }
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    const snapshot = buildMockPayRecordSnapshot();
    return NextResponse.json<ApiResponse<typeof snapshot>>(
      { code: 0, message: "mock snapshot", data: snapshot },
      { status: 200 },
    );
  }

  // 离线模式：跳过 B 站校验与抓取，直接返回本地缓存的上次更新数据
  if (isOffline(url)) {
    const cachedRecords = await readPayRecords(session.mid, session.uname);
    if (cachedRecords.length > 0) {
      const allRecords = cachedRecords.map(r => ({
        ...r,
        totalCoins: Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0,
        giftNameKey: r.gift_name,
      }));
      const giftCatalog = Array.from(
        allRecords.reduce((map, record) => {
          const key = `${record.gift_id}_${record.gift_name}`;
          if (!map.has(key)) {
            map.set(key, {
              giftName: record.gift_name,
              giftImg: record.gift_img,
              giftId: record.gift_id,
              latestTimestamp: record.timestamp,
            });
          }
          return map;
        }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>()).values(),
      );
      const totalCoins = allRecords.reduce((sum, r) => sum + r.totalCoins, 0);
      const result = {
        source: "real" as const,
        month: new Date().toISOString().slice(0, 7).replace("-", ""),
        nextId: allRecords.length > 0 ? allRecords[allRecords.length - 1].id : 0,
        totalRecords: allRecords.length,
        totalCoins,
        giftCatalog,
        records: allRecords,
      };
      return NextResponse.json<ApiResponse<typeof result>>(
        { code: 0, message: "cached snapshot", data: result },
        { status: 200 },
      );
    }
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则返回 mock 并要求重新登录
  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    console.log("[PayRecord] B站凭证失效且刷新失败，需要重新登录");
    const snapshot = buildMockPayRecordSnapshot();
    return NextResponse.json<ApiResponse<typeof snapshot>>(
      { code: 0, message: "needs-relogin", data: snapshot },
      { status: 200 },
    );
  }

  // 使用验证后的 session（可能已刷新凭证）
  const validSession = credentialResult.session;

  console.log(`[PayRecord] 拉取B站最新数据（用户: ${validSession.mid} ${validSession.uname}）...`);

  try {
    // 读取已有记录，获取最大id
    const existingRecords = await readPayRecords(validSession.mid, validSession.uname);
    const existingMaxId = getMaxId(existingRecords);
    console.log(`[PayRecord] 已有 ${existingRecords.length} 条记录，最新id=${existingMaxId}`);

    // 从B站获取新数据（增量，只获取id > existingMaxId）
    const snapshot = await fetchRealPayRecordSnapshot(validSession, undefined, existingMaxId);

    // 合并：新记录在前，已有记录在后
    const newRecords = snapshot.records as unknown as RawGiftRecord[];
    const mergedRecords = existingMaxId > 0
      ? [...newRecords, ...existingRecords]
      : newRecords;
    
    // 去重（按id）
    const seenIds = new Set<number>();
    const dedupedRecords = mergedRecords.filter(r => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    });

    // 保存合并后的记录
    await savePayRecords(validSession.mid, validSession.uname, dedupedRecords);
    console.log(`[PayRecord] 新增 ${newRecords.length} 条，合并后共 ${dedupedRecords.length} 条`);

    // 构建返回的snapshot（使用合并后的全部记录）
    const allRecords = dedupedRecords.map(r => ({
      ...r,
      totalCoins: Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0,
      giftNameKey: r.gift_name,
    }));

    // giftCatalog: 按 gift_id + gift_name 去重（同一gift_id可能有不同礼物）
    const giftCatalog = Array.from(
      allRecords.reduce((map, record) => {
        const key = `${record.gift_id}_${record.gift_name}`;
        if (!map.has(key)) {
          map.set(key, {
            giftName: record.gift_name,
            giftImg: record.gift_img,
            giftId: record.gift_id,
            latestTimestamp: record.timestamp,
          });
        }
        return map;
      }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>()).values(),
    );

    // 保存礼物信息到 gift-db.json
    if (giftCatalog.length > 0) {
      await saveGiftsToDb(giftCatalog.map(g => ({ gift_id: g.giftId, name: g.giftName, img: g.giftImg })));
    }

    const totalCoins = allRecords.reduce((sum, r) => sum + r.totalCoins, 0);

    const result = {
      source: "real" as const,
      month: snapshot.month,
      nextId: allRecords.length > 0 ? allRecords[allRecords.length - 1].id : 0,
      totalRecords: allRecords.length,
      totalCoins,
      giftCatalog,
      records: allRecords,
    };

    return NextResponse.json<ApiResponse<typeof result>>(
      { code: 0, message: "real snapshot", data: result },
      { status: 200 },
    );
  } catch (err) {
    console.error("[PayRecord] 获取数据失败:", err);
    // 降级：尝试返回已有数据
    try {
      const existingRecords = await readPayRecords(validSession.mid, validSession.uname);
      if (existingRecords.length > 0) {
        const allRecords = existingRecords.map(r => ({
          ...r,
          totalCoins: Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0,
          giftNameKey: r.gift_name,
        }));
        const giftCatalog = Array.from(
          allRecords.reduce((map, record) => {
            const key = `${record.gift_id}_${record.gift_name}`;
            if (!map.has(key)) {
              map.set(key, {
                giftName: record.gift_name,
                giftImg: record.gift_img,
                giftId: record.gift_id,
                latestTimestamp: record.timestamp,
              });
            }
            return map;
          }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>()).values(),
        );
        const totalCoins = allRecords.reduce((sum, r) => sum + r.totalCoins, 0);
        const result = {
          source: "real" as const,
          month: new Date().toISOString().slice(0, 7).replace("-", ""),
          nextId: allRecords.length > 0 ? allRecords[allRecords.length - 1].id : 0,
          totalRecords: allRecords.length,
          totalCoins,
          giftCatalog,
          records: allRecords,
        };
        return NextResponse.json<ApiResponse<typeof result>>(
          { code: 0, message: "cached snapshot", data: result },
          { status: 200 },
        );
      }
    } catch {}
    
    const snapshot = buildMockPayRecordSnapshot();
    return NextResponse.json<ApiResponse<typeof snapshot>>(
      { code: 0, message: "mock snapshot", data: snapshot },
      { status: 200 },
    );
  }
}