import { NextResponse } from "next/server";
import { getUserInfoByUid, clearUserInfoCache } from "@/lib/bilibili/gift-api";
import { getCachedFaceUids, setCachedAnchorFace, setCachedAnchorName } from "@/lib/user-data";

const REQUEST_DELAY_MS = 200;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const uidsParam = url.searchParams.get("uids") ?? "";
  const refresh = url.searchParams.get("refresh") === "1";

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

  // refresh=1 时，忽略缓存，强制重新请求API获取最新头像URL
  let uids: number[];
  let fromCache = 0;
  if (refresh) {
    uids = allUids;
    // 清除内存缓存，强制重新请求
    for (const uid of allUids) {
      clearUserInfoCache(uid);
    }
    console.log(`[user-info] 强制刷新模式: ${allUids.length} 个UID`);
  } else {
    const cachedUids = await getCachedFaceUids();
    uids = allUids.filter(uid => !cachedUids.has(uid));
    fromCache = allUids.length - uids.length;
    if (fromCache > 0) {
      console.log(`[user-info] 缓存命中: ${fromCache}/${allUids.length}，需请求: ${uids.length}`);
    }
  }

  const results: Record<number, { name: string; face: string }> = {};
  let successCount = 0;
  let failCount = 0;
  const newEntries: Array<{ uid: number; face: string; name: string }> = [];

  // 串行处理
  for (let i = 0; i < uids.length; i++) {
    const uid = uids[i];
    try {
      const info = await getUserInfoByUid(uid, refresh);
      results[uid] = info;
      if (info.face) {
        successCount++;
        newEntries.push({ uid, face: info.face, name: info.name });
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

  // 非刷新模式：添加缓存命中的结果
  if (!refresh) {
    for (const uid of allUids) {
      if (!results[uid]) {
        results[uid] = await getUserInfoByUid(uid);
      }
    }
  }

  // 持久化
  if (newEntries.length > 0) {
    for (const { uid, face, name } of newEntries) {
      await setCachedAnchorFace(uid, face);
      if (name) {
        await setCachedAnchorName(uid, name);
      }
    }
  }

  console.log(`[user-info] 批次完成: 总数=${allUids.length} 缓存命中=${fromCache} API成功=${successCount} API失败=${failCount}${refresh ? " 强制刷新" : ""}`);

  return NextResponse.json({ code: 0, data: results });
}
