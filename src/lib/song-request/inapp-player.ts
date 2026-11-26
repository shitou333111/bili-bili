/**
 * 点歌听 · 软件内播放（服务器取流）
 *
 * 与 queue.ts（控制本机音乐软件）并列的另一种播放方式：
 * 服务器按原平台 id 解析音频，经 /api/sing/stream 代理流式传给客户端，
 * 这里用一个 HTMLAudioElement 播放，自己维护队列与点歌记录状态。
 *
 * 优点是不依赖本机闭源音乐软件，能精确播放粉丝歌单里其他平台的歌；
 * 代价是音频从服务器中转，占用服务器带宽。
 */
import { serverApiUrl, serverFetch } from "@/lib/server-api";
import type { SongRef } from "@/lib/sing/types";
import { isSameSong, type PlayOutcome } from "./queue";

interface Hooks {
  onStarted?: () => void;
  onFinished?: () => void;
}

interface Entry {
  song: SongRef;
  requestedBy: string;
  onFailed?: (error: string) => void;
  hooks?: Hooks;
  /** 网络抖动/临时 4xx 的重试次数 */
  retries: number;
}

/** 拿取流地址的接口返回 */
interface StreamUrlData {
  ok: boolean;
  url?: string;
  error?: string;
  quality?: string;
  preview?: boolean;
}

let audio: HTMLAudioElement | null = null;
let current: Entry | null = null;
let queue: Entry[] = [];
/** 正在为 current 拉取地址 / 启动播放（避免并发点击重复启动） */
let starting = false;
/** 主动停止时忽略 audio 的 error 事件 */
let stopping = false;
/** 当前 audio 期望的 src（用于过滤切换音源时旧的 error 事件） */
let expectedSrc = "";
/** 是否正在缓冲（网络差导致音频卡住时置 true，恢复播放后置 false） */
let buffering = false;

/** 音量默认 30%，之后记住用户自己的设置（localStorage） */
const VOLUME_KEY = "bili_live:inapp-volume";
const DEFAULT_VOLUME = 0.3;
let cachedVolume: number | null = null;

function readSavedVolume(): number {
  if (cachedVolume != null) return cachedVolume;
  try {
    if (typeof window === "undefined") return DEFAULT_VOLUME;
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const n = raw == null ? NaN : Number(raw);
    cachedVolume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_VOLUME;
  } catch {
    cachedVolume = DEFAULT_VOLUME;
  }
  return cachedVolume ?? DEFAULT_VOLUME;
}

function rememberVolume(v: number): void {
  cachedVolume = v;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* 隐私模式等写入失败不影响播放 */
  }
}

/** 播放器对外暴露的快照（面板据此渲染进度 / 暂停 / 音量等控制） */
export interface InAppPlayerSnapshot {
  /** 是否有歌曲（含暂停状态） */
  hasTrack: boolean;
  /** 是否正在出声 */
  playing: boolean;
  paused: boolean;
  /** 是否正在缓冲（音频卡顿等待数据，界面显示转圈） */
  buffering: boolean;
  song?: { name: string; artists: string[]; platform: string };
  /** 当前进度（秒） */
  position: number;
  /** 总时长（秒，0 = 未知） */
  duration: number;
  volume: number;
  muted: boolean;
  /** 等待播放的队列长度 */
  queued: number;
}

function buildSnapshot(): InAppPlayerSnapshot {
  const el = audio;
  const songDuration = Number(current?.song.duration) || 0;
  const duration =
    el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : songDuration;
  return {
    hasTrack: !!current,
    playing: !!current && !!el && !el.paused && !el.ended,
    paused: el ? el.paused : true,
    buffering: !!current && buffering,
    song: current
      ? { name: current.song.name, artists: current.song.artists, platform: current.song.platform }
      : undefined,
    position: el && Number.isFinite(el.currentTime) ? el.currentTime : 0,
    duration,
    volume: el ? el.volume : readSavedVolume(),
    muted: el ? el.muted : readSavedVolume() === 0,
    queued: queue.length,
  };
}

let snapshot: InAppPlayerSnapshot = buildSnapshot();
const snapshotListeners = new Set<(s: InAppPlayerSnapshot) => void>();
let lastEmitAt = 0;

/**
 * 通知界面刷新。timeupdate 触发很频繁（约 4 次/秒），
 * 这里做 350ms 节流；状态类变化（暂停 / 切歌 / 音量）用 force 立即推送。
 */
function emit(force = false): void {
  const now = Date.now();
  if (!force && now - lastEmitAt < 350) return;
  lastEmitAt = now;
  snapshot = buildSnapshot();
  for (const fn of snapshotListeners) {
    try {
      fn(snapshot);
    } catch {
      /* 单个订阅者异常不影响播放 */
    }
  }
}

/** 订阅播放器状态（返回取消订阅函数） */
export function subscribeInAppPlayer(fn: (s: InAppPlayerSnapshot) => void): () => void {
  snapshotListeners.add(fn);
  fn(snapshot);
  return () => {
    snapshotListeners.delete(fn);
  };
}

/** 取当前快照（首帧渲染用） */
export function inAppPlayerSnapshot(): InAppPlayerSnapshot {
  return snapshot;
}

/** 播放 / 暂停 */
export function inAppTogglePlay(): void {
  const el = audio;
  if (!el || !current) return;
  if (el.paused) {
    void el.play().catch(() => undefined);
  } else {
    el.pause();
  }
}

/** 跳到下一首（当前这首记为已播放） */
export function inAppSkip(): void {
  const el = audio;
  const entry = current;
  current = null;
  try {
    entry?.hooks?.onFinished?.();
  } catch {
    /* 记录更新不影响队列 */
  }
  if (el) {
    stopping = true;
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* ignore */
    }
    stopping = false;
  }
  expectedSrc = "";
  buffering = false;
  emit(true);
  void playNext();
}

/** 拖动进度 */
export function inAppSeek(seconds: number): void {
  const el = audio;
  if (!el || !current || !Number.isFinite(seconds)) return;
  try {
    el.currentTime = Math.max(0, seconds);
  } catch {
    /* 元数据未就绪时忽略 */
  }
  emit(true);
}

/** 调整音量（0–1；调到 0 自动静音） */
export function inAppSetVolume(value: number): void {
  const el = audio;
  if (!el || !Number.isFinite(value)) return;
  const v = Math.min(1, Math.max(0, value));
  el.volume = v;
  el.muted = v === 0;
  rememberVolume(v);
  emit(true);
}

function audioErrorMessage(el: HTMLAudioElement): string {
  const code = el.error?.code;
  switch (code) {
    case 1:
      return "播放被中止";
    case 2:
      return "网络中断";
    case 3:
      return "音频解码失败";
    case 4:
      return "音频源不可用";
    default:
      return "播放失败";
  }
}

/** 1 帧静音 WAV：借用用户的第一次点击/按键「解锁」音频播放权限 */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** 浏览器（含部分 WebView）默认拦截无手势的自动播放，这里在首次交互时静默解锁 */
function attachAutoplayUnlock(el: HTMLAudioElement): void {
  if (typeof document === "undefined") return;
  const unlock = () => {
    document.removeEventListener("pointerdown", unlock);
    document.removeEventListener("keydown", unlock);
    if (current) return; // 已经在播，无需解锁
    const prev = expectedSrc;
    try {
      el.src = SILENT_WAV;
      el.muted = true;
      void el
        .play()
        .then(() => {
          el.pause();
          el.muted = false;
          // 若解锁前正好有一首在等待加载，恢复它
          if (prev && !current) {
            el.src = prev;
            void el.play().catch(() => undefined);
          }
        })
        .catch(() => {
          el.muted = false;
        });
    } catch {
      el.muted = false;
    }
  };
  document.addEventListener("pointerdown", unlock, { once: true });
  document.addEventListener("keydown", unlock, { once: true });
}

function getAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "auto";
  el.volume = readSavedVolume();
  el.muted = el.volume === 0;
  el.setAttribute("playsinline", "");
  // 进度 / 状态变化同步给控制面板（ended / error 的处理函数在后面注册，
  // 保证先清理 current，再通知界面刷新）
  for (const ev of [
    "play",
    "volumechange",
    "loadedmetadata",
    "durationchange",
    "ended",
    "emptied",
  ]) {
    el.addEventListener(ev, () => emit(true));
  }
  // 缓冲状态：网络卡顿等待数据时转圈，恢复出声 / 可继续播放后收起
  el.addEventListener("waiting", () => {
    buffering = true;
    emit(true);
  });
  el.addEventListener("stalled", () => {
    buffering = true;
    emit(true);
  });
  el.addEventListener("playing", () => {
    buffering = false;
    emit(true);
  });
  el.addEventListener("canplay", () => {
    buffering = false;
    emit(true);
  });
  el.addEventListener("pause", () => {
    buffering = false;
    emit(true);
  });
  el.addEventListener("timeupdate", () => emit());
  el.addEventListener("ended", () => {
    const done = current;
    current = null;
    buffering = false;
    try {
      done?.hooks?.onFinished?.();
    } catch {
      /* 记录更新不影响队列 */
    }
    emit(true);
    void playNext();
  });
  el.addEventListener("error", () => {
    if (stopping) return;
    if (expectedSrc && el.src !== expectedSrc) return; // 旧音源的迟到事件
    const entry = current;
    if (!entry) return;
    const reason = audioErrorMessage(el);
    // 网络类错误重试一次，尽量别让直播间突然安静
    if (entry.retries < 1 && /网络|解码/.test(reason)) {
      entry.retries += 1;
      const resumeAt = el.currentTime || 0;
      window.setTimeout(() => {
        if (current !== entry) return;
        try {
          el.src = expectedSrc;
          el.load();
          el.currentTime = resumeAt;
        } catch {
          /* 恢复失败则按失败处理 */
        }
        void el.play().catch(() => {
          /* 仍失败则由下一轮 error 事件走失败流程 */
        });
      }, 1200);
      return;
    }
    current = null;
    buffering = false;
    try {
      entry.onFailed?.(reason);
    } catch {
      /* 记录更新不影响队列 */
    }
    emit(true);
    void playNext();
  });
  audio = el;
  return el;
}

async function requestStreamUrl(song: SongRef): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const res = await serverFetch<{ code: number; data: StreamUrlData }>(
      "/api/sing/stream/url",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: song.platform,
          id: song.id,
          playId: song.playId,
          name: song.name,
          artists: song.artists,
          duration: song.duration,
        }),
      },
      25_000,
    );
    const data = res?.data;
    if (res?.code !== 0 || !data?.ok || !data.url) {
      return { ok: false, error: data?.error || "stream_unavailable" };
    }
    return { ok: true, url: data.url };
  } catch {
    return { ok: false, error: "service_unavailable" };
  }
}

/** 开始播放一首歌；失败返回原因，调用方负责记录 */
async function startEntry(entry: Entry): Promise<{ ok: boolean; error?: string }> {
  starting = true;
  try {
    const src = await requestStreamUrl(entry.song);
    if (!src.ok || !src.url) return { ok: false, error: src.error };

    const el = getAudio();
    stopping = false;
    expectedSrc = serverApiUrl(src.url);
    current = entry;
    el.src = expectedSrc;
    el.load();
    buffering = true;
    emit(true);
    try {
      await el.play();
    } catch (e) {
      if (current === entry) current = null;
      emit(true);
      // 浏览器自动播放策略：连续播放（ended → 下一首）通常允许，
      // 但页面首次发声必须有用户手势，这里给出可操作的提示。
      const name = String((e as { name?: string })?.name || "");
      return {
        ok: false,
        error: name === "NotAllowedError" ? "autoplay_blocked" : "audio_load_failed",
      };
    }
    try {
      entry.hooks?.onStarted?.();
    } catch {
      /* 记录更新不影响队列 */
    }
    emit(true);
    return { ok: true };
  } finally {
    starting = false;
  }
}

async function playNext(): Promise<void> {
  if (starting || current) return;
  const next = queue.shift();
  if (!next) {
    emit(true);
    return;
  }
  emit(true);
  const r = await startEntry({ ...next, retries: 0 });
  if (!r.ok) {
    try {
      next.onFailed?.(r.error || "播放失败");
    } catch {
      /* 记录更新不影响队列 */
    }
    // 单曲失败不阻塞后续队列
    void playNext();
  }
}

/**
 * 请求播放或入队（与 queue.ts 的 enqueueOrPlay 行为对齐）：
 * 没在播 → 立即播；正在播 → 排队等上一首结束。
 */
export async function enqueueOrPlayInApp(
  song: SongRef,
  requestedBy: string,
  onFailed?: (error: string) => void,
  hooks?: Hooks,
): Promise<PlayOutcome> {
  if (current && isSameSong(current.song, song)) {
    return { mode: "duplicate", where: "playing", position: 1 };
  }
  const dupIndex = queue.findIndex((e) => isSameSong(e.song, song));
  if (dupIndex >= 0) {
    return { mode: "duplicate", where: "queued", position: dupIndex + 1 };
  }
  const entry: Entry = { song, requestedBy, onFailed, hooks, retries: 0 };

  if (!current && !starting) {
    const r = await startEntry(entry);
    if (!r.ok) return { mode: "failed", error: r.error || "播放失败" };
    return { mode: "play" };
  }
  queue.push(entry);
  emit(true);
  return { mode: "queued", position: queue.length };
}

/** 停止软件内播放并清空队列（切换播放方式 / 停止监听时调用） */
export function stopInAppPlayer(): void {
  stopping = true;
  const entry = current;
  const pending = queue;
  queue = [];
  current = null;
  expectedSrc = "";
  buffering = false;
  // 点歌记录不要停留在「播放中 / 排队中」：已开始的按已播放处理，未开始的按失败处理
  try {
    entry?.hooks?.onFinished?.();
  } catch {
    /* 记录更新不影响停止流程 */
  }
  for (const item of pending) {
    try {
      item.onFailed?.("已停止播放");
    } catch {
      /* 同上 */
    }
  }
  if (audio) {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      /* ignore */
    }
  }
  emit(true);
}

/** 当前是否正在软件内播放（调试/展示用） */
export function inAppPlayerState(): { playing: boolean; name?: string; queued: number } {
  return { playing: !!current, name: current?.song.name, queued: queue.length };
}

// 页面加载时就把音频元素建好并挂上解锁监听：
// 这样观众点歌之前，主播对页面的任意一次点击/按键都能解除自动播放限制。
if (typeof document !== "undefined") {
  attachAutoplayUnlock(getAudio());
}
