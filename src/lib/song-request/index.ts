/**
 * 点歌听 · 弹幕编排
 *
 * 主播端监听弹幕 → 识别「点歌 歌名」（关键词可配置、必须在开头）→
 * 点歌礼物门禁 → 请求服务器解析歌单 / 跨平台搜索 → 控制本机音乐软件播放。
 *
 * 与画布模块不同，点歌听只用弹幕回复互动（即将播放 / 未匹配 / 请投喂 等）。
 */
import { sendDanmakuWithRetry } from "@/lib/barrage";
import type { DisplayConfig } from "@/lib/display/types";
import { serverFetch } from "@/lib/server-api";
import {
  platformLabel,
  type PlaybackPlatform,
  type PlaybackTarget,
  type ResolveResult,
  type SingPlatform,
  type SongRef,
} from "@/lib/sing/types";
import { hasRecentGift, notifySongRequestGift, resetGiftWaiters, waitForGift } from "./gift";
import {
  appendSongRequestLog,
  updateSongRequestLog,
  type SongRequestLogStatus,
} from "./log";
import { clearSongQueue, enqueueOrPlay } from "./queue";
import { enqueueOrPlayInApp, stopInAppPlayer } from "./inapp-player";

export { notifySongRequestGift };

/** 未匹配时通知服务器刷新歌单的全局冷却（避免刷弹幕导致频繁同步） */
const REFRESH_COOLDOWN_MS = 120_000;
/** 弹幕长度上限：尽量完整展示歌名（B 站普通上限 20 字，部分账号 30 字） */
const REPLY_LONG_MAX = 30;
/** 同曲极短去重窗口：60 秒内同一首歌只放行一次（不区分观众） */
const SONG_DEDUP_TTL_MS = 60_000;

/** 按字符（非 UTF-16 码元）截断，超出加省略号 */
function clipText(text: string, max: number): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("")}…` : chars.join("");
}

/** key = 平台 + 播放 id（回退到 id / 歌名+歌手）→ 上次受理时间 */
const recentSongs = new Map<string, number>();

const pendingGift = new Set<number>();
let lastClosedNoticeAt = 0;
let lastRefreshNoticeAt = 0;

interface ReplyItem {
  roomId: number;
  text: string;
}

const replyQueue: ReplyItem[] = [];
let replying = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 排队回复弹幕（串行 + 2.2s 间隔，避开 B 站「发送频率过快」限制） */
function reply(roomId: number, text: string): void {
  if (!roomId) return;
  const long = clipText(text, REPLY_LONG_MAX);
  if (!long) return;
  if (replyQueue.length >= 10) replyQueue.shift();
  replyQueue.push({ roomId, text: long });
  void drainReplies();
}

async function drainReplies(): Promise<void> {
  if (replying) return;
  replying = true;
  try {
    while (replyQueue.length > 0) {
      const item = replyQueue.shift()!;
      try {
        await sendDanmakuWithRetry(item.roomId, item.text);
      } catch {
        /* 回复失败不影响主流程 */
      }
      await sleep(2200);
    }
  } finally {
    replying = false;
  }
}

function songText(song: SongRef): string {
  // 歌名最多 20 个字（弹幕本身有长度上限，优先保证歌名完整）
  const name = clipText(song.name, 20);
  const artist = song.artists?.filter(Boolean).join("/") || "";
  return artist ? `${name} - ${artist}` : name;
}

/** 记录一条点歌流水（不阻塞主流程），返回本条的 ts 供后续更新状态 */
function logRequest(
  args: SongRequestDanmakuArgs,
  query: string,
  status: SongRequestLogStatus,
  extra?: {
    songName?: string;
    artists?: string[];
    platform?: PlaybackTarget;
    originPlatform?: SingPlatform;
    source?: "playlist" | "library";
    detail?: string;
  },
): number {
  const ts = Date.now();
  void appendSongRequestLog(args.mid, {
    ts,
    uid: args.uid,
    uname: args.uname || "匿名用户",
    avatar: args.avatar,
    query,
    status,
    ...extra,
  });
  return ts;
}

/** 把播放失败的原始错误翻译成尽量准确的弹幕文案（B 站单条 20 字限制） */
function playFailureText(error: string, platform: PlaybackTarget): string {
  const err = (error || "").trim();
  const lower = err.toLowerCase();
  if (platform === "inapp") {
    if (lower.includes("autoplay")) return "浏览器拦截了播放，请点一下页面";
    if (lower.includes("service_unavailable")) return "服务器音乐服务未就绪";
    if (/stream_unavailable|audio_load_failed|音频源|decode|not supported/.test(lower)) {
      return "这首歌暂时播不了";
    }
    if (lower.includes("网络")) return "网络中断，播放下首";
    return err ? `播放失败：${err.slice(0, 10)}` : "软件内播放失败";
  }
  if (/未找到.*qqmusic|qqmusic\.exe/.test(lower)) return "没找到QQ音乐，请先安装";
  if (lower.includes("qq") && (lower.includes("songid") || err.includes("十进制"))) {
    return "QQ音乐播放失败，请重试";
  }
  if (/未检测到.*汽水|luna/.test(err)) return "没找到汽水音乐，请先安装";
  if (/未检测到|未安装|协议未注册/.test(err)) return "没找到网易云，请先安装";
  if (lower.includes("soda") || err.includes("汽水")) return "汽水音乐没响应，请先打开汽水";
  if (lower.includes("kugou") || err.includes("酷狗")) return "酷狗启动失败，请手动打开";
  if (lower.includes("netease") || lower.includes("orpheus") || err.includes("网易云")) {
    return "网易云没响应，请先打开网易云";
  }
  if (/music worker|worker|powershell/.test(lower)) return "音乐控制进程异常，请重启软件";
  if (/invoke|tauri|__tauri|not defined|not a function/.test(lower)) {
    return "请在Windows客户端使用点歌听";
  }
  if (/not allowed|unknown command|command .*not found|not found/.test(lower)) {
    return "点歌功能未启用，请重启客户端";
  }
  if (!err) return `播放失败（${platformLabel(platform)}）`;
  return `播放失败：${err.slice(0, 12)}`;
}

export interface SongRequestDanmakuArgs {
  mid: number;
  roomId: number;
  config: DisplayConfig;
  uid: number;
  uname: string;
  /** 点歌用户头像 */
  avatar?: string;
  content: string;
}

/**
 * 处理一条弹幕：命中点歌关键词时串起整个点歌流程。
 * 该函数自行吞掉异常，可直接 void 调用。
 */
export async function handleSongRequestDanmaku(args: SongRequestDanmakuArgs): Promise<void> {
  const { mid, roomId, config, uid, uname, content } = args;
  const cfg = config.songRequest;
  if (!cfg || !roomId || !uid) return;

  const keyword = (cfg.keyword || "点歌").trim();
  if (!keyword) return;
  const text = content.trim();
  if (!text.toLowerCase().startsWith(keyword.toLowerCase())) return;

  // 关键词之后的查询词：空格可有可无，容忍常见分隔符
  let query = text.slice(keyword.length).trim();
  query = query.replace(/^[：:\-—,，、。.]+/, "").trim();

  if (!cfg.enabled) {
    // 未开启点歌听：低频提示一次，避免刷屏
    if (Date.now() - lastClosedNoticeAt > 300_000) {
      lastClosedNoticeAt = Date.now();
      reply(roomId, "主播还没开启点歌听哦");
    }
    return;
  }

  if (!query) {
    reply(roomId, "格式：点歌 歌名");
    return;
  }

  const platform: PlaybackTarget = cfg.platform || "netease";
  /** 软件内播放：由服务器取流，与「控制本机音乐软件」是两种独立流程 */
  const isInApp = platform === "inapp";

  // 点歌礼物门禁：点歌前 60 秒内送过指定礼物直接放行，否则等待最多 60 秒
  if (cfg.giftId > 0) {
    const recent = await hasRecentGift(mid, uid, cfg.giftId);
    if (!recent) {
      if (pendingGift.has(uid)) return; // 已在等待投喂，忽略重复点歌
      pendingGift.add(uid);
      // 收到点歌请求先提示投喂窗口，再进入等待；1 分钟内投喂成功会自动继续点歌并回复结果
      reply(roomId, `在1分钟内投喂${cfg.giftName || "指定礼物"}完成点歌`);
      const got = await waitForGift(mid, uid, cfg.giftId);
      pendingGift.delete(uid);
      if (!got) {
        logRequest(args, query, "gift_required", {
          platform,
          detail: `未送出${cfg.giftName || "点歌礼物"}`,
        });
        return;
      }
    }
  }

  const requestResolve = async () => {
    try {
      return await serverFetch<{ code: number; message?: string; data: ResolveResult }>(
        "/api/sing/resolve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            anchorUid: String(mid),
            uid: String(uid),
            keyword: query,
            platform,
          }),
        },
        60_000,
      );
    } catch (e: any) {
      console.warn("[点歌听]解析请求失败", e?.message || e);
      return null;
    }
  };

  const res = await requestResolve();
  let data = res?.data;
  if (!res || res.code !== 0 || !data) {
    logRequest(args, query, "unavailable", { platform, detail: res?.message || "解析请求失败" });
    reply(roomId, "服务暂时不可用，请稍后再试");
    return;
  }

  // 歌单里没匹配到：可能是粉丝刚在音乐平台更新了歌单，而服务器还没同步。
  // 先静默刷新歌单，再重试一次解析；刷新属于中间过程，不向观众输出，
  // 最终仍以「是否点到歌」给出和其他情况一致的结论。
  if (
    data.status === "unmatched" &&
    data.message === "no_match" &&
    Date.now() - lastRefreshNoticeAt > REFRESH_COOLDOWN_MS
  ) {
    lastRefreshNoticeAt = Date.now();
    try {
      await serverFetch(
        "/api/sing/refresh",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: String(uid) }),
        },
        120_000,
      );
    } catch {
      /* 刷新失败就按原结果继续处理 */
    }
    const again = await requestResolve();
    if (again?.code === 0 && again.data) data = again.data;
  }

  const hitSong = data.song;
  const hitInfo = hitSong
    ? {
        songName: hitSong.name,
        artists: hitSong.artists,
        // 软件内播放的日志按实际播放平台记录（可能是换源后的平台）
        ...(isInApp ? { platform: hitSong.platform as PlaybackPlatform } : { platform }),
        originPlatform: data.originPlatform,
        // 区分「命中歌单」与「网络乐库搜索」，弹幕和点歌记录里都要标记
        source: data.via === "search" ? ("library" as const) : data.via ? ("playlist" as const) : undefined,
      }
    : { ...(isInApp ? {} : { platform }) };
  /** 弹幕文案里的来源标记 + 换源/试听说明，合并进同一个括号，避免占用字数 */
  const notes = [
    data.via === "search" ? "乐库" : data.via ? "歌单" : "",
    data.switched ? `换源${platformLabel(hitSong?.platform || platform)}` : "",
    data.preview ? "仅试听" : "",
  ].filter(Boolean);
  const noteText = notes.length ? `（${notes.join(" ")}）` : "";

  switch (data.status) {
    case "ok": {
      if (!hitSong) {
        logRequest(args, query, "unmatched", { platform, detail: "没有找到这首歌" });
        reply(roomId, "没有找到这首歌");
        return;
      }
      // 同曲极短去重：60 秒内同一首歌（不区分观众）只受理一次，避免连点/刷屏重复排队
      const songKey = `${isInApp ? hitSong.platform : platform}:${
        hitSong.playId || hitSong.id || `${hitSong.name}|${hitSong.artists.join("/")}`
      }`;
      const nowTs = Date.now();
      for (const [key, at] of recentSongs) {
        if (nowTs - at > SONG_DEDUP_TTL_MS) recentSongs.delete(key);
      }
      const lastTs = recentSongs.get(songKey);
      if (lastTs != null && nowTs - lastTs < SONG_DEDUP_TTL_MS) {
        reply(roomId, "这首歌刚点过，稍后再点吧");
        return;
      }
      recentSongs.set(songKey, nowTs);

      // 本次点歌的记录 ts：排队后真正开播/结束时据此更新状态（排队 → 播放中 → 已播放）
      let logTs = 0;
      // 极小概率：当前歌在请求处理途中就结束了，回调会先于记录落库触发 → 先缓存，落库后补写
      let pendingStatus: "playing" | "played" | "failed" | null = null;
      let pendingError = "";
      const markStatus = (status: "playing" | "played" | "failed", detail?: string) => {
        if (logTs) {
          void updateSongRequestLog(args.mid, logTs, { status, detail });
          return;
        }
        pendingStatus = status;
        pendingError = detail || "";
      };
      const outcome = isInApp
        ? await enqueueOrPlayInApp(
            hitSong,
            String(uid),
            (error) => markStatus("failed", error || "播放失败"),
            {
              onStarted: () => markStatus("playing"),
              onFinished: () => markStatus("played"),
            },
          )
        : await enqueueOrPlay(
            hitSong,
            platform,
            String(uid),
            (error) => markStatus("failed", error || "播放失败"),
            {
              onStarted: () => markStatus("playing"),
              onFinished: () => markStatus("played"),
            },
          );
      if (outcome.mode === "failed") {
        recentSongs.delete(songKey); // 播放失败允许立即重试，不被去重挡住
        logRequest(args, query, "failed", {
          ...hitInfo,
          detail: outcome.error || "播放失败",
        });
        reply(roomId, playFailureText(outcome.error, platform));
        return;
      }
      if (outcome.mode === "duplicate") {
        // 同一首歌已在播放 / 已在队列：不重复排队，也不新增点歌记录
        reply(
          roomId,
          outcome.where === "playing"
            ? "这首歌正在播放哦"
            : `这首歌已排在第${outcome.position}首`,
        );
        return;
      }
      if (outcome.mode === "queued") {
        logTs = logRequest(args, query, "queued", {
          ...hitInfo,
          detail: `排队第${outcome.position}首`,
        });
        if (pendingStatus) {
          void updateSongRequestLog(args.mid, logTs, {
            status: pendingStatus,
            detail: pendingError || undefined,
          });
        }
        reply(roomId, `已排到第${outcome.position}首：${songText(hitSong)}${noteText}`);
        return;
      }
      const playDetail = data.switched
        ? `已换源到${platformLabel(hitSong.platform)}`
        : data.preview
          ? "仅试听片段"
          : undefined;
      logTs = logRequest(args, query, "playing", { ...hitInfo, detail: playDetail });
      if (pendingStatus) {
        void updateSongRequestLog(args.mid, logTs, {
          status: pendingStatus,
          detail: pendingError || undefined,
        });
      }
      // 来源、换源、试听都合并进一个括号，例如：（乐库 换源QQ音乐 仅试听）
      reply(roomId, `即将播放：${songText(hitSong)}${noteText}`);
      return;
    }
    case "unmatched": {
      if (data.message === "search_unavailable") {
        // 目标平台整站无法搜索（典型：汽水搜索依赖官方客户端签名器，服务器上没有）
        logRequest(args, query, "unmatched", {
          platform,
          detail: `${platformLabel(platform)}无法搜索`,
        });
        reply(
          roomId,
          platform === "soda"
            ? "主播是汽水音乐，无法搜索，只限点歌单内歌曲"
            : `${platformLabel(platform)}无法搜索`,
        );
        return;
      }
      if (data.message === "cross_platform_failed") {
        logRequest(args, query, "unmatched", {
          ...hitInfo,
          detail: `在${platformLabel(platform)}未找到`,
        });
        reply(roomId, `《${data.matchedName || query}》在${platformLabel(platform)}里没找到`);
        return;
      }
      if (data.message === "search_no_match") {
        logRequest(args, query, "unmatched", { platform, detail: "平台未搜索到" });
        reply(roomId, `${platformLabel(platform)}没搜到「${query}」，换个歌名试试`);
        return;
      }
      if (data.message === "stream_unavailable") {
        // 软件内播放：原平台与所有换源平台都取不到音频
        logRequest(args, query, "unmatched", { ...hitInfo, detail: "无可播音源" });
        reply(roomId, `《${data.matchedName || query}》暂时没有可播的音源`);
        return;
      }
      // 歌单里没匹配到：可能是用户在音乐平台更新了歌单而服务器未同步 → 通知服务器刷新
      if (data.message === "no_match") {
        logRequest(args, query, "unmatched", { platform, detail: "歌单未匹配" });
        reply(roomId, `没有找到「${query}」`);
        return;
      }
      logRequest(args, query, "unmatched", { platform, detail: data.message || "未匹配" });
      reply(roomId, `没有找到「${query}」`);
      return;
    }
    case "no_list": {
      if (data.message === "anchor_no_list") {
        logRequest(args, query, "no_list", { platform, detail: "主播未设置歌单" });
        reply(roomId, "主播还没设置自己的歌单");
        return;
      }
      logRequest(args, query, "no_list", { platform, detail: "用户未设置歌单" });
      reply(roomId, "你还没有设置歌单，先去点歌页导入吧");
      return;
    }
    case "service_unavailable": {
      logRequest(args, query, "unavailable", {
        platform,
        detail: isInApp ? "音乐服务未启动" : "缺少音乐解析服务",
      });
      reply(roomId, isInApp ? "软件内播放服务未就绪，请联系主播" : "服务未就绪（缺少音乐解析服务）");
      return;
    }
    default: {
      logRequest(args, query, "unavailable", { platform, detail: data.status });
      reply(roomId, "播放失败，请稍后再试");
    }
  }
}

/** 停止监听时清空队列 / 取消等待 / 清冷却 */
export function resetSongRequest(): void {
  clearSongQueue();
  stopInAppPlayer();
  resetGiftWaiters();
  pendingGift.clear();
  recentSongs.clear();
  replyQueue.length = 0;
}
