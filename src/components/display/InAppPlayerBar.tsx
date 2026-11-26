"use client";

/**
 * 点歌听 · 软件内播放控制条
 *
 * 音频由后台模块（inapp-player）持有，本组件只渲染快照并下发控制指令：
 * 播放 / 暂停、拖动进度、下一首、音量。第一行是歌曲信息与控制，
 * 第二行是进度条与两端时间。
 */
import { useEffect, useState, type CSSProperties } from "react";
import {
  inAppPlayerSnapshot,
  inAppSeek,
  inAppSetVolume,
  inAppSkip,
  inAppTogglePlay,
  subscribeInAppPlayer,
  type InAppPlayerSnapshot,
} from "@/lib/song-request/inapp-player";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "00:00";
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** 自定义滑条用：把填充比例写进 CSS 变量 */
function rangeStyle(pct: number): CSSProperties {
  return { "--range-pct": `${Math.max(0, Math.min(100, pct)).toFixed(2)}%` } as CSSProperties;
}

export default function InAppPlayerBar() {
  const [state, setState] = useState<InAppPlayerSnapshot>(inAppPlayerSnapshot);

  useEffect(() => subscribeInAppPlayer(setState), []);

  const { hasTrack, playing, buffering, song, position, duration, queued, volume } = state;
  const canSeek = hasTrack && duration > 0;
  const artist = song?.artists?.filter(Boolean).join("/") || "";
  const progressPct = canSeek ? (position / duration) * 100 : 0;
  const volumePct = volume * 100;

  return (
    <div className="mt-2 rounded-xl border border-black/10 bg-white/75 px-3 py-2">
      {/* 第一行：歌曲 → 播放/暂停 → 下一首 → 音量（右端与第二行最右侧时间数字对齐） */}
      <div className="flex items-center gap-3 pr-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-black/80">
            {hasTrack ? song?.name || "未知歌曲" : "软件内暂无播放"}
            {hasTrack && artist ? <span className="font-normal text-black/45"> — {artist}</span> : null}
            {hasTrack && buffering ? (
              <svg
                viewBox="0 0 16 16"
                role="img"
                aria-label="缓冲中"
                className="ml-1 inline-block h-3 w-3 animate-spin align-[-2px] text-black/35"
              >
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  stroke="currentColor"
                  strokeOpacity="0.25"
                  strokeWidth="2"
                  fill="none"
                />
                <path
                  d="M14 8a6 6 0 0 0-6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            ) : null}
          </p>
        </div>

        <button
          type="button"
          onClick={inAppTogglePlay}
          disabled={!hasTrack}
          title={playing ? "暂停" : "播放"}
          aria-label={playing ? "暂停" : "播放"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#ec4141] text-white shadow-sm transition hover:opacity-90 active:scale-95 disabled:opacity-40"
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
              <rect x="4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" />
              <rect x="9.4" y="3" width="2.6" height="10" rx="0.8" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 translate-x-[1px]" aria-hidden>
              <path
                d="M5 3.2v9.6c0 .5.55.8.97.55l7.4-4.8a.65.65 0 0 0 0-1.1l-7.4-4.8A.65.65 0 0 0 5 3.2Z"
                fill="currentColor"
              />
            </svg>
          )}
        </button>

        <button
          type="button"
          onClick={inAppSkip}
          disabled={!hasTrack && queued === 0}
          title="下一首"
          aria-label="下一首"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-black/55 transition hover:bg-black/5 hover:text-black/80 active:scale-95 disabled:opacity-40"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
            <path
              d="M4 3.3v9.4c0 .5.55.8.97.55l6.3-4.7a.65.65 0 0 0 0-1.1l-6.3-4.7A.65.65 0 0 0 4 3.3Z"
              fill="currentColor"
            />
            <rect x="11.2" y="3.2" width="1.6" height="9.6" rx="0.8" fill="currentColor" />
          </svg>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-black/35" aria-hidden>
            <path
              d="M3 6.2h2.2L8.4 3.5a.6.6 0 0 1 1 .45v8.1a.6.6 0 0 1-1 .45L5.2 9.8H3a.7.7 0 0 1-.7-.7V6.9c0-.4.3-.7.7-.7Z"
              fill="currentColor"
            />
            <path
              d="M11.2 5.4a3.4 3.4 0 0 1 0 5.2"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={volume}
            onChange={(e) => inAppSetVolume(Number(e.target.value))}
            aria-label="音量"
            style={rangeStyle(volumePct)}
            className="media-range h-4 w-20"
          />
        </div>
      </div>

      {/* 第二行：时间 + 进度条 + 时间 */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="w-[34px] shrink-0 text-right text-[10px] tabular-nums text-black/40">
          {formatClock(position)}
        </span>
        <input
          type="range"
          min={0}
          max={canSeek ? duration : 0}
          step={0.5}
          value={canSeek ? Math.min(position, duration) : 0}
          onChange={(e) => inAppSeek(Number(e.target.value))}
          disabled={!canSeek}
          aria-label="播放进度"
          style={rangeStyle(progressPct)}
          className="media-range h-4 min-w-0 flex-1"
        />
        <span className="w-[34px] shrink-0 text-[10px] tabular-nums text-black/40">
          {canSeek ? formatClock(duration) : "--:--"}
        </span>
      </div>
    </div>
  );
}
