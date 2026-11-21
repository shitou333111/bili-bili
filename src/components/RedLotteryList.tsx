"use client";

/**
 * 公开的天选/红包直播间列表（/red）。
 *
 * 只做展示：从服务器扫描快照读取「自动抢天选和红包」模块扫描到的结果，
 * 用户点击卡片自行进入直播间参与，页面不提供任何自动参与能力。
 *
 * - 数据：/api/lottery/scan/results 拉取快照，/api/lottery/scan/wait 长轮询近实时更新；
 * - 排序：时间（倒计时从小到大）/ 金额（单份价值从大到小）；
 * - 筛选：天选 / 电池红包 / 普通红包（可多选）；
 * - 管理后台停止扫描（enabled=false）时显示「服务暂不可用」。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import SiteHomeButton from "@/components/SiteHomeButton";
import type { ScanResult } from "@/lib/lottery-scan";

type SortKey = "time" | "amount";
type Kind = "lottery" | "battery" | "normal";

type Snapshot = {
  enabled: boolean;
  scanning: boolean;
  minValue: number;
  serverNow: number;
  generation: number;
  results: ScanResult[];
};

const LONG_POLL_TIMEOUT_MS = 25_000;
const FALLBACK_REFRESH_MS = 60_000;

const KIND_META: Record<Kind, { label: string; icon: string }> = {
  lottery: { label: "天选", icon: "/tianxuan.png" },
  battery: { label: "电池", icon: "/gift-battery.avif" },
  normal: { label: "普通", icon: "/red_pocket.png" },
};

function kindOf(item: ScanResult): Kind {
  if (item.kind === "lottery") return "lottery";
  return item.rpType === 3 || item.rpType === 5 ? "battery" : "normal";
}

function prizeName(item: ScanResult): string {
  if (item.kind === "lottery") {
    return `${item.awardName || "天选"} x${item.awardNum || 1}`;
  }
  return item.awards?.[0]?.giftName || "红包";
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function Avatar({ face, name }: { face?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!face || broken) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#ece7f7] text-[10px] font-semibold text-[#5b3fa8]">
        {name.slice(0, 1) || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={face}
      alt=""
      onError={() => setBroken(true)}
      className="h-6 w-6 shrink-0 rounded-full bg-black/5 object-cover"
    />
  );
}

export default function RedLotteryList() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<SortKey>("time");
  const [kinds, setKinds] = useState<Record<Kind, boolean>>({
    lottery: true,
    battery: true,
    normal: true,
  });
  const [now, setNow] = useState(() => Date.now());
  const [serverOffset, setServerOffset] = useState(0);

  const generationRef = useRef(0);
  const lastFetchRef = useRef(0);

  // 倒计时每秒刷新
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 拉取快照 + 长轮询等待扫描结果变化
  useEffect(() => {
    let stopped = false;

    const refresh = async () => {
      try {
        const res = await fetch("/api/lottery/scan/results", { cache: "no-store" });
        const json = (await res.json()) as { code?: number; data?: Snapshot };
        if (stopped) return;
        if (json?.code === 0 && json.data) {
          const data = json.data;
          setServerOffset(data.serverNow - Date.now());
          generationRef.current = data.generation;
          lastFetchRef.current = Date.now();
          setSnapshot(data);
          setFailed(false);
        } else {
          setFailed(true);
        }
      } catch {
        if (!stopped) setFailed(true);
      }
    };

    const loop = async () => {
      await refresh();
      while (!stopped) {
        try {
          const res = await fetch(
            `/api/lottery/scan/wait?since=${generationRef.current}&timeout=${LONG_POLL_TIMEOUT_MS}`,
            { cache: "no-store" },
          );
          const json = (await res.json()) as { code?: number; data?: { changed?: boolean } };
          if (stopped) return;
          if (json?.code === 0) {
            if (json.data?.changed) await refresh();
            else if (Date.now() - lastFetchRef.current > FALLBACK_REFRESH_MS) await refresh();
          }
        } catch {
          if (stopped) return;
          // 网络异常 / 长轮询超时：退避后重试
          await new Promise((r) => setTimeout(r, 15_000));
          if (stopped) return;
          if (Date.now() - lastFetchRef.current > FALLBACK_REFRESH_MS) await refresh();
        }
      }
    };

    void loop();
    return () => {
      stopped = true;
    };
  }, []);

  const serverNowMs = now + serverOffset;
  // 管理后台停止扫描，或首次连接服务器失败时，视为服务不可用
  const serviceDown = snapshot ? !snapshot.enabled : failed;

  const results = useMemo(() => {
    const list = (snapshot?.results ?? [])
      .filter((item) => kinds[kindOf(item)])
      .filter((item) => item.endTime * 1000 > serverNowMs);
    list.sort(
      sort === "time"
        ? (a, b) => a.endTime - b.endTime
        : (a, b) => b.value - a.value || a.endTime - b.endTime,
    );
    return list;
  }, [snapshot, kinds, sort, serverNowMs]);

  return (
    <main
      className="min-h-screen text-[#221d24]"
      style={{
        background:
          "radial-gradient(1100px 600px at 10% -10%, rgba(255,170,150,0.34), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(150,190,255,0.3), transparent 55%), #ece4e8",
      }}
    >
      <div className="mx-auto w-full max-w-[900px] px-3 pb-16 pt-8 sm:px-5 sm:pt-10">
        {/* ===== 标题 ===== */}
        <div className="text-center">
          <h1 className="bg-gradient-to-br from-[#ff7a59] via-[#e0523f] to-[#7c4dff] bg-clip-text text-[26px] font-semibold tracking-tight text-transparent sm:text-[32px]">
            天选红包列表
          </h1>
          <p className="mt-2 text-[13px] text-black/40">
            只提供正在发放天选/红包的直播间列表，请点击卡片进入直播间手动参与
          </p>
        </div>

        {/* ===== 筛选 + 排序（同一行水平居中，排序在筛选右侧） ===== */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          <div className="inline-flex flex-wrap items-center gap-1.5">
            {(Object.keys(KIND_META) as Kind[]).map((key) => {
              const on = kinds[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKinds((prev) => ({ ...prev, [key]: !prev[key] }))}
                  aria-pressed={on}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-[5px] text-[12px] font-medium transition ${
                    on
                      ? "border-[#221d24]/15 bg-white text-[#221d24] shadow-sm"
                      : "border-black/[0.06] bg-white/40 text-black/30 hover:text-black/50"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={KIND_META[key].icon}
                    alt=""
                    className={`h-4 w-4 rounded object-cover ${on ? "" : "opacity-40 grayscale"}`}
                  />
                  {KIND_META[key].label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex rounded-full border border-black/10 bg-white p-0.5">
            {(
              [
                { key: "time", label: "时间", arrow: "↑" },
                { key: "amount", label: "金额", arrow: "↓" },
              ] as const
            ).map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setSort(o.key)}
                aria-pressed={sort === o.key}
                className={`rounded-full px-3 py-[5px] text-[12px] font-medium transition ${
                  sort === o.key ? "bg-[#221d24] text-white" : "text-black/45 hover:text-black/70"
                }`}
              >
                {o.label}
                <span className="ml-0.5 text-[12px] font-bold leading-none">{o.arrow}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ===== 列表 ===== */}
        {serviceDown ? (
          <div className="mt-8 rounded-3xl border border-black/[0.06] bg-white/70 px-6 py-16 text-center text-[15px] text-black/45 shadow-sm">
            服务暂不可用，请稍后再来 ···
          </div>
        ) : !snapshot ? (
          <div className="mt-8 rounded-3xl border border-black/[0.06] bg-white/70 px-6 py-16 text-center text-[13px] text-black/35 shadow-sm">
            加载中…
          </div>
        ) : results.length === 0 ? (
          <div className="mt-8 rounded-3xl border border-black/[0.06] bg-white/70 px-6 py-16 text-center text-[13px] text-black/35 shadow-sm">
            当前没有符合筛选条件的天选/红包
            <br />
            不需要手动刷新，列表会自动更新
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {results.map((item) => {
              const kind = kindOf(item);
              const meta = KIND_META[kind];
              const leftSec = Math.max(
                0,
                Math.round((item.endTime * 1000 - serverNowMs) / 1000),
              );
              return (
                <a
                  key={item.key}
                  href={`https://live.bilibili.com/${item.roomId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="grid items-center gap-x-2 rounded-xl border border-black/[0.06] bg-white/85 px-2.5 py-2 shadow-[0_8px_20px_-20px_rgba(40,20,50,0.8)] backdrop-blur transition hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_14px_28px_-20px_rgba(40,20,50,0.7)]"
                  // 单行：头像 / 主播 / 类型 + 奖品 / 金额（固定起点，便于纵向比较）/ 倒计时
                  style={{ gridTemplateColumns: "24px minmax(56px, 1fr) minmax(0, 70px) auto 44px" }}
                >
                  <Avatar face={item.face} name={item.uname || `#${item.roomId}`} />
                  <span className="min-w-0 truncate text-[12px] font-medium text-black/80">
                    {item.uname || `房间 ${item.roomId}`}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={meta.icon}
                      alt={meta.label}
                      title={meta.label}
                      className="h-4 w-4 shrink-0 rounded object-cover"
                    />
                    <span className="min-w-0 truncate text-[12px] text-black/55">
                      {prizeName(item)}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-left text-[11px] font-medium text-[#f59e0b]">
                    {item.value} 电池
                  </span>
                  <span
                    className={`text-right font-mono text-[12px] ${
                      leftSec <= 60 ? "text-red-500" : "text-black/45"
                    }`}
                  >
                    {formatCountdown(leftSec)}
                  </span>
                </a>
              );
            })}
          </div>
        )}

        {/* ===== 声明 ===== */}
        <section className="mt-10 rounded-3xl border border-black/[0.06] bg-white/60 px-4 py-5 text-[12px] leading-6 text-black/45 sm:px-6">
          <p>
            该网站只是提供发天选和红包的直播间列表，你需要手动点进直播间参与，不能自动参与，也不会提供。
          </p>
          <p className="mt-2">
            主播发红包目的是为了吸引用户到直播间，然后靠自身魅力转化用户。提供红包列表和主播目的一致，尤其是通过网站进入直播间的反而都是“活人”。
          </p>
          <p className="mt-2">
            红包的中奖率和粉丝等级、互动程度密切相关，甚至有直播间专属礼物，所以主播不必介意。
          </p>
          <p className="mt-2">
            本人并不通过这个盈利，只是为了方便主播和用户。
          </p>
          <p className="mt-2">
            综合以上几点并不认为此网页违规，但若有关方认为违规，可以微信联系 MRI_QA 删除网页。
          </p>
        </section>

        <SiteHomeButton />
      </div>
    </main>
  );
}
