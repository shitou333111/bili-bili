import { NextResponse } from "next/server";
import { getUserInfoByUid, clearUserInfoCache } from "@/lib/bilibili/gift-api";
import { setCachedFanInfo } from "@/lib/user-data";

export const dynamic = "force-dynamic";

const REQUEST_DELAY_MS = 200;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const uidsParam = url.searchParams.get("uids") ?? "";
  const refresh = url.searchParams.get("refresh") === "1";
  const requesterMid = Number(url.searchParams.get("mid")) || 0;
  const requesterUname = url.searchParams.get("uname") || "";

  if (!uidsParam) {
    return NextResponse.json({ code: 0, data: {} });
  }

  const allUids = uidsParam
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => !isNaN(n) && n > 0);

  if (allUids.length === 0) {
    return NextResponse.json({ code: 0, data: {} });
  }

  let uids: number[];
  if (refresh) {
    uids = allUids;
    for (const uid of allUids) {
      clearUserInfoCache(uid);
    }
    console.log(`[user-info] 强制刷新模式: ${allUids.length} 个UID`);
  } else {
    uids = allUids;
  }

  const results: Record<number, { name: string; face: string }> = {};
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    try {
      const info = await getUserInfoByUid(uid, refresh, requesterMid, requesterUname);
      results[uid] = info;
      if (info.face) {
        successCount++;
        // 持久化到用户的 send-fans-list.json
        if (requesterMid > 0) {
          await setCachedFanInfo(requesterMid, requesterUname, uid, info.name, info.face);
        }
      } else {
        failCount++;
        console.warn(`[user-info] uid=${uid} 未获取到头像 (name=${info.name})`);
      }
    } catch (err) {
      failCount++;
      console.warn(`[user-info] uid=${uid} 获取异常:`, err instanceof Error ? err.message : String(err));
      results[uid] = { name: `用户${uid}`, face: "" };
    }

    if (i < uids.length - 1) {
      await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  console.log(`[user-info] 批次完成: 总数=${allUids.length} API成功=${successCount} API失败=${failCount}${refresh ? " 强制刷新" : ""}`);

  return NextResponse.json({ code: 0, data: results });
}