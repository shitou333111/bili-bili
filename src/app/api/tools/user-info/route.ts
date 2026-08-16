import { NextResponse } from "next/server";
import { getUserInfoByUid, clearUserInfoCache } from "@/lib/bilibili/gift-api";
import { setCachedFanInfo } from "@/lib/user-data";

export const dynamic = "force-dynamic";

// 有界并发：同时最多向 B站 API 发起 CONCURRENCY 个请求。
// 相比原先逐个 uid 串行 + 200ms 固定延迟，首屏头像获取从分钟级降到十几秒。
const CONCURRENCY = 10;

/** 以固定并发数处理一批 uid，全部完成后 resolve */
async function runPool<T>(items: number[], worker: (uid: number) => Promise<T>): Promise<void> {
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  }
  const count = Math.min(CONCURRENCY, items.length);
  await Promise.all(Array.from({ length: count }, next));
}

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

  await runPool(uids, async (uid) => {
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
  });

  console.log(`[user-info] 批次完成: 总数=${allUids.length} API成功=${successCount} API失败=${failCount}${refresh ? " 强制刷新" : ""}`);

  return NextResponse.json({ code: 0, data: results });
}