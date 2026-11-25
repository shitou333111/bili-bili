/**
 * 点歌机 · 应用内播放队列
 *
 * 通过 Tauri 命令 music_state / music_play 控制本机音乐软件：
 * - 当前没有歌曲在播放 → 立即播放（replace）；
 * - 正在播放且播放器支持插播（网易云 CDP 模式）→ 直接插到客户端自己的
 *   「下一首播放」：不打断当前曲，播完继续主播原来的播放列表，零割裂；
 * - 否则 → 进入队列，等当前歌曲「快要结束」时提前发起下一首，
 *   避免等播放器自己切到下一首（往往是无关的推荐歌）后再替换，造成先换错歌、
 *   再切回来的 2 秒割裂感。
 *
 * 结束判定优先级：
 * 1. 播放器给出真实进度（QQ / 酷狗 / 网易云 CDP）→ 剩余时长 ≤ 提前量时切歌；
 * 2. 只有已知时长（网易云未开 CDP 时 SMTC 不给进度）→ 提前 3 秒用「开始播放时间 + 时长」倒推；
 * 3. 都没有 → 退化为「标题变化」判定（会有一次播放器自动切歌的间隙）。
 */
import type { PlaybackPlatform, SongRef } from "@/lib/sing/types";
import { diceSimilarity, fold, normalizeArtist, normalizeTitle } from "@/lib/sing/normalize";
import { isTauri } from "@/lib/server-api";

interface MusicState {
  ok?: boolean;
  platform?: string;
  playing?: boolean;
  status?: string;
  title?: string;
  artist?: string;
  position?: number;
  duration?: number;
  /**
   * 播放器推算出的本曲真实开始时刻（epoch ms）。
   * 目前只有汽水提供：它的 SMTC Position 不刷新，但可以用 LastUpdatedTime 反推。
   */
  startedAt?: number;
  /** 播放器内部曲目 id（网易云 CDP 才有，用来精确判断「轮到谁了」） */
  id?: string;
  /** 播放器队列里的「下一首」id（网易云 CDP 才有） */
  nextId?: string;
  /** 是否支持「插到下一首播放」 */
  insertNext?: boolean;
  source?: string;
  error?: string;
}

interface QueueEntry {
  song: SongRef;
  platform: PlaybackPlatform;
  requestedBy: string;
  /** 轮到该首播放但失败时的回调（用于记录失败流水） */
  onFailed?: (error: string) => void;
  /** 轮到该首真正开始播放时回调（用于把记录状态改为「播放中」） */
  onStarted?: () => void;
  /** 该首播放结束（被下一首顶替）时回调（用于把记录状态改为「已播放」） */
  onFinished?: () => void;
  /** 入队时间（用于没有时长信息时的兜底接管） */
  queuedAt: number;
  /** 已插到播放器自己的「下一首」（此时无需我们的倒计时兜底） */
  inserted?: boolean;
  /** 插播生效时刻（客户端有延迟，判重前要留宽限） */
  insertedAt?: number;
  /** 插播尝试次数（反复被挤掉时放弃） */
  insertTries?: number;
}

/** 当前正在播放（由本模块发起）的歌曲状态 */
interface CurrentTrack {
  song: SongRef;
  platform: PlaybackPlatform;
  /** 计时起点：播放器标题确认切到本首时刷新，未确认则用发出播放指令的时间 */
  startedAt: number;
  /** 歌曲时长（秒，0 = 未知） */
  duration: number;
  /** SMTC 标题是否已确认切到本首 */
  confirmed: boolean;
  /** 暂停开始时间（恢复时把暂停时长补回 startedAt） */
  pauseStartedAt: number | null;
  /** 本首播放结束时回调（点歌记录状态流转用） */
  onFinished?: () => void;
}

export type PlayOutcome =
  | { mode: "play" }
  | { mode: "queued"; position: number; currentTitle?: string }
  | { mode: "failed"; error: string }
  /** 队列 / 当前曲目里已有同一首歌（不再重复入队） */
  | { mode: "duplicate"; where: "playing" | "queued"; position: number };

/** 比较用的歌名：只统一大小写与标点，保留 Live / 伴奏等版本词（版本不同算不同歌） */
function songNameKey(name: string): string {
  return fold(name).replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 判断两首歌是否同一首。
 *
 * 跨平台转换（歌单在 A 平台、本机放 B 平台）时，同一首歌经不同请求/不同解析路径
 * 可能拿到不同的平台 id（例如搜索排序变化、不同条目指向同一曲目），
 * 只按 id 去重会漏判 → 队列里出现两首相同的歌。这里再加一层
 * 「归一化歌名 + 歌手」判断兜底。
 */
export function isSameSong(a: SongRef, b: SongRef): boolean {
  if (a.platform !== b.platform) return false;
  const aid = a.playId || a.id;
  const bid = b.playId || b.id;
  if (aid && bid && aid === bid) return true;
  const an = songNameKey(a.name);
  const bn = songNameKey(b.name);
  if (!an || an !== bn) return false;
  const artistsOf = (s: SongRef) =>
    s.artists.map(normalizeArtist).filter(Boolean).sort().join("/");
  const aa = artistsOf(a);
  const ba = artistsOf(b);
  if (!aa || !ba) return true; // 一方没有歌手信息时，仅凭同名视为同一首
  return aa === ba;
}

/**
 * 各平台提前多久发起下一首（当前曲还剩多少毫秒就下发播放指令）。
 * 用途是抵消「指令下发 → 客户端真正切歌」的延迟，让点的歌卡在旧歌结束的瞬间开始。
 * 统一取 2.5 秒：汽水 luna:// 实测切换约 2.3 秒，其余平台按同一阈值留足余量，
 * 宁可最后 2 秒左右被截掉，也不要在播放器自己跳了无关歌之后再切回来。
 */
const HANDOFF_LEAD_MS: Record<PlaybackPlatform, number> = {
  netease: 2500,
  qq: 2500,
  kugou: 2500,
  soda: 2500,
};
/** 插播模式下检查「是否轮到我们的歌」的轮询间隔 */
const INSERT_POLL_MS = 800;
/** 插播被挤掉后最多重插的次数（超过就交回倒计时兜底） */
const INSERT_MAX_TRIES = 3;
/** 插播后客户端生效的宽限期（过早判重会误判断） */
const INSERT_SETTLE_MS = 3000;
/** 临近切歌时的最小轮询间隔 */
const POLL_FAST_MS = 200;
/** 无已知时长时的轮询间隔 */
const POLL_IDLE_MS = 500;
/** 轮询间隔上限（即使估算还有很久也定期校准，防止时长不准时错过切歌时机） */
const POLL_MAX_MS = 1000;
/** 持续「无播放」多久判定为已停止（避免刚发出播放指令时应用还在加载被误判） */
const IDLE_CONFIRM_MS = 4000;
/** 刚发出播放指令后的宽限期 */
const PLAY_GRACE_MS = 8000;
/** 标题与本首歌名的相似度 ≥ 该值视为「已切到本首」 */
const TITLE_CONFIRM_SIM = 0.6;
/** 标题与本首歌名的相似度 < 该值视为「已经换歌」 */
const TITLE_CHANGE_SIM = 0.5;
/**
 * 播放器既给不出进度、也给不出时长（如网易云播放条结构变化）时的兜底等待上限。
 * 超过后即使没检测到切歌也强制接管，避免点歌永远停在「排队中」。
 */
const UNKNOWN_REMAIN_WAIT_MS = 5 * 60_000;
/** 确认播放后多久内不做「标题变化」判定（避免启动瞬间误判） */
const TITLE_CHANGE_GRACE_MS = 3000;
/**
 * 标题变化需持续这么久才认作「主播切歌」，避免播放器瞬时抖动/加载中被误判。
 * 这个值是「兜底路径」的主要延迟来源（播放器自己跳歌后才靠标题变化发现），
 * 因此压到 500ms，配合更快轮询把感知延迟从约 3 秒降到 1 秒左右。
 */
const TITLE_CHANGE_SETTLE_MS = 500;

let queue: QueueEntry[] = [];
let current: CurrentTrack | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let idleSince: number | null = null;
/** 待确认的「主播切歌」：标题首次变化的时间，持续 TITLE_CHANGE_SETTLE_MS 不变才接管 */
let pendingTitleChange: { title: string; at: number } | null = null;

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** 读取音乐软件当前状态（失败时返回 ok=false，不抛错） */
export async function getMusicState(platform: PlaybackPlatform): Promise<MusicState> {
  try {
    return await invokeCmd<MusicState>("music_state", { platform });
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 插播下一首能力探测结果 */
export interface InsertSupport {
  /** 是否运行在桌面客户端 */
  native: boolean;
  /** 能否插到客户端「下一首播放」（客户端以调试端口启动时才有） */
  ready: boolean;
  error?: string;
}

/**
 * 探测网易云「插播下一首」是否可用。
 *
 * CDP 调试端口只能由客户端启动参数开启（见桌面快捷方式），所以每次软件启动时
 * 检查一遍：未就绪时界面提示改用带端口的快捷方式，避免主播误以为插播可用。
 */
export async function probeInsertSupport(): Promise<InsertSupport> {
  if (!isTauri()) return { native: false, ready: false };
  const st = await getMusicState("netease");
  return {
    native: true,
    ready: !!st.insertNext,
    error: st.ok === false ? st.error : undefined,
  };
}

/**
 * 带调试端口重启网易云（会中断当前播放）。
 * 端口已开时后端直接返回已就绪，不会白白重启。
 */
export async function restartNetease(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await invokeCmd<any>("music_restart", { platform: "netease" });
    if (res?.ok === false) return { ok: false, error: String(res?.error || "重启失败") };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function playNow(
  song: SongRef,
  platform: PlaybackPlatform,
  onFinished?: () => void,
): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await invokeCmd<any>("music_play", {
      platform,
      songId: song.playId || song.id,
      mode: "replace",
    });
    if (res?.ok === false) return { ok: false, error: String(res?.error || "播放失败") };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
  const duration = Number(song.duration);
  current = {
    song,
    platform,
    startedAt: Date.now(),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    confirmed: false,
    pauseStartedAt: null,
    onFinished,
  };
  idleSince = null;
  pendingTitleChange = null;
  return { ok: true, error: "" };
}

/**
 * 把歌插到播放器自己的「下一首播放」（不打断当前曲）。
 * 目前只有网易云 + 已开启 CDP 调试端口时可用，失败返回 false 交给倒计时兜底。
 */
async function insertNextNow(entry: QueueEntry): Promise<boolean> {
  if (entry.platform !== "netease") return false;
  try {
    const res = await invokeCmd<any>("music_play", {
      platform: entry.platform,
      songId: entry.song.playId || entry.song.id,
      mode: "next",
    });
    if (res?.ok === false) {
      console.warn("[点歌机]插播下一首失败", entry.song.name, res?.error);
      return false;
    }
  } catch (e: any) {
    console.warn("[点歌机]插播下一首异常", entry.song.name, e?.message || e);
    return false;
  }
  entry.inserted = true;
  entry.insertedAt = Date.now();
  entry.insertTries = (entry.insertTries || 0) + 1;
  return true;
}

/**
 * 校正 current 与真实播放状态：
 * 上次播放的歌早已结束、主播又自己放了别的歌时，若直接按旧记录倒推，
 * 剩余时长会是个很大的负数，导致新点的歌立刻打断主播正在放的歌。
 */
function reconcileCurrent(st: MusicState, platform: PlaybackPlatform): void {
  const cur = current;
  if (!cur || cur.platform !== platform) return;
  if (!st.playing) return;
  const title = (st.title || "").trim();
  if (!title || !cur.song.name) return;
  if (diceSimilarity(normalizeTitle(title), normalizeTitle(cur.song.name)) >= TITLE_CONFIRM_SIM) return;
  const pos = Number(st.position) || 0;
  const dur = Number(st.duration) || 0;
  const artist = st.artist ? String(st.artist) : "";
  // 上一首（点的歌）已经结束、主播自己换了歌 → 把它标记为「已播放」
  try {
    cur.onFinished?.();
  } catch {
    /* 记录更新不影响队列 */
  }
  current = {
    song: {
      platform,
      id: "",
      name: title,
      artists: artist ? [artist] : [],
    },
    platform,
    // 有真实进度/真实开始时刻就倒推开始时刻，可继续用「时长倒计时」精准接歌
    startedAt:
      Number(st.startedAt) > 0
        ? Number(st.startedAt)
        : pos > 0
          ? Date.now() - pos * 1000
          : Date.now(),
    duration: dur > 0 ? dur : 0,
    confirmed: true,
    pauseStartedAt: null,
  };
}

/** 播放/入队串行化：避免多条弹幕同时进来时都判定「没在播」→ 重复下发播放指令 */
let enqueueChain: Promise<unknown> = Promise.resolve();
let playChain: Promise<unknown> = Promise.resolve();

/** 播放或加入队列（并发调用会自动排队，不会重复添加同一首） */
export function enqueueOrPlay(
  song: SongRef,
  platform: PlaybackPlatform,
  requestedBy: string,
  onFailed?: (error: string) => void,
  hooks?: { onStarted?: () => void; onFinished?: () => void },
): Promise<PlayOutcome> {
  const run = enqueueChain.then(() =>
    doEnqueueOrPlay(song, platform, requestedBy, onFailed, hooks),
  );
  enqueueChain = run.catch(() => undefined);
  return run;
}

function doPlayNow(
  song: SongRef,
  platform: PlaybackPlatform,
  onFinished?: () => void,
): Promise<{ ok: boolean; error: string }> {
  const run = playChain.then(() => playNow(song, platform, onFinished));
  playChain = run.catch(() => undefined);
  return run;
}

async function doEnqueueOrPlay(
  song: SongRef,
  platform: PlaybackPlatform,
  requestedBy: string,
  onFailed?: (error: string) => void,
  hooks?: { onStarted?: () => void; onFinished?: () => void },
): Promise<PlayOutcome> {
  const st = await getMusicState(platform);
  const statusStr = String(st.status || "");
  const playing = !!st.playing && statusStr !== "Stopped";
  // 暂停 ≠ 停止：暂停时客户端仍持有当前曲和播放列表，点歌应排队等主播，
  // 不能当成「没在播」直接顶掉（主播需要掌控播放/切歌的主动权）。
  const paused = statusStr === "Paused";

  // 已在队列里的歌不再重复入队（跨平台转换时同一曲目可能拿到不同 id，需按歌名兜底）。
  // 放在「立即播放」分支之前：播放器已停止但队列仍有这首歌时，直接播会让同一首歌播两遍。
  const dupIndex = queue.findIndex((e) => isSameSong(e.song, song));
  if (dupIndex >= 0) {
    return { mode: "duplicate", where: "queued", position: dupIndex + 1 };
  }

  if (!playing && !paused) {
    const r = await doPlayNow(song, platform, hooks?.onFinished);
    if (!r.ok) return { mode: "failed", error: r.error };
    // 立即播放也要盯着它结束，点歌记录才能从「播放中」变成「已播放」
    if (hooks?.onFinished) ensurePoll();
    return { mode: "play" };
  }
  reconcileCurrent(st, platform);

  // 同一首歌正在播放：不再排进队列
  if (current && isSameSong(current.song, song)) {
    return { mode: "duplicate", where: "playing", position: 1 };
  }

  const entry: QueueEntry = {
    song,
    platform,
    requestedBy,
    onFailed,
    onStarted: hooks?.onStarted,
    onFinished: hooks?.onFinished,
    queuedAt: Date.now(),
  };
  queue.push(entry);
  // 网易云 CDP 模式：直接插到客户端的「下一首播放」——不打断当前曲，
  // 播完继续主播原来的播放列表。一次只插队头，后面的等前一首真正开播再插。
  if (st.insertNext && platform === "netease") {
    if (queue[0] === entry) await insertNextNow(entry);
    ensurePoll();
    const currentTitle =
      st.title && st.title.trim() ? st.title.trim() : st.artist ? String(st.artist) : undefined;
    return { mode: "queued", position: queue.length, currentTitle };
  }
  // 队列里的歌不打断正在播放的歌；等它接近结束时提前接上
  ensurePoll();
  const currentTitle =
    st.title && st.title.trim() ? st.title.trim() : st.artist ? String(st.artist) : undefined;
  return { mode: "queued", position: queue.length, currentTitle };
}

/** 按时长估算下一次轮询时机：正好在「剩余时长 ≈ 提前量」附近醒来 */
function nextDelay(): number {
  // 插播模式不需要掐时间：只需定期确认「轮到我们的歌了没有」
  if (queue[0]?.inserted) return INSERT_POLL_MS;
  // 已发现标题变化、正在等它稳定：用最短间隔轮询，尽快完成接管
  if (pendingTitleChange) return POLL_FAST_MS;
  const cur = current;
  if (cur && cur.pauseStartedAt != null) return POLL_IDLE_MS; // 暂停中：慢速轮询，且不切歌
  if (cur && cur.duration > 0) {
    const remain = cur.startedAt + cur.duration * 1000 - Date.now();
    const lead = HANDOFF_LEAD_MS[cur.platform] ?? 450;
    return Math.min(POLL_MAX_MS, Math.max(POLL_FAST_MS, remain - lead + 50));
  }
  return POLL_IDLE_MS;
}

function ensurePoll(): void {
  if (pollTimer) return;
  pollTimer = setTimeout(() => void poll(), nextDelay());
}

function scheduleNext(): void {
  // 队列空了但刚点的歌还在播（带 onFinished）→ 继续低频轮询，及时把它标记为「已播放」
  if (queue.length === 0 && !current?.onFinished) return;
  if (pollTimer) return;
  pollTimer = setTimeout(() => void poll(), nextDelay());
}

async function poll(): Promise<void> {
  pollTimer = null;
  if (queue.length === 0 && !current?.onFinished) return;
  const head = queue[0];
  if (head?.inserted) {
    try {
      await pollInserted(head);
    } catch (e: any) {
      console.warn("[点歌机]插播轮询异常", e?.message || e);
    }
    // 插播仍有效 → 等播放器自己切到这首；已失效 → 立刻走下面的兜底切歌逻辑
    if (head.inserted) {
      scheduleNext();
      return;
    }
  }
  try {
    const platform = head?.platform ?? current!.platform;
    const st = await getMusicState(platform);
    if (!st.ok) {
      scheduleNext();
      return;
    }

    const playing = !!st.playing && st.status !== "Stopped";
    const title = (st.title || "").trim();
    const artist = st.artist ? String(st.artist) : "";
    let cur = current;

    // 队列非空但当前曲不是本模块发起的（主播自己放的歌），或记录还停留在别的平台
    //（先点过 QQ/网易云、再来酷狗点歌）→ 以当前播放器状态重新接管。
    // 否则 mine=false 会让下面的逻辑直接 return，队列永远卡住、主播切歌也不会接管。
    if (playing && (!cur || cur.platform !== platform)) {
      const posState0 = Number(st.position) || 0;
      const durState0 = Number(st.duration) || 0;
      cur = current = {
        song: {
          platform,
          id: "",
          name: title || artist,
          artists: artist ? [artist] : [],
        },
        platform,
        // 有真实进度/真实开始时刻就倒推开始时刻，可继续用「时长倒计时」精准接歌
        startedAt:
          Number(st.startedAt) > 0
            ? Number(st.startedAt)
            : posState0 > 0
              ? Date.now() - posState0 * 1000
              : Date.now(),
        duration: durState0 > 0 ? durState0 : 0,
        confirmed: true,
        pauseStartedAt: null,
      };
    }

    const mine = !!cur && cur.platform === platform;

    // 接管时可能没拿到标题（刚好在切歌、加载中），后续补齐；
    // 否则 name 为空会让下面的「标题变化」判定永远失效。
    if (cur && mine && !cur.song.name && title) cur.song.name = title;

    // 播放器标题切到本首后，用该时刻作为计时起点（越早确认，倒推越准）
    if (cur && mine && !cur.confirmed && playing && title && cur.song.name) {
      if (diceSimilarity(normalizeTitle(title), normalizeTitle(cur.song.name)) >= TITLE_CONFIRM_SIM) {
        cur.confirmed = true;
        // 播放器能给出真实开始时刻时优先用它（汽水的 SMTC Position 不刷新）
        const realStart = Number(st.startedAt) || 0;
        cur.startedAt = realStart > 0 ? realStart : Date.now();
      }
    }

    // 暂停计时：恢复播放时把暂停时长补回起点，避免提前切歌
    if (cur && mine) {
      if (!playing && cur.pauseStartedAt == null) cur.pauseStartedAt = Date.now();
      else if (playing && cur.pauseStartedAt != null) {
        cur.startedAt += Date.now() - cur.pauseStartedAt;
        cur.pauseStartedAt = null;
      }
    }

    // 播放器给出的真实开始时刻与本地计时偏差过大（指令下发到真正开播的延迟、
    // 或主播在客户端里拖动进度）→ 以播放器为准，避免倒计时整体偏早/偏晚
    if (cur && mine && cur.confirmed && playing && cur.pauseStartedAt == null) {
      const realStart = Number(st.startedAt) || 0;
      if (realStart > 0 && Math.abs(realStart - cur.startedAt) > 3000) cur.startedAt = realStart;
    }

    if (playing) idleSince = null;
    else if (idleSince == null) idleSince = Date.now();

    // 结束判定
    const posState = Number(st.position) || 0;
    const durState = Number(st.duration) || 0;
    const realRemain = posState > 0 && durState > 0 ? (durState - posState) * 1000 : null;
    const estRemain =
      cur && cur.duration > 0 ? cur.startedAt + cur.duration * 1000 - Date.now() : null;
    const remain = realRemain ?? estRemain;
    const lead = HANDOFF_LEAD_MS[platform] ?? 450;

    // 刚开播的几秒内不判「快结束」：切歌瞬间进度条可能还停留在上一首的位置，
    // 否则会把刚开始播放的歌立刻标记成「已播放」
    const justStarted = !!cur && Date.now() - cur.startedAt < TITLE_CHANGE_GRACE_MS;
    const nearEnd = playing && !justStarted && remain != null && remain <= lead;
    // 主播主动暂停：只保留队列等待，不切歌（暂停 ≠ 停止）
    const paused = String(st.status || "") === "Paused";
    // 能拿到播放器曲目 id 时，用 id 判断是否已经换歌（最可靠，不会因标题写法差异误判）；
    // 拿不到 id（主播自己放的非点播歌曲）才退回标题相似度判断。
    const idSwitch =
      !!cur &&
      cur.confirmed &&
      playing &&
      !!cur.song.id &&
      !!String(st.id || "") &&
      Date.now() - cur.startedAt > TITLE_CHANGE_GRACE_MS &&
      String(st.id) !== String(cur.song.playId || cur.song.id);
    const titleDiffers =
      !!cur &&
      cur.confirmed &&
      playing &&
      !cur.song.id &&
      !!title &&
      !!cur.song.name &&
      Date.now() - cur.startedAt > TITLE_CHANGE_GRACE_MS &&
      diceSimilarity(normalizeTitle(title), normalizeTitle(cur.song.name)) < TITLE_CHANGE_SIM;
    // 切歌后接管：标题变化需稳定 TITLE_CHANGE_SETTLE_MS 才生效，
    // 避免播放器加载、ED 画面等瞬时抖动把队列里的歌误顶上去；id 变化是确定事件，立即生效。
    let titleChanged = false;
    if (idSwitch) {
      titleChanged = true;
      pendingTitleChange = null;
    } else if (titleDiffers) {
      const changedTitle = normalizeTitle(title);
      const settled =
        pendingTitleChange &&
        pendingTitleChange.title === changedTitle &&
        Date.now() - pendingTitleChange.at >= TITLE_CHANGE_SETTLE_MS;
      if (settled) {
        titleChanged = true;
        pendingTitleChange = null;
      } else if (!pendingTitleChange || pendingTitleChange.title !== changedTitle) {
        pendingTitleChange = { title: changedTitle, at: Date.now() };
      }
    } else {
      pendingTitleChange = null;
    }
    const idleLong =
      !playing &&
      !paused &&
      idleSince != null &&
      Date.now() - idleSince >= IDLE_CONFIRM_MS &&
      Date.now() - (cur?.startedAt ?? 0) >= PLAY_GRACE_MS;

    if (playing && !mine) {
      // 当前状态属于别的播放平台：不打断，继续等
      scheduleNext();
      return;
    }
    // 拿不到进度/时长时，「等歌曲结束」没有判定依据：队列等太久就直接接管
    const unknownStuck =
      remain == null && playing && !!head && Date.now() - head.queuedAt > UNKNOWN_REMAIN_WAIT_MS;
    if (!nearEnd && !titleChanged && !idleLong && !unknownStuck) {
      scheduleNext();
      return;
    }

    // 当前歌曲即将结束（或被跳过 / 已停止）→ 播下一首
    const prev = current;
    const next = queue.shift();
    if (!next) {
      // 队列已空：把刚才那首标记为「已播放」，并结束监控
      try {
        prev?.onFinished?.();
      } catch {
        /* 记录更新不影响队列 */
      }
      current = null;
      return;
    }
    // 上一首正式让位：记录状态从「播放中」转为「已播放」
    try {
      prev?.onFinished?.();
    } catch {
      /* 记录更新不影响队列 */
    }
    const r = await doPlayNow(next.song, next.platform, next.onFinished);
    if (!r.ok) {
      // 播放失败（音乐软件未开等）→ 该首跳过，继续尝试后续
      console.warn("[点歌机]队列歌曲播放失败", next.song.name, r.error);
      try {
        next.onFailed?.(r.error);
      } catch {
        /* 记录失败不影响队列 */
      }
    } else {
      try {
        next.onStarted?.();
      } catch {
        /* 记录更新不影响队列 */
      }
    }
    scheduleNext();
  } catch (e: any) {
    console.warn("[点歌机]队列轮询异常", e?.message || e);
    scheduleNext();
  }
}

/** 插播模式：只确认「轮到我们的歌了没有」，不做切歌动作（切歌由播放器自己完成） */
async function pollInserted(head: QueueEntry): Promise<void> {
  const platform = head.platform;
  const st = await getMusicState(platform);
  if (!st.ok) {
    // 状态读不到时不能死守插播位：超过 30 秒就放弃插播，交回倒计时/标题兜底
    if (Date.now() - (head.insertedAt || 0) > 30_000) head.inserted = false;
    return;
  }

  const playing = !!st.playing && st.status !== "Stopped";
  const curId = String(st.id || "");
  const headId = String(head.song.playId || head.song.id || "");

  // 轮到我们的歌了：出队、接管为当前曲目，再把下一首插进「下一首播放」
  if (playing && curId && headId && curId === headId) {
    queue.shift();
    const dur = Number(st.duration) > 0 ? Number(st.duration) : Number(head.song.duration) || 0;
    // 上一首让位 → 已播放；本首刚开播 → 计时从现在开始
    try {
      current?.onFinished?.();
    } catch {
      /* 记录更新不影响队列 */
    }
    current = {
      song: head.song,
      platform,
      startedAt: Date.now(),
      duration: dur,
      confirmed: true,
      pauseStartedAt: null,
      onFinished: head.onFinished,
    };
    try {
      head.onStarted?.();
    } catch {
      /* 记录更新不影响队列 */
    }
    idleSince = null;
    pendingTitleChange = null;
    const next = queue[0];
    if (next && next.platform === platform && !next.inserted) await insertNextNow(next);
    return;
  }

  if (!playing) {
    // 暂停：保留插播位置（恢复播放后会校验 nextId 再决定是否重插）；
    // 停止或长时间无歌：插播已失效，交回倒计时兜底
    const paused = String(st.status || "") === "Paused";
    if (!paused && Date.now() - (head.insertedAt || 0) > 30000) head.inserted = false;
    return;
  }

  const nextId = String(st.nextId || "");
  // 插播位仍然有效（我们的歌就是「下一首」）：等播放器自己切过去
  if (nextId && nextId === headId) return;
  if (Date.now() - (head.insertedAt || 0) < INSERT_SETTLE_MS) return; // 刚插完，客户端还没生效
  // 读不到「下一首」信息时不要盲目重插（会产生重复歌曲），等一分钟仍无信息再交回兜底
  if (!nextId) {
    if (Date.now() - (head.insertedAt || 0) > 60_000) head.inserted = false;
    return;
  }

  // 插播被挤掉了（主播手动跳歌 / 换了播放列表）→ 重新插；屡次失败就交回倒计时兜底
  if ((head.insertTries || 0) >= INSERT_MAX_TRIES) {
    head.inserted = false;
    return;
  }
  await insertNextNow(head);
}

/** 清空队列与轮询（停止监听时调用） */
export function clearSongQueue(): void {
  queue = [];
  current = null;
  idleSince = null;
  pendingTitleChange = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** 队列长度（调试/展示用） */
export function songQueueLength(): number {
  return queue.length;
}
