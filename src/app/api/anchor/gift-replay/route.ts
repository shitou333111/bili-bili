import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential, buildCookieHeader } from "@/lib/bilibili/cookie-refresh";

export const dynamic = "force-dynamic";

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
const SEVEN_DAY_MS = 7 * 24 * 3600 * 1000;

// ==================== 类型定义 ====================

type ReplaySession = {
  start_time: number;
  end_time: number;
  title: string;
  live_id: string;
  duration: number;
  area: string;
};

type GiftRecord = {
  nickname: string;
  gift_name: string;
  send_gift_time: number;
  gift_count: number;
  gift_value: number;
  gift_icon: string;
  uid?: number;
};

// B站 API 返回类型（仅声明用到的字段）
type ReplayListResp = {
  code: number;
  message: string;
  data?: {
    list?: Array<{ start_time: number; end_time: number; title?: string; live_id: string; duration?: number; area?: string }>;
    last?: boolean;
    next_start_time?: string;
  };
};

type RawGiftItem = {
  nickname?: string;
  gift_name?: string;
  send_gift_time?: number;
  gift_count?: number;
  gift_value?: number;
  gift_icon?: string;
  /** 送礼用户 UID（部分接口返回） */
  uid?: number;
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

// ==================== 通用请求 ====================

function buildBiliHeaders(cookie: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://live.bilibili.com/",
    "Origin": "https://live.bilibili.com",
    "Cookie": cookie,
  };
}

async function getJson<T>(url: string, cookie: string, headersExtra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { cache: "no-store", headers: { ...buildBiliHeaders(cookie), ...headersExtra } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`B站 API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ==================== 30min 片段 URL 处理 ====================

/**
 * 直接使用 GetLiveBaseInfo 返回的 stream URL 请求 m3u8。
 *
 * 说明：该接口的 sign 由 B站 在 GetLiveBaseInfo 响应时即时签发，在有效期内直接请求必然成功，
 * 无需重签。项目的现有签名模块（pay-record 用的移动端 APP 签名：参数需带 appkey + 固定 secret）
 * 与 videoPlay 接口不匹配——该 URL 不含 appkey 字段，用该 secret 计算的 sign 与 B站 返回值
 * 不一致（已验证），强行重签会得到错误 sign 导致 m3u8 HTTP 400。
 * 若未来遇到原 sign 过期，需另行研究 videoPlay 专用签名算法。
 */
function resolvePlayUrl(streamUrl: string): string {
  return streamUrl.replace(/\\u0026/g, "&");
}

// ==================== 业务函数 ====================

/** 获取 7 天内的全部直播场次 */
async function fetchReplayList(cookie: string): Promise<ReplaySession[]> {
  const sessions: ReplaySession[] = [];
  const nowSec = Date.now() / 1000; // B站时间戳为秒，统一用秒比较
  const dayStartSec = nowSec - SEVEN_DAY_MS / 1000;
  let endTime = "";
  let last = false;
  let guard = 0;

  while (!last && guard < 20) {
    guard++;
    const qs = new URLSearchParams();
    if (endTime) qs.set("end_time", endTime);
    qs.set("source", "1");
    const url = `${REPLAY_LIST_API}?${qs.toString()}`;
    const json = await getJson<ReplayListResp>(url, cookie);
    if (json.code !== 0) {
      console.error(`[GiftReplay][list] API code=${json.code} message=${json.message}`);
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
      `[GiftReplay][list] 本页 ${list.length} 条，7天内收录 ${sessions.length} 条，last=${json?.data?.last}, next_start_time=${json?.data?.next_start_time}`,
    );
    last = json?.data?.last === true;
    endTime = json?.data?.next_start_time ?? "";
    if (json?.data?.list?.length === 0) break;
  }

  return sessions;
}

/** 获取某场次的全部礼物(≥threshold 电池)，自动翻页 */
async function fetchGiftList(
  cookie: string,
  liveId: string,
  startTime: number,
  endTime: number,
  threshold = 2000,
): Promise<GiftRecord[]> {
  const gifts: GiftRecord[] = [];
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
    const url = `${GIFT_INFO_API}?${qs.toString()}`;
    const json = await getJson<GiftListResp>(url, cookie);
    if (json.code !== 0) {
      console.error(`[GiftReplay][gifts] API code=${json.code} message=${json.message}`);
      break;
    }
    const details = json?.data?.gift_income_details ?? [];
    for (const d of details) {
      const v = Number(d.gift_value) || 0;
      if (v >= threshold) {
        gifts.push({
          nickname: d.nickname ?? "",
          gift_name: d.gift_name ?? "",
          send_gift_time: Number(d.send_gift_time) || 0,
          gift_count: Number(d.gift_count) || 1,
          gift_value: v,
          gift_icon: d.gift_icon ?? "",
          uid: Number(d.uid) || undefined,
        });
      }
    }
    const nextIndex = json?.data?.next_index;
    logDate = json?.data?.log_date ?? "";
    console.log(
      `[GiftReplay][gifts] live_id=${liveId} 第${guard}页 本页${details.length}条 ≥${threshold}收${gifts.length}条 next_index=${nextIndex} log_date="${logDate}"`,
    );
    if (nextIndex === -1 && logDate === "") break;
    if (typeof nextIndex === "number" && nextIndex !== index) {
      index = nextIndex;
    } else {
      // 防止死循环
      const pagedNext = Number(nextIndex);
      if (!isNaN(pagedNext) && pagedNext > index) index = pagedNext;
      else break;
    }
  }

  return gifts;
}

/** 获取场次的 30min 片段列表 */
async function fetchBaseInfo(cookie: string, liveId: string, startTime: number, endTime: number): Promise<BaseResp> {
  const qs = new URLSearchParams({
    live_key: liveId,
    start_time: String(startTime),
    end_time: String(endTime),
    source: "1",
  });
  const url = `${BASE_INFO_API}?${qs.toString()}`;
  const json = await getJson<BaseResp>(url, cookie);
  console.log(
    `[GiftReplay][base] live_id=${liveId} code=${json.code} 30min片段数=${json?.data?.list?.length ?? 0} 首段=${json?.data?.list?.[0]?.start_time ?? "-"}~${json?.data?.list?.[0]?.end_time ?? "-"}`,
  );
  return json;
}

/**
 * 获取本场直播的送礼观众排行（UserScoreRank），返回 nickname -> face 映射。
 * 礼物记录接口不提供送礼者 uid，但提供昵称；按昵称从排行中匹配头像（横幅绘制用）。
 */
async function fetchUserFaces(cookie: string, liveId: string): Promise<Record<string, string>> {
  const url = `${USER_SCORE_RANK_API}?live_id=${encodeURIComponent(liveId)}&rank_type=1`;
  const json = await getJson<UserScoreRankResp>(url, cookie);
  const map: Record<string, string> = {};
  for (const u of json?.data?.userInfos ?? []) {
    // 礼物流水只有昵称，贡献榜按昵称返回 face；用昵称作主键匹配横幅头像
    const nick = u?.nickname || u?.uname;
    if (nick && u?.face) map[nick] = u.face;
  }
  return map;
}

/** 拉取单个 30min 片段的 m3u8，返回按绝对时间标记的片段列表 */
type ChunkSeg = { url: string; absStart: number };

async function fetchChunkSegs(
  cookie: string,
  chunk: { start_time: number; end_time: number; stream?: string },
): Promise<ChunkSeg[]> {
  if (!chunk.stream) return [];
  const playUrl = resolvePlayUrl(String(chunk.stream));
  const res = await fetch(playUrl, { cache: "no-store", headers: buildBiliHeaders("") });
  if (!res.ok) {
    console.warn(`[GiftReplay][clip] 片段 m3u8 HTTP=${res.status} stream=${playUrl.slice(0, 120)}`);
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

/** 截取礼物时刻前后 20s 的短视频，返回过滤后的 VOD 播放列表文本。
 * segs 已按绝对时间排序，winStart/winEnd 为礼物窗口 [giftTime-BEFORE, giftTime+AFTER]，
 * 跨 30min 边界时把相邻片段拼接在一起。 */
function buildClipPlaylist(segs: { url: string; absStart: number }[], winStart: number, winEnd: number, baseOrigin: string): string {
  const selected = segs.filter((s) => s.absStart + SEG_SECONDS > winStart && s.absStart < winEnd);
  console.log(
    `[GiftReplay][clip] win=[${winStart},${winEnd}] 候选=${segs.length} 截取=${selected.length}段`,
  );

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  for (const s of selected) {
    lines.push("#EXTINF:2.00,");
    lines.push(`${baseOrigin}/api/anchor/gift-replay/seg?u=${encodeURIComponent(s.url)}`);
  }
  lines.push("#EXT-X-ENDLIST");
  lines.push("");
  return lines.join("\n");
}

// ==================== GET Handler ====================

export async function GET(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";

  // seg 二进制代理不需要登录态
  if (action === "seg") {
    const u = url.searchParams.get("u") ?? "";
    if (!u) return NextResponse.json({ code: 400, message: "missing u", data: null }, { status: 400 });
    try {
      const res = await fetch(u, { cache: "force-cache" });
      if (!res.ok) {
        return NextResponse.json({ code: res.status, message: "segment fetch failed", data: null }, { status: 502 });
      }
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
          "Content-Length": String(buf.byteLength),
        },
      });
    } catch (err: unknown) {
      console.error("[GiftReplay][seg] 拉取失败:", err instanceof Error ? err.message : String(err));
      return NextResponse.json({ code: 500, message: "segment fetch error", data: null }, { status: 502 });
    }
  }

  // 以下 action 均需登录态
  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  if (!sid) sid = url.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) {
    return NextResponse.json({ code: 0, message: "needs-relogin", data: null }, { status: 200 });
  }
  const credentialResult = await ensureValidCredential(session);
  if (!credentialResult.valid) {
    return NextResponse.json({ code: 0, message: "needs-relogin", data: null }, { status: 200 });
  }
  const cookie = buildCookieHeader(session);

  try {
    if (action === "list") {
      const sessions = await fetchReplayList(cookie);
      console.log(`[GiftReplay][list] 7天内场次数=${sessions.length}`);
      return NextResponse.json({ code: 0, message: "ok", data: { list: sessions, now: Date.now() } });
    }

    if (action === "gifts") {
      const liveId = url.searchParams.get("live_id") ?? "";
      const startTime = Number(url.searchParams.get("start_time")) || 0;
      const endTime = Number(url.searchParams.get("end_time")) || 0;
      const threshold = Number(url.searchParams.get("threshold")) || 2000;
      const gifts = await fetchGiftList(cookie, liveId, startTime, endTime, threshold);
      console.log(`[GiftReplay][gifts] live_id=${liveId} ≥${threshold} 礼物数=${gifts.length}`);
      return NextResponse.json({ code: 0, message: "ok", data: { list: gifts } });
    }

    if (action === "user_faces") {
      // 本场直播送礼观众排行：通过送礼者昵称匹配 face（横幅头像用）
      const liveId = url.searchParams.get("live_id") ?? "";
      if (!liveId) {
        return NextResponse.json({ code: 0, message: "no-live-id", data: {} }, { status: 200 });
      }
      try {
        const faces = await fetchUserFaces(cookie, liveId);
        console.log(`[GiftReplay][user_faces] live_id=${liveId} 观众数=${Object.keys(faces).length}`);
        return NextResponse.json({ code: 0, message: "ok", data: faces });
      } catch (err: unknown) {
        console.error("[GiftReplay][user_faces] 拉取失败:", err instanceof Error ? err.message : String(err));
        return NextResponse.json({ code: 0, message: "user-faces-error", data: {} }, { status: 200 });
      }
    }

    if (action === "clips") {
      const liveId = url.searchParams.get("live_id") ?? "";
      const startTime = Number(url.searchParams.get("start_time")) || 0;
      const endTime = Number(url.searchParams.get("end_time")) || 0;
      const giftTime = Number(url.searchParams.get("gift_time")) || 0;
      console.log(`[GiftReplay][clips] live_id=${liveId} start=${startTime} end=${endTime} gift_time=${giftTime}`);

      const baseJson = await fetchBaseInfo(cookie, liveId, startTime, endTime);
      const chunks = baseJson?.data?.list ?? [];
      // 找到包含礼物时刻的 30min 片段
      const curIdx = chunks.findIndex(c => Number(c.start_time) <= giftTime && giftTime < Number(c.end_time));
      const chunk = curIdx >= 0 ? chunks[curIdx] : chunks[0];
      console.log(
        `[GiftReplay][clips] 片段数=${chunks.length} 命中idx=${curIdx} 片段=${chunk ? `${chunk.start_time}~${chunk.end_time}` : "无"}`,
      );
      if (!chunk?.stream) {
        return NextResponse.json(
          { code: 0, message: "no-chunk", data: { found: false, reason: "无对应录屏片段" } },
          { status: 200 },
        );
      }

      // 礼物 20s 窗口 [giftTime-BEFORE, giftTime+AFTER] 可能跨越 30min 边界，
      // 需要同时取前/后一个片段的视频内容，避免边界处缺段。
      const winStart = giftTime - BEFORE_SECONDS;
      const winEnd = giftTime + AFTER_SECONDS;
      const needIdx = new Set<number>([curIdx >= 0 ? curIdx : 0]);
      if (curIdx > 0 && winStart < Number(chunk.start_time)) needIdx.add(curIdx - 1);
      if (curIdx >= 0 && curIdx < chunks.length - 1 && winEnd > Number(chunk.end_time)) needIdx.add(curIdx + 1);
      const allSegs: ChunkSeg[] = [];
      for (const idx of needIdx) {
        allSegs.push(...(await fetchChunkSegs(cookie, chunks[idx])));
      }
      allSegs.sort((a, b) => a.absStart - b.absStart);
      if (allSegs.length === 0) {
        return NextResponse.json(
          { code: 0, message: "no-seg", data: { found: false, reason: "无短视频片段" } },
          { status: 200 },
        );
      }

      const baseOrigin = `${url.protocol}//${url.host}`;
      const filtered = buildClipPlaylist(allSegs, winStart, winEnd, baseOrigin);
      return NextResponse.json({
        code: 0,
        message: "ok",
        data: {
          found: true,
          chunkStart: Number(chunk.start_time) || 0,
          giftTime,
          playlist: filtered,
          segTotal: allSegs.length,
        },
      });
    }

    if (action === "roombg") {
      // 直播间背景图：uid → room_id（get_status_info_by_uids）→ getInfoByRoom → room_info.background
      const uid = Number(url.searchParams.get("uid")) || 0;
      if (!uid) {
        return NextResponse.json({ code: 0, message: "no-uid", data: { background: "" } }, { status: 200 });
      }
      const roomJson = await getJson<{ code: number; data?: Record<string, { room_id?: number }> }>(
        `https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=${uid}`,
        cookie,
      );
      const roomId = roomJson?.data?.[String(uid)]?.room_id || 0;
      if (!roomId) {
        console.log(`[GiftReplay][roombg] uid=${uid} 未找到直播间`);
        return NextResponse.json({ code: 0, message: "no-room", data: { background: "" } }, { status: 200 });
      }
      const infoJson = await getJson<{ code: number; data?: { room_info?: { background?: string } } }>(
        `https://app.bilibili.com/xlive/app-room/v1/index/getInfoByRoom?room_id=${roomId}`,
        cookie,
      );
      const background = infoJson?.data?.room_info?.background ?? "";
      console.log(`[GiftReplay][roombg] uid=${uid} room_id=${roomId} background=${background}`);
      return NextResponse.json({ code: 0, message: "ok", data: { room_id: roomId, background } });
    }

    return NextResponse.json({ code: 400, message: "unknown action", data: null }, { status: 400 });
  } catch (err: unknown) {
    console.error("[GiftReplay] 处理失败:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { code: 500, message: `录制礼物处理失败: ${err instanceof Error ? err.message : ""}`, data: null },
      { status: 500 },
    );
  }
}