"use client";

/**
 * 展示模块 · 点歌听卡片
 *
 * 不参与画布渲染，只靠弹幕回复互动：观众在直播间发送「点歌 歌名」，
 * 主播端解析其 /sing 歌单并控制本机音乐软件播放。本卡片做配置 + 点歌记录：
 * 总开关 / 关键词 / 播放软件 / 点歌礼物 / 最近点歌记录（状态实时流转）。
 */
import { useEffect, useRef, useState } from "react";
import { getPlatform } from "@/lib/platform";
import { serverApiUrl } from "@/lib/server-api";
import type { SongRequestConfig } from "@/lib/display/types";
import {
  clearSongRequestLog,
  loadSongRequestLog,
  subscribeSongRequestLog,
  type SongRequestLogEntry,
  type SongRequestLogStatus,
} from "@/lib/song-request/log";
import GiftSearchInput, { type GiftPick } from "./GiftSearchInput";
import PlatformIcon from "@/components/PlatformIcon";
import HintBubble from "@/components/HintBubble";
import { probeInsertSupport, restartNetease, type InsertSupport } from "@/lib/song-request/queue";
import { stopInAppPlayer } from "@/lib/song-request/inapp-player";
import InAppPlayerBar from "./InAppPlayerBar";

const STATUS_BADGE: Record<SongRequestLogStatus, { label: string; className: string }> = {
  playing: { label: "播放中", className: "bg-emerald-500/15 text-emerald-700" },
  queued: { label: "排队中", className: "bg-sky-500/15 text-sky-700" },
  played: { label: "已播放", className: "bg-black/10 text-black/50" },
  failed: { label: "播放失败", className: "bg-red-500/15 text-red-700" },
  unmatched: { label: "未找到", className: "bg-black/10 text-black/50" },
  no_list: { label: "无歌单", className: "bg-black/10 text-black/50" },
  unavailable: { label: "服务异常", className: "bg-amber-500/15 text-amber-700" },
  gift_required: { label: "未投喂", className: "bg-black/10 text-black/50" },
};

const PLATFORMS: { value: SongRequestConfig["platform"]; label: string }[] = [
  // 软件内播放放最前：不依赖本机闭源软件，也能精确播其他平台的歌
  { value: "inapp", label: "软件内" },
  { value: "qq", label: "QQ" },
  { value: "kugou", label: "酷狗" },
  { value: "soda", label: "汽水" },
  // 网易云放最后：插播未开启时，后面会紧跟「插播未开启 + 重启网易云」提示与按钮
  { value: "netease", label: "网易云" },
];

/** 点歌时间（精确到分钟） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** iOS 风格开关（与展示面板其他模块一致）；size="sm" 为更扁平的紧凑版 */
function Switch({
  checked,
  disabled,
  onToggle,
  onColor = "bg-lime-500",
  size = "md",
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  onColor?: string;
  size?: "md" | "sm";
}) {
  const flat = size === "sm";
  return (
    <button
      type="button"
      onClick={() => onToggle(!checked)}
      disabled={disabled}
      className={`relative shrink-0 rounded-full transition-colors duration-300 ${
        flat ? "h-[16px] w-[30px]" : "h-[22px] w-[40px]"
      } ${checked ? onColor : "bg-black/15"} ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-[2px] rounded-full bg-white shadow transition-all duration-300 ${
          flat
            ? `h-[12px] w-[12px] ${checked ? "left-[16px]" : "left-[2px]"}`
            : `h-[18px] w-[18px] ${checked ? "left-[20px]" : "left-[2px]"}`
        }`}
      />
    </button>
  );
}

export default function SongRequestPanel({
  mid,
  value,
  isNative,
  onChange,
}: {
  /** 当前登录主播 uid（点歌记录按账号存放） */
  mid: number;
  value: SongRequestConfig;
  /** 是否桌面客户端（本机播放仅 Windows 客户端支持） */
  isNative: boolean;
  onChange: (patch: Partial<SongRequestConfig>) => void | Promise<void>;
}) {
  // 关键词输入态：失焦 / 回车提交，避免中文输入法合成被打断
  const [keyword, setKeyword] = useState(value.keyword);
  /** 点歌礼物行的提示（选礼物失败等） */
  const [notice, setNotice] = useState("");
  /** 本机音乐软件行的提示（重启网易云结果） */
  const [musicNotice, setMusicNotice] = useState("");
  /** 宠物投影行的提示（中转服务启动失败） */
  const [petNotice, setPetNotice] = useState("");
  const [logs, setLogs] = useState<SongRequestLogEntry[]>([]);
  /** 网易云「插播下一首」自检结果（null = 检测中） */
  const [insertSupport, setInsertSupport] = useState<InsertSupport | null>(null);
  /** 正在重启网易云（关闭 + 带端口启动，约 10–25 秒） */
  const [restarting, setRestarting] = useState(false);
  const composingRef = useRef(false);
  useEffect(() => {
    if (!composingRef.current) setKeyword(value.keyword);
  }, [value.keyword]);

  // 点歌记录：进入卡片时读取，之后跟随记录变化实时刷新
  useEffect(() => {
    let alive = true;
    void loadSongRequestLog(mid).then((list) => {
      if (alive) setLogs(list);
    });
    const unsub = subscribeSongRequestLog(mid, (list) => setLogs(list));
    return () => {
      alive = false;
      unsub();
    };
  }, [mid]);

  // 网易云插播自检：软件启动时页首已检查过，这里定期复检。
  // 客户端闲置较久后主窗口渲染进程可能被重建，调试目标会短暂不可用；
  // 只在挂载时查一次会导致「明明开了端口却一直提示未开启」。
  // 未就绪时用 5 秒的短周期（重启后端口/渲染进程恢复能很快反映到界面），
  // 已就绪时放宽到 30 秒，避免无谓的 CDP 探测。
  useEffect(() => {
    if (!isNative) return;
    let alive = true;
    const check = () => {
      void probeInsertSupport().then((r) => {
        if (!alive) return;
        setInsertSupport(r);
        // 端口恢复后清掉「仍未就绪」的残留提示
        if (r.ready) setMusicNotice("");
      });
    };
    check();
    const id = window.setInterval(check, insertSupport?.ready ? 30_000 : 5_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [isNative, insertSupport?.ready]);

  // 宠物投影：开启时确保内置中转服务已启动（幂等；客户端重启后配置仍为开启也会自动恢复）
  useEffect(() => {
    if (!isNative || !value.petCapture) return;
    let alive = true;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("pet_relay_start");
        if (alive) setPetNotice("");
      } catch (e: any) {
        if (alive) setPetNotice(`宠物中转启动失败：${e?.message || e}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isNative, value.petCapture]);

  const commitKeyword = () => {
    const k = keyword.trim().slice(0, 10) || "点歌";
    setKeyword(k);
    if (k !== value.keyword) void onChange({ keyword: k });
  };

  const pickGift = (g: GiftPick) => {
    if (g.id <= 0) {
      setNotice("该礼物未收录，换一个试试");
      return;
    }
    setNotice("");
    void onChange({ giftId: g.id, giftName: g.name });
  };

  const openSingPage = async () => {
    const url = serverApiUrl("/sing");
    try {
      const platform = await getPlatform();
      if (platform.isNative) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
    } catch {
      /* 降级 window.open */
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  /** 一键修复：关闭网易云并用调试端口重新启动，成功后继续探测直到端口可用 */
  const restartMusicApp = async () => {
    if (restarting) return;
    if (
      !window.confirm(
        "将关闭并重新启动网易云音乐（带调试端口），当前播放会中断，大约需要 10–25 秒。确定继续？",
      )
    ) {
      return;
    }
    setMusicNotice("");
    setRestarting(true);
    const r = await restartNetease();
    if (!r.ok) {
      setMusicNotice(`重启失败：${r.error || "未知错误"}`);
      setRestarting(false);
      return;
    }
    // 端口打开后渲染进程还要几秒才能连上 CDP：持续探测，
    // 避免「刚重启完就判定未就绪」把提示误留到下一个 5 秒周期。
    let next = await probeInsertSupport();
    for (let i = 0; i < 16 && !next.ready; i++) {
      await new Promise((res) => window.setTimeout(res, 1200));
      next = await probeInsertSupport();
    }
    setInsertSupport(next);
    if (!next.ready) {
      setMusicNotice("已重启网易云，但调试端口仍未就绪（可能被安全软件拦截或端口被占用）");
    }
    setRestarting(false);
  };

  return (
    <section>
      <div className="mb-1.5 flex select-none items-center justify-center gap-2">
        <h3 className="text-sm font-bold text-black/75">点歌听</h3>
        <Switch
          checked={value.enabled}
          onToggle={(v) => void onChange({ enabled: v })}
          onColor="bg-[#ec4141]"
        />
      </div>
      <section className="rounded-2xl border border-[#f4caca] bg-[#fdeeee] p-3.5 shadow-[0_1px_2px_rgba(31,28,23,0.06)]">
        <div className="flex items-start gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-relaxed text-[#6b4b4b]">
            <span>粉丝发送「{value.keyword || "点歌"} 歌名」，自动添加播放。</span>
            <span className="inline-flex items-center gap-1">
              <span className="shrink-0 font-medium text-black/75">触发词</span>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  setKeyword(e.currentTarget.value);
                }}
                onBlur={commitKeyword}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                maxLength={10}
                className="h-5 w-16 rounded-full bg-white/85 px-1.5 text-center text-[11px] leading-5 text-black/80 outline-none transition focus:bg-white focus:ring-2 focus:ring-[#ec4141]/25"
              />
            </span>
          </div>
          <button
            type="button"
            onClick={() => void openSingPage()}
            className="h-5 shrink-0 rounded-full bg-[#ec4141] px-2 text-[10px] font-medium leading-none text-white shadow-sm transition hover:opacity-90 active:scale-[0.98]"
          >
            歌单网站↗
          </button>
          <HintBubble label="点歌说明">
            <ul className="list-disc space-y-1 pl-4">
              <li>直播间发送弹幕点歌，并不是点唱主播的才艺歌曲，而是播放用户喜欢的歌曲，大家一起「听歌」而已。主播可以在左侧的[歌单网站]为自己和粉丝设置歌单。
              </li>
              <li>相比于一般点歌听，一是粉丝可以精确点自己的歌，二是自动在音乐软件中播放。功能比较偏，因为调研过程中发现一个很完善的插件
              <a
                href="https://play-live.bilibili.com/details/1793973485495"
                target="_blank"
                rel="noreferrer"
                className="mx-1 inline-flex items-center gap-0.5 rounded-full bg-[#ec4141]/10 px-1.5 py-0.5 align-middle text-[11px] font-medium leading-4 text-[#c9302c] transition hover:bg-[#ec4141] hover:text-white"
              >
               歌单点歌听↗
              </a>
               因此改为只实现额外的功能。
              </li>
              <li>
                「{value.keyword || "点歌"} 随机」随机播放用户歌单的一首，「{value.keyword || "点歌"} 主播」随机播放主播歌单的一首。
              </li>
              <li>
                {isNative
                  ? "「软件内」由服务器上的音乐账号取流播放，不依赖本机软件，能精确播粉丝其它平台的歌；本机播放支持网易云 / QQ音乐 / 酷狗 / 汽水（汽水只能点歌单内的歌）。"
                  : "「软件内」由服务器取流，网页端也能用；本机播放需要在 Windows 客户端中使用。"}
              </li>
              <li>该功能不会显示在画布中，只通过弹幕互动。这个模块不会太常用，之后会移动到页面底部。</li>
            </ul>
          </HintBubble>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="flex h-5 shrink-0 items-center text-xs font-medium leading-none text-black/75">
            点歌礼物
          </span>
          <span className="flex h-5 shrink-0 items-center text-[11px] leading-none text-black/40">
            （点歌前后1分钟内投喂）
          </span>
          <GiftSearchInput
            giftName={value.giftName}
            giftId={value.giftId}
            onPick={pickGift}
            placeholder="不设置则无需送礼"
            className="w-28"
            dropdownWidth={260}
            compact
          />
          {value.giftId > 0 && (
            <button
              type="button"
              onClick={() => void onChange({ giftId: 0, giftName: "" })}
              className="h-5 shrink-0 rounded-full bg-white/70 px-2 text-[11px] leading-none text-black/50 transition hover:bg-white"
            >
              清除
            </button>
          )}
        </div>
        {notice && <p className="mt-1.5 text-[11px] text-red-600/80">{notice}</p>}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-black/75">本机播放软件</span>
          <div className="flex flex-wrap items-center gap-1">
            {PLATFORMS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => {
                  // 离开「软件内」时停止正在播放的音频，避免和本机音乐软件同时出声
                  if (value.platform === "inapp" && p.value !== "inapp") stopInAppPlayer();
                  void onChange(
                    // 宠物投影只对网易云有效：切到其他方式时一并关闭，避免开关被隐藏后仍在投影
                    p.value === "netease" || !value.petCapture
                      ? { platform: p.value }
                      : { platform: p.value, petCapture: false },
                  );
                }}
                className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] transition ${
                  value.platform === p.value
                    ? "bg-[#ec4141] font-medium text-white"
                    : "bg-white/70 text-[#6b4b4b] hover:bg-white"
                }`}
              >
                <PlatformIcon platform={p.value} size={13} />
                {p.label}
              </button>
            ))}
          </div>
          {isNative && value.platform === "netease" && insertSupport && !insertSupport.ready && (
            <span className="flex items-center gap-1.5 text-[11px] text-amber-700/80">
              插件未启动
              <button
                type="button"
                disabled={restarting}
                onClick={() => void restartMusicApp()}
                className="rounded-full bg-black px-2 py-0.5 text-[10px] font-medium leading-4 text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {restarting ? "重启中…" : "重启网易云"}
              </button>
            </span>
          )}
          {value.platform === "inapp" && (
            <span className="text-[11px] text-black/40">服务器取流，原平台无版权自动换源</span>
          )}
          {value.platform === "soda" && (
            <span className="text-[11px] text-black/40">汽水音乐只限点歌单内</span>
          )}
        </div>
        {musicNotice && <p className="mt-1.5 text-[11px] text-red-600/80">{musicNotice}</p>}

        {/* 软件内播放：音频在后台播放，这里提供进度 / 暂停 / 下一首 / 停止 / 音量控制 */}
        {value.platform === "inapp" && <InAppPlayerBar />}

        {/* 网易云桌面宠物：窗口禁止捕获，内置中转服务取帧后投影到画布正中心（仅网易云可用） */}
        {value.platform === "netease" && (
          <>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs font-medium text-black/75">网易云音乐宠物捕捉<span className="text-[10px] text-black/40">（这是一个不太相关的功能，只是作者常用···）</span></span>
              <span className="flex items-center gap-2">
                <Switch
                  size="sm"
                  checked={!!value.petCapture}
                  onToggle={(v) => void onChange({ petCapture: v })}
                  onColor="bg-[#ec4141]"
                />
              </span>
            </div>
            {petNotice && <p className="mt-1.5 text-[11px] text-red-600/80">{petNotice}</p>}
          </>
        )}

        {/* 点歌记录：状态随队列实时流转（排队 → 播放中 → 已播放） */}
        <div className="mt-3 border-t border-[#f4caca] pt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-black/75">
              点歌记录<span className="ml-1 font-normal text-black/35">（自下向上按序号播放）</span>
            </span>
            <button
              type="button"
              disabled={logs.length === 0}
              onClick={() => void clearSongRequestLog(mid)}
              className="rounded-md px-1.5 py-0.5 text-[11px] text-black/45 transition hover:bg-white/70 hover:text-black/70 disabled:opacity-40"
            >
              清空
            </button>
          </div>
          {logs.length === 0 ? (
            <p className="mt-1 text-[11px] text-black/35">暂无点歌记录</p>
          ) : (
            <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto pr-0.5">
              {logs.map((e, i) => {
                const badge = STATUS_BADGE[e.status];
                const artist = e.artists?.filter(Boolean).join("/") || "";
                // 时间最早的在最下面、编号最小：最新的一条编号最大
                const no = logs.length - i;
                // 点歌原曲平台与本机播放软件不同时，显示「歌单平台 ➡️ 本地软件」
                const converted =
                  !!e.originPlatform && !!e.platform && e.originPlatform !== e.platform;
                return (
                  <li
                    key={`${e.ts}-${e.uid}-${i}`}
                    className="grid items-center gap-1 rounded-lg bg-white/70 px-2 py-0.5"
                    style={{ gridTemplateColumns: "20px 32px minmax(56px,96px) minmax(0,1fr) auto 52px" }}
                  >
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#ec4141] text-[10px] font-semibold tabular-nums text-white">
                      {no}
                    </span>
                    <span className="text-[10px] tabular-nums text-black/40">{formatTime(e.ts)}</span>
                    <span className="flex min-w-0 items-center gap-1 rounded-full bg-[#ec4141]/10 px-1 py-[1px] text-[10px] leading-4 text-[#7a4a4a]">
                      {e.avatar ? (
                        <img
                          src={e.avatar}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-4 w-4 shrink-0 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#ec4141]/25 text-[8px] font-semibold text-[#7a4a4a]">
                          {Array.from(e.uname || "匿")[0]}
                        </span>
                      )}
                      <span className="truncate">{e.uname || "匿名"}</span>
                    </span>
                    <span className="truncate text-[11px] text-black/60">
                      {e.songName || e.query}
                      {artist ? <span className="text-black/35"> — {artist}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      {converted ? (
                        <>
                          <PlatformIcon platform={e.originPlatform} size={14} />
                          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" aria-hidden>
                            <path
                              d="M2 8h11M9.5 4.5 13 8l-3.5 3.5"
                              fill="none"
                              stroke="#b26a6a"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <PlatformIcon platform={e.platform} size={14} />
                        </>
                      ) : (
                        <PlatformIcon platform={e.platform || e.originPlatform} size={14} />
                      )}
                      {e.source ? (
                        <span
                          className="ml-1 shrink-0 text-[9px] leading-[14px]"
                          style={{ color: e.source === "playlist" ? "#d40ba2ff" : "#6d28d9" }}
                        >
                          {e.source === "playlist" ? "歌单" : "乐库"}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`shrink-0 justify-self-end rounded px-1 py-[1px] text-[10px] leading-4 ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </section>
  );
}
