/**
 * Tauri 客户端 - 礼物录屏数据获取
 *
 * 在 Tauri 原生环境下，直接调用 B站 API（通过平台层解决 CORS），
 * 逻辑与 src/app/api/anchor/gift-replay/route.ts 对应，但运行在客户端，使用本地会话 Cookie。
 *
 * 覆盖 action：list（场次）、gifts（礼物，翻页）、clips（切片重签+下载 2s 片段+过滤版 m3u8 播放列表）。
 * 所有数据均在本地获取，不经过自建服务器：2s 片段由平台层二进制下载后转 Blob URL 内嵌进播放列表，
 * hls.js 播放 Blob URL，无需跨域代理。
 */

import type { Platform } from "./platform/types";
import { resolveSession, buildCookie } from "./stats-client";
import { ensureValidCredentialClient } from "./bilibili/cookie-refresh-client";

// ==================== 常量 ====================

const REPLAY_LIST_API =
  "https://api.live.bilibili.com/xlive/anchor-task-interface/api/v1/GetHistoryLiveStreamRecordListNew";
const GIFT_INFO_API =
  "https://api.live.bilibili.com/xlive/anchor-center-interface/v1/anchorLiveData/GetLiveRecordInfos";
const BASE_INFO_API =
  "https://api.live.bilibili.com/xlive/anchor-center-interface/v1/anchorLiveData/GetLiveBaseInfo";
const USER_SCORE_RANK_API =
  "https://api.live.bilibili.com/xlive/app-blink/v1/liveUserRank/UserScoreRank";
const PAGE_SIZE = 50;
const SEG_SECONDS = 2; // 每段短视频时长
const BEFORE_SECONDS = 5; // 礼物时刻前 5s
const AFTER_SECONDS = 15; // 礼物时刻后 15s
const SEVEN_DAY_SEC = 7 * 24 * 3600;

// ==================== 类型定义 ====================

type ReplaySession = {
  start_time: number;
  end_time: number;
  title: string;
  live_id: string;
  duration: number;
  area: string;
};

type RawGiftItem = {
  nickname?: string;
  gift_name?: string;
  send_gift_time?: number;
  gift_count?: number;
  gift_value?: number;
  gift_icon?: string;
  /** 送礼用户 UID（接口返回时透传，用于横幅头像；无则缺省） */
  uid?: number;
};

type ReplayListResp = {
  code: number;
  message: string;
  data?: {
    list?: Array<{ start_time: number; end_time: number; title?: string; live_id: string; duration?: number; area?: string }>;
    last?: boolean;
    next_start_time?: string;
  };
};

type GiftListResp = {
  code: number;
  message: string;
  data?: { gift_income_details?: RawGiftItem[]; next_index?: number; log_date?: string };
};

type BaseResp = {
  code: number;
  message: string;
  data?: { list?: Array<{ start_time: number; end_time: number; stream?: string }> };
};

type UserScoreRankResp = {
  code: number;
  message: string;
  data?: { userInfos?: Array<{ nickname?: string; uname?: string; face?: string }> };
};

const NEEDS_RELOGIN = { code: 0, message: "needs-relogin", data: null };

// ==================== 30min 片段 URL 处理 ====================

/**
 * 直接使用 GetLiveBaseInfo 返回的 stream URL 请求 m3u8。
 *
 * 说明：该接口的 sign 由 B站 在 GetLiveBaseInfo 响应时即时签发，在有效期内直接请求必然成功，
 * 无需重签。项目现有签名模块（移动端 APP 签名：参数需带 appkey + 固定 secret）与 videoPlay
 * 接口不匹配——该 URL 不含 appkey 字段，用该 secret 计算的 sign 与 B站 返回值不一致（已验证），
 * 强行重签会得到错误 sign 导致 m3u8 HTTP 400。若未来遇到原 sign 过期，需另行研究该接口专用签名。
 */
function resolvePlayUrl(streamUrl: string): string {
  return streamUrl.replace(/\\u0026/g, "&");
}

// ==================== 会话 & Cookie ====================

/** 解析当前会话并返回有效 B站 Cookie；无会话/失效返回 null */
async function getValidCookie(platform: Platform): Promise<string | null> {
  const session = await resolveSession(platform);
  if (!session) return null;
  let cookie = buildCookie(session);
  if (session.source !== "server") {
    const credResult = await ensureValidCredentialClient(platform, session);
    if (!credResult.valid) {
      console.warn("[GiftReplay-Tauri] 凭证失效且刷新失败:", credResult.reason);
      return null;
    }
    cookie = credResult.cookie;
  }
  return cookie;
}

// ==================== 业务函数 ====================

/** 获取 7 天内的全部直播场次 */
async function fetchReplayList(platform: Platform, cookie: string): Promise<ReplaySession[]> {
  const sessions: ReplaySession[] = [];
  const nowSec = Date.now() / 1000;
  const dayStartSec = nowSec - SEVEN_DAY_SEC;
  let endTime = "";
  let last = false;
  let guard = 0;

  while (!last && guard < 20) {
    guard++;
    const qs = new URLSearchParams();
    if (endTime) qs.set("end_time", endTime);
    qs.set("source", "1");
    const json = await platform.fetchBilibiliJson<ReplayListResp>({
      url: `${REPLAY_LIST_API}?${qs.toString()}`,
      cookie,
      live: true,
    });
    if (json.code !== 0) {
      console.error(`[GiftReplay-Tauri][list] API code=${json.code} message=${json.message}`);
      break;
    }
    const list = json?.data?.list ?? [];
    for (const it of list) {
      const st = Number(it.start_time);
      if (st >= dayStartSec) {
        sessions.push({
          start_time: st,
          end_time: Number(it.end_time),
          title: it.title ?? "",
          live_id: it.live_id,
          duration: Number(it.duration) || 0,
          area: it.area ?? "",
        });
      }
    }
    console.log(
      `[GiftReplay-Tauri][list] 本页 ${list.length} 条，7天内收录 ${sessions.length} 条，last=${json?.data?.last}, next_start_time=${json?.data?.next_start_time}`,
    );
    last = json?.data?.last === true;
    endTime = json?.data?.next_start_time ?? "";
    if (json?.data?.list?.length === 0) break;
  }

  return sessions;
}

/** 获取某场次的全部礼物(≥threshold 电池)，自动翻页 */
async function fetchGiftList(
  platform: Platform,
  cookie: string,
  liveId: string,
  startTime: number,
  endTime: number,
  threshold = 2000,
): Promise<RawGiftItem[]> {
  const gifts: RawGiftItem[] = [];
  let index = 0;
  let logDate = "";
  let guard = 0;

  while (guard < 500) {
    guard++;
    const qs = new URLSearchParams({
      live_key: liveId,
      start_time: String(startTime),
      end_time: String(endTime),
      type: "1",
      index: String(index),
      log_date: logDate,
      page_size: String(PAGE_SIZE),
    });
    const json = await platform.fetchBilibiliJson<GiftListResp>({
      url: `${GIFT_INFO_API}?${qs.toString()}`,
      cookie,
      live: true,
    });
    if (json.code !== 0) {
      console.error(`[GiftReplay-Tauri][gifts] API code=${json.code} message=${json.message}`);
      break;
    }
    const details = json?.data?.gift_income_details ?? [];
    for (const d of details) {
      const v = Number(d.gift_value) || 0;
      if (v >= threshold) gifts.push(d);
    }
    const nextIndex = json?.data?.next_index;
    logDate = json?.data?.log_date ?? "";
    console.log(
      `[GiftReplay-Tauri][gifts] live_id=${liveId} 第${guard}页 本页${details.length}条 ≥${threshold}收${gifts.length}条 next_index=${nextIndex} log_date="${logDate}"`,
    );
    if (nextIndex === -1 && logDate === "") break;
    if (typeof nextIndex === "number" && nextIndex !== index) {
      index = nextIndex;
    } else {
      const pagedNext = Number(nextIndex);
      if (!isNaN(pagedNext) && pagedNext > index) index = pagedNext;
      else break;
    }
  }

  return gifts;
}

/** 获取场次的 30min 片段列表 */
async function fetchBaseInfo(
  platform: Platform,
  cookie: string,
  liveId: string,
  startTime: number,
  endTime: number,
): Promise<BaseResp> {
  const qs = new URLSearchParams({
    live_key: liveId,
    start_time: String(startTime),
    end_time: String(endTime),
    source: "1",
  });
  const json = await platform.fetchBilibiliJson<BaseResp>({
    url: `${BASE_INFO_API}?${qs.toString()}`,
    cookie,
    live: true,
  });
  console.log(
    `[GiftReplay-Tauri][base] live_id=${liveId} code=${json.code} 30min片段数=${json?.data?.list?.length ?? 0}`,
  );
  return json;
}

/**
 * 获取本场直播的送礼观众排行（UserScoreRank），返回 nickname -> face 映射。
 * 礼物记录接口不提供送礼者 uid，但提供昵称；按昵称从排行中匹配头像（横幅绘制用）。
 */
async function fetchUserFaces(
  platform: Platform,
  cookie: string,
  liveId: string,
): Promise<Record<string, string>> {
  const qs = new URLSearchParams({ live_id: liveId, rank_type: "1" });
  const json = await platform.fetchBilibiliJson<UserScoreRankResp>({
    url: `${USER_SCORE_RANK_API}?${qs.toString()}`,
    cookie,
    live: true,
  });
  const map: Record<string, string> = {};
  for (const u of json?.data?.userInfos ?? []) {
    // 礼物流水只有昵称，贡献榜按昵称返回 face；用昵称作主键匹配横幅头像
    const nick = u?.nickname || u?.uname;
    if (nick && u?.face) map[nick] = u.face;
  }
  return map;
}

/**
 * 下载礼物时刻前后 20s 的 2s 片段并生成过滤后的 VOD 播放列表。
 * segs 已按绝对时间排序，winStart/winEnd 为礼物窗口 [giftTime-BEFORE, giftTime+AFTER]，
 * 跨 30min 边界时把相邻片段拼接在一起。片段完全本地化。
 * 注意：Blob URL 由父级在 clip 移除（关闭/替换）时统一吊销，ClipPlayer 不在 effect cleanup 中吊销，
 * 避免 React StrictMode 首次 cleanup 吊销后第二次 effect 引用失效（net::ERR_FILE_NOT_FOUND）。
 */
type ChunkSeg = { url: string; absStart: number };

async function buildClipPlaylist(
  platform: Platform,
  cookie: string,
  segs: ChunkSeg[],
  winStart: number,
  winEnd: number,
): Promise<{ playlist: string; blobUrls: string[] }> {
  const selected = segs.filter((s) => s.absStart + SEG_SECONDS > winStart && s.absStart < winEnd);
  console.log(
    `[GiftReplay-Tauri][clip] win=[${winStart},${winEnd}] 候选=${segs.length} 截取=${selected.length}段`,
  );

  // 并发下载 2s 片段 → Blob URL（完全本地化）
  const blobs: Blob[] = await Promise.all(
    selected.map(async (s) => {
      const buf = await platform.fetchArrayBuffer(s.url, cookie);
      return new Blob([buf], { type: "video/mp2t" });
    }),
  );
  const blobUrls = blobs.map((b) => URL.createObjectURL(b));
  console.log(`[GiftReplay-Tauri][clip] 下载完成 ${blobUrls.length} 段，转 Blob URL`);

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (const b of blobUrls) {
    lines.push("#EXTINF:2.00,");
    lines.push(b);
  }
  lines.push("#EXT-X-ENDLIST");
  lines.push("");
  return { playlist: lines.join("\n"), blobUrls };
}

/** 拉取单个 30min 片段的 m3u8，返回按绝对时间标记的片段列表 */
async function fetchClientChunkSegs(
  platform: Platform,
  cookie: string,
  chunk: { start_time: number; end_time: number; stream?: string },
): Promise<ChunkSeg[]> {
  if (!chunk.stream) return [];
  const playUrl = resolvePlayUrl(String(chunk.stream));
  const res = await platform.fetchRaw(playUrl);
  if (!res.ok) {
    console.warn(`[GiftReplay-Tauri][clip] 片段 m3u8 HTTP=${res.status} stream=${playUrl.slice(0, 120)}`);
    return [];
  }
  const text = await res.text();
  const chunkStart = Number(chunk.start_time) || 0;
  const segs: ChunkSeg[] = [];
  let i = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && /^http/i.test(t)) {
      segs.push({ url: t.replace(/\\u0026/g, "&"), absStart: chunkStart + i * SEG_SECONDS });
      i++;
    }
  }
  return segs;
}

// ==================== 主分发 ====================

export async function fetchGiftReplay(
  platform: Platform,
  action: string,
  query: URLSearchParams,
): Promise<{ code: number; message: string; data?: unknown }> {
  if (action === "seg") {
    // seg 二进制代理仅 Web 模式（服务器）使用；Tauri 本地化不经过该分支
    return { code: 400, message: "seg 客户端不处理", data: null };
  }

  const cookie = await getValidCookie(platform);
  if (!cookie) {
    console.warn("[GiftReplay-Tauri] 无有效会话");
    return NEEDS_RELOGIN;
  }

  try {
    if (action === "list") {
      const sessions = await fetchReplayList(platform, cookie);
      console.log(`[GiftReplay-Tauri][list] 7天内场次数=${sessions.length}`);
      return { code: 0, message: "ok", data: { list: sessions, now: Date.now() } };
    }

    if (action === "gifts") {
      const liveId = query.get("live_id") ?? "";
      const startTime = Number(query.get("start_time")) || 0;
      const endTime = Number(query.get("end_time")) || 0;
      const threshold = Number(query.get("threshold")) || 2000;
      const gifts = await fetchGiftList(platform, cookie, liveId, startTime, endTime, threshold);
      console.log(`[GiftReplay-Tauri][gifts] live_id=${liveId} ≥${threshold} 礼物数=${gifts.length}`);
      return { code: 0, message: "ok", data: { list: gifts } };
    }

    if (action === "user_faces") {
      const liveId = query.get("live_id") ?? "";
      if (!liveId) return { code: 0, message: "no-live-id", data: {} };
      try {
        const faces = await fetchUserFaces(platform, cookie, liveId);
        console.log(`[GiftReplay-Tauri][user_faces] live_id=${liveId} 观众数=${Object.keys(faces).length}`);
        return { code: 0, message: "ok", data: faces };
      } catch (err: unknown) {
        console.error("[GiftReplay-Tauri][user_faces] 拉取失败:", err instanceof Error ? err.message : String(err));
        return { code: 0, message: "user-faces-error", data: {} };
      }
    }

    if (action === "clips") {
      const liveId = query.get("live_id") ?? "";
      const startTime = Number(query.get("start_time")) || 0;
      const endTime = Number(query.get("end_time")) || 0;
      const giftTime = Number(query.get("gift_time")) || 0;
      console.log(`[GiftReplay-Tauri][clips] live_id=${liveId} start=${startTime} end=${endTime} gift_time=${giftTime}`);

      const baseJson = await fetchBaseInfo(platform, cookie, liveId, startTime, endTime);
      const chunks = baseJson?.data?.list ?? [];
      const curIdx = chunks.findIndex(c => Number(c.start_time) <= giftTime && giftTime < Number(c.end_time));
      const chunk = curIdx >= 0 ? chunks[curIdx] : chunks[0];
      console.log(
        `[GiftReplay-Tauri][clips] 片段数=${chunks.length} 命中idx=${curIdx} 片段=${chunk ? `${chunk.start_time}~${chunk.end_time}` : "无"}`,
      );
      if (!chunk?.stream) {
        return { code: 0, message: "no-chunk", data: { found: false, reason: "无对应录屏片段" } };
      }

      // 礼物 20s 窗口可能跨越 30min 边界，同时取前/后片段内容，避免边界处缺段。
      const winStart = giftTime - BEFORE_SECONDS;
      const winEnd = giftTime + AFTER_SECONDS;
      const needIdx = new Set<number>([curIdx >= 0 ? curIdx : 0]);
      if (curIdx > 0 && winStart < Number(chunk.start_time)) needIdx.add(curIdx - 1);
      if (curIdx >= 0 && curIdx < chunks.length - 1 && winEnd > Number(chunk.end_time)) needIdx.add(curIdx + 1);
      const allSegs: ChunkSeg[] = [];
      for (const idx of needIdx) {
        allSegs.push(...(await fetchClientChunkSegs(platform, cookie, chunks[idx])));
      }
      allSegs.sort((a, b) => a.absStart - b.absStart);
      if (allSegs.length === 0) {
        return { code: 0, message: "no-seg", data: { found: false, reason: "无短视频片段" } };
      }
      // 诊断：判断片段类型（fMP4 需 #EXT-X-MAP init segment / 需 BYTERANGE 提取）
      const firstM3u8Texts: string[] = [];
      for (const idx of needIdx) {
        const playUrl = resolvePlayUrl(String(chunks[idx].stream ?? ""));
        if (!playUrl) continue;
        try {
          const r = await platform.fetchRaw(playUrl);
          const t = await r.text();
          firstM3u8Texts.push(t);
        } catch { /* ignore */ }
      }
      const sample = firstM3u8Texts.join("\n");
      console.log(
        `[GiftReplay-Tauri][clips] 原始m3u8 含EXT-X-MAP=${sample.includes("#EXT-X-MAP")} 含EXT-X-BYTERANGE=${sample.includes("#EXT-X-BYTERANGE")}`,
      );

      const chunkStart = Number(chunk.start_time) || 0;
      const { playlist, blobUrls } = await buildClipPlaylist(platform, cookie, allSegs, winStart, winEnd);
      return {
        code: 0,
        message: "ok",
        data: { found: true, chunkStart, giftTime, playlist, blobUrls, segTotal: allSegs.length },
      };
    }

    return { code: 400, message: "unknown action", data: null };
  } catch (err: unknown) {
    console.error("[GiftReplay-Tauri] 处理失败:", err instanceof Error ? err.message : String(err));
    return { code: 500, message: `录制礼物处理失败: ${err instanceof Error ? err.message : ""}`, data: null };
  }
}