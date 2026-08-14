import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchRealPayRecordSnapshot } from "@/lib/bilibili/app";
import { readPayRecords, savePayRecords, getMaxId, type RawGiftRecord } from "@/lib/user-data";
import { isOffline } from "@/lib/offline";
import type { ApiResponse } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

/** 由本地缓存记录构建快照（纯本地聚合，不发 B站请求） */
async function buildCachedSnapshot(records: RawGiftRecord[]) {
  const allRecords = records.map(r => ({
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
  return {
    source: "real" as const,
    month: new Date().toISOString().slice(0, 7).replace("-", ""),
    nextId: allRecords.length > 0 ? allRecords[allRecords.length - 1].id : 0,
    totalRecords: allRecords.length,
    totalCoins,
    giftCatalog,
    records: allRecords,
  };
}

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
    // 无会话：前端应已拦截跳转登录页，此处兜底返回 needs-relogin
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }

  // 快速模式（本地优先）：只读本地缓存，跳过 B站校验与拉取，立即返回。
  // 客户端先显示本地数据，随后再后台调用普通模式同步 B站。
  if (url.searchParams.get("fast") === "1") {
    const cachedRecords = await readPayRecords(session.mid, session.uname);
    const result = await buildCachedSnapshot(cachedRecords);
    return NextResponse.json<ApiResponse<typeof result>>(
      { code: 0, message: cachedRecords.length > 0 ? "cached snapshot" : "empty cached", data: result },
      { status: 200 },
    );
  }

  // 离线模式：跳过 B 站校验与抓取，直接返回本地缓存的上次更新数据
  if (isOffline(url)) {
    const cachedRecords = await readPayRecords(session.mid, session.uname);
    if (cachedRecords.length > 0) {
      const result = await buildCachedSnapshot(cachedRecords);
      return NextResponse.json<ApiResponse<typeof result>>(
        { code: 0, message: "cached snapshot", data: result },
        { status: 200 },
      );
    }
  }

  // 验证 B站凭证，失效则尝试刷新，刷新失败则要求重新登录
  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    console.log("[PayRecord] B站凭证失效且刷新失败，需要重新登录");
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
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

    // 回溯窗口：活动退款（标记"已退回"）在原时期记录上原地修改，不是新增。
    // 因此增量时先按原方案确定"上次更新点"（本地最大 id 记录），再在更新点基础上额外向前回溯 1 周，
    // 重新拉取该窗口内记录并覆盖旧记录。
    const RETROSPECT_SECONDS = 7 * 24 * 3600; // 1 周
    // 上次更新点 = 本地最大 id 记录的时间戳（B站记录 id 单调递减，最大 id 即本地最新记录）
    const updatePointTimestamp = (existingMaxId > 0
      ? existingRecords.find((r) => r.id === existingMaxId)?.timestamp
      : undefined) ?? 0;
    const cutoffTimestamp = updatePointTimestamp > 0 ? updatePointTimestamp - RETROSPECT_SECONDS : 0;

    // 从B站获取新数据（增量 + 回溯窗口，按时间窗口停止翻页）
    const snapshot = await fetchRealPayRecordSnapshot(validSession, undefined, cutoffTimestamp);

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

    // 礼物图标由 gift-catalog 从 B站 giftConfig API 获取，无需再保存到 gift-db

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

    // 无缓存数据可降级，返回需要重新登录
    return NextResponse.json<ApiResponse<null>>(
      { code: 0, message: "needs-relogin", data: null },
      { status: 200 },
    );
  }
}