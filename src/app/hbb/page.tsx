"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SiteHomeButton from "@/components/SiteHomeButton";
import { biliSpaceWebUrl, openBiliSpace } from "@/lib/bili-space";
import {
  MAX_RANK_LIMIT,
  RANK_PAGE_ROWS,
  type LeaderboardCardMeta,
  type LeaderboardMeta,
  type LeaderboardMetric,
  type LeaderboardRanking,
  type LeaderboardRow,
  type LeaderboardSort,
  type LeaderboardTabKey,
  type LeaderboardView,
} from "@/lib/leaderboard-types";

/** 顶部三种榜单模式：用户合成 / 用户盲盒 / 主播盲盒 */
type BoardMode = "user-synthesis" | "user-blind" | "anchor-blind";

const MODES: Array<{
  key: BoardMode;
  label: string;
  tab: LeaderboardTabKey;
  view: LeaderboardView;
}> = [
  { key: "user-synthesis", label: "用户合成", tab: "synthesis", view: "user" },
  { key: "user-blind", label: "用户盲盒", tab: "blind", view: "user" },
  { key: "anchor-blind", label: "主播盲盒", tab: "blind", view: "anchor" },
];

/** 每行固定列宽：昵称列定宽、公式列占据剩余空间，所有卡片数字起始位置一致 */
const ROW_GRID =
  "grid grid-cols-[22px_118px_minmax(0,1fr)_44px] items-center gap-0.5 pl-0.5 pr-0.5 sm:grid-cols-[24px_130px_minmax(0,1fr)_48px] sm:gap-2 sm:pl-2 sm:pr-1 lg:grid-cols-[22px_122px_minmax(0,1fr)_44px] xl:grid-cols-[28px_146px_minmax(0,1fr)_58px]";

/** 榜单侧面：白 = 前 N 名，黑 = 倒数 N 名 */
type BoardSide = "white" | "black";

/** 每张卡片的交互状态 */
type CardUi = {
  period?: string;
  sort?: LeaderboardSort;
  side?: BoardSide;
  limit?: number;
};

function fmt(n: number): string {
  return Math.round(Number(n) || 0).toLocaleString("zh-CN");
}

/** 收益 / 花费 / 盈亏：纯数字不加千分位；达到 10 万后显示为「11.2万」 */
function num(n: number): string {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 100000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

function signedProfit(n: number): string {
  const v = Math.round(Number(n) || 0);
  return `${v > 0 ? "+" : ""}${num(v)}`;
}

function normalizeFace(url?: string): string {
  if (!url) return "";
  let u = url.trim();
  if (!u) return "";
  if (u.startsWith("//")) u = `https:${u}`;
  if (u.startsWith("http://")) u = `https://${u.slice(7)}`;
  return u;
}

function rankingKey(card: string, period: string, view: string, sort: LeaderboardSort, limit: number): string {
  return `${card}|${period}|${view}|${sort}|${limit}`;
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-black/10 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-full px-2 py-[3px] text-[11.5px] font-medium transition ${
            value === o.value ? "bg-[#221d24] text-white" : "text-black/45 hover:text-black/70"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Avatar({ face, name }: { face?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const url = normalizeFace(face);
  if (!url || broken) {
    return (
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#ece7f7] text-[11px] font-semibold text-[#5b3fa8]">
        {name.slice(0, 1) || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      className="h-6 w-6 shrink-0 rounded-full bg-black/5 object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

/** 卡片最大礼物：没开出时显示「礼物图标 ×0」，右对齐贴近行尾 */
function MaxGiftBadge({ metric }: { metric: LeaderboardMetric }) {
  const gift = metric.maxGift;
  if (!gift) {
    return <span className="w-full" />;
  }
  return (
    <span
      className="flex min-w-0 items-center justify-end gap-1"
      title={`${gift.name || "最大礼物"}（单价 ${fmt(gift.price)} 电池）×${fmt(gift.count)}`}
    >
      {gift.img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={normalizeFace(gift.img)}
          alt={gift.name}
          className="h-5 w-5 shrink-0 rounded object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
      <span className="whitespace-nowrap text-[12px] tabular-nums text-[#4f4a55] xl:text-[13px]">
        ×{fmt(gift.count)}
      </span>
    </span>
  );
}

/** 「收益-花费=盈亏」与礼物两列，字号加大、灰色加深 */
function MetricCells({
  metric,
  showGift = true,
  sort = "absolute",
}: {
  metric: LeaderboardMetric;
  showGift?: boolean;
  sort?: LeaderboardSort;
}) {
  if (sort === "relative") {
    const hasSpent = metric.spent > 0;
    const ratio = hasSpent ? metric.earned / metric.spent : 0;
    const good = hasSpent && ratio >= 1;
    return (
      <>
        <span className="whitespace-nowrap text-left text-[12px] tabular-nums text-[#4f4a55] xl:text-[13px]">
          {num(metric.earned)}/{num(metric.spent)}=
          <span className={`font-semibold ${good ? "text-[#1f9d63]" : "text-[#e0523f]"}`}>
            {hasSpent ? ratio.toFixed(2) : "—"}
          </span>
        </span>
        {showGift ? <MaxGiftBadge metric={metric} /> : null}
      </>
    );
  }
  const positive = metric.profit >= 0;
  return (
    <>
      <span className="whitespace-nowrap text-left text-[12px] tabular-nums text-[#4f4a55] xl:text-[13px]">
        {num(metric.earned)}-{num(metric.spent)}=
        <span className={`font-semibold ${positive ? "text-[#1f9d63]" : "text-[#e0523f]"}`}>
          {signedProfit(metric.profit)}
        </span>
      </span>
      {showGift ? <MaxGiftBadge metric={metric} /> : null}
    </>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const abs = Math.abs(rank);
  if (abs > 3) {
    return <span className="flex h-5 w-5 items-center justify-center text-[12px] font-semibold text-black/40">{rank}</span>;
  }
  // 白榜第 1/2/3 与黑榜倒数第 1/2/3 使用相同的金银铜配色
  const style =
    abs === 1
      ? "bg-[#f5c451] text-[#5b3f00]"
      : abs === 2
        ? "bg-[#dfe3e8] text-[#454b52]"
        : "bg-[#e8c9a8] text-[#5b3b1c]";
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold ${style}`}>
      {rank}
    </span>
  );
}

function RowView({
  row,
  showGift,
  sort,
}: {
  row: LeaderboardRow;
  showGift: boolean;
  sort: LeaderboardSort;
}) {
  return (
    <div className={`${ROW_GRID} rounded-lg py-[6px] odd:bg-black/[0.02]`}>
      <RankBadge rank={row.rank} />
      <a
        href={biliSpaceWebUrl(row.uid)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void openBiliSpace(row.uid);
        }}
        className="group flex min-w-0 items-center gap-1.5 rounded transition hover:opacity-80"
        title={`打开 ${row.name} 的个人空间`}
      >
        <Avatar face={row.face} name={row.name} />
        <span className="min-w-0 truncate text-[13px] font-medium text-black/80 group-hover:underline">
          {row.name}
        </span>
      </a>
      <MetricCells metric={row.metric} showGift={showGift} sort={sort} />
    </div>
  );
}

export default function HeiBaiPage() {
  const [meta, setMeta] = useState<LeaderboardMeta | null>(null);
  const [metaError, setMetaError] = useState("");
  const [mode, setMode] = useState<BoardMode>("user-blind");
  const [cardUi, setCardUi] = useState<Record<string, CardUi>>({});
  const [rankings, setRankings] = useState<Record<string, LeaderboardRanking>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const modeCfg = MODES.find((m) => m.key === mode) ?? MODES[1];
  const activeTab = modeCfg.tab;
  const view = modeCfg.view;

  useEffect(() => {
    return () => {
      if (spinTimer.current) clearTimeout(spinTimer.current);
    };
  }, []);

  // 拉取卡片配置
  useEffect(() => {
    let alive = true;
    fetch("/api/leaderboard/meta", { cache: "no-store" })
      .then((r) => r.json())
      .then((json: { code?: number; data?: LeaderboardMeta; message?: string }) => {
        if (!alive) return;
        if (json?.code === 0 && json.data) {
          setMeta(json.data);
          setMetaError("");
        } else {
          setMetaError(json?.message || "加载榜单配置失败");
        }
      })
      .catch(() => {
        if (alive) setMetaError("加载榜单配置失败");
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // 每张卡片的有效交互状态：周期 / 排序口径 / 白黑 / 当前展示条数
  const uiOf = useCallback(
    (card: LeaderboardCardMeta) => {
      const ui = cardUi[card.key] ?? {};
      const period =
        ui.period && card.periods.some((p) => p.key === ui.period) ? ui.period : card.defaultPeriod;
      return {
        period,
        sort: ui.sort ?? ("absolute" as LeaderboardSort),
        side: ui.side ?? ("white" as BoardSide),
        limit: ui.limit ?? RANK_PAGE_ROWS,
      };
    },
    [cardUi],
  );

  // 按需加载当前模式下所有卡片的排行
  useEffect(() => {
    if (!meta) return;
    const tab = meta.tabs.find((t) => t.key === activeTab);
    if (!tab) return;
    for (const card of tab.cards) {
      const { period, sort, limit } = uiOf(card);
      const key = rankingKey(card.key, period, view, sort, limit);
      if (rankings[key] || inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      const params = new URLSearchParams({
        card: card.key,
        period,
        view,
        sort,
        limit: String(limit),
      });
      fetch(`/api/leaderboard/ranking?${params.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((json: { code?: number; data?: LeaderboardRanking }) => {
          if (json?.code === 0 && json.data) {
            setRankings((prev) => ({ ...prev, [key]: json.data as LeaderboardRanking }));
            setFailed((prev) => {
              if (!prev[key]) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          } else {
            setFailed((prev) => ({ ...prev, [key]: true }));
          }
        })
        .catch(() => setFailed((prev) => ({ ...prev, [key]: true })))
        .finally(() => inFlight.current.delete(key));
    }
  }, [meta, activeTab, view, uiOf, rankings]);

  const currentTab = meta?.tabs.find((t) => t.key === activeTab) ?? null;

  const updateUi = (card: LeaderboardCardMeta, patch: Partial<CardUi>) => {
    setCardUi((prev) => ({ ...prev, [card.key]: { ...(prev[card.key] ?? {}), ...patch } }));
  };

  // 切换周期 / 排序 / 白黑时回到默认 30 条
  const setPeriod = (card: LeaderboardCardMeta, period: string) => {
    updateUi(card, { period, limit: RANK_PAGE_ROWS });
  };
  const setSort = (card: LeaderboardCardMeta, sort: LeaderboardSort) => {
    updateUi(card, { sort, limit: RANK_PAGE_ROWS });
  };
  const setSide = (card: LeaderboardCardMeta, side: BoardSide) => {
    updateUi(card, { side, limit: RANK_PAGE_ROWS });
  };
  const expandRows = (card: LeaderboardCardMeta) => {
    const { limit } = uiOf(card);
    updateUi(card, { limit: Math.min(MAX_RANK_LIMIT, limit + RANK_PAGE_ROWS) });
  };

  const refresh = () => {
    inFlight.current.clear();
    setRankings({});
    setFailed({});
    setMetaError("");
    setReloadKey((v) => v + 1);
    setSpinning(true);
    if (spinTimer.current) clearTimeout(spinTimer.current);
    spinTimer.current = setTimeout(() => setSpinning(false), 650);
  };

  const summaryLabel = view === "anchor" ? "全体主播" : "全体用户";

  return (
    <main
      className="min-h-screen text-[#221d24]"
      style={{
        background:
          "radial-gradient(1100px 600px at 10% -10%, rgba(255,170,150,0.34), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(150,190,255,0.3), transparent 55%), #ece4e8",
      }}
    >
      <div className="mx-auto w-full max-w-[1440px] px-2 pb-16 pt-6 sm:px-4 sm:pt-8">
        {/* 顶部：窄屏均匀分布、宽屏居中；三个独立单选按钮 + 圆环刷新按钮 */}
        <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-2 px-1 sm:justify-center sm:gap-x-3 sm:px-0 lg:gap-x-5">
          <span className="shrink-0 whitespace-nowrap text-[15px] font-semibold tracking-[0.06em] text-black/55 sm:text-[17px]">
            黑白榜
          </span>
          {MODES.map((m) => {
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                aria-pressed={active}
                className={`flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 text-[13px] font-semibold transition active:scale-[0.97] sm:px-3.5 ${
                  active
                    ? "border-black bg-black text-white shadow-sm"
                    : "border-black/10 bg-white/70 text-black/55 hover:bg-white hover:text-black/75"
                }`}
              >
                {m.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={refresh}
            title="刷新榜单"
            aria-label="刷新榜单"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-black/10 bg-white/70 text-black/50 shadow-[0_8px_22px_-18px_rgba(40,20,50,0.8)] backdrop-blur transition hover:border-black/30 hover:text-black/75 active:scale-90"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
            >
              <path d="M21 12a9 9 0 1 1-2.636-6.364" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>

        {metaError && (
          <div className="mt-5 rounded-2xl border border-[#e0523f]/20 bg-[#e0523f]/[0.06] px-4 py-3 text-[13px] text-[#b23c2c]">
            {metaError}
          </div>
        )}

        {!meta && !metaError && (
          <div className="mt-5 rounded-2xl border border-black/[0.06] bg-white px-4 py-10 text-center text-[13px] text-black/35">
            加载中…
          </div>
        )}

        {meta && currentTab && currentTab.cards.length === 0 && (
          <div className="mt-5 rounded-2xl border border-black/[0.06] bg-white px-4 py-10 text-center text-[13px] text-black/35">
            暂无榜单卡片，请在管理后台勾选对应的盲盒 / 合成活动。
          </div>
        )}

        {currentTab && currentTab.cards.length > 0 && (
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {currentTab.cards.map((card) => {
              const { period, sort, side, limit } = uiOf(card);
              const key = rankingKey(card.key, period, view, sort, limit);
              const data = rankings[key];
              const isFailed = failed[key];
              // 无法确定卡片最大礼物时不展示礼物列，避免误显示用户自己的最大礼物
              const showGift = !card.hideTopGift && !!card.topGift;
              const rows = data ? (side === "white" ? data.top : data.bottom) : [];
              const canExpand = !!data && data.total > limit && limit < MAX_RANK_LIMIT;

              return (
                <section
                  key={card.key}
                  className="rounded-2xl border border-black/[0.07] bg-white px-2 py-3 shadow-[0_10px_30px_rgba(31,28,23,0.05)] sm:px-3"
                >
                  <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {card.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={normalizeFace(card.icon)}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded-md object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : null}
                      <h2 className="truncate text-[14px] font-semibold text-[#221d24]">{card.title}</h2>
                      {card.unitNote ? (
                        <span className="shrink-0 whitespace-nowrap text-[11px] text-black/40">单位电池</span>
                      ) : null}
                    </div>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      {card.periods.length > 1 && (
                        <Segmented
                          value={period}
                          options={card.periods.map((p) => ({ value: p.key, label: p.label }))}
                          onChange={(v) => setPeriod(card, v)}
                        />
                      )}
                      <Segmented<LeaderboardSort>
                        value={sort}
                        options={[
                          { value: "absolute", label: "绝对" },
                          { value: "relative", label: "相对" },
                        ]}
                        onChange={(v) => setSort(card, v)}
                      />
                      <Segmented<BoardSide>
                        value={side}
                        options={[
                          { value: "white", label: "白" },
                          { value: "black", label: "黑" },
                        ]}
                        onChange={(v) => setSide(card, v)}
                      />
                    </div>
                  </header>

                  {!data && !isFailed && (
                    <div className="mt-3 rounded-xl bg-black/[0.02] px-3 py-8 text-center text-[12px] text-black/30">
                      加载中…
                    </div>
                  )}
                  {isFailed && (
                    <div className="mt-3 rounded-xl bg-[#e0523f]/[0.05] px-3 py-8 text-center text-[12px] text-[#b23c2c]">
                      加载失败，请稍后刷新
                    </div>
                  )}
                  {data && data.total === 0 && (
                    <div className="mt-3 rounded-xl bg-black/[0.02] px-3 py-8 text-center text-[12px] text-black/30">
                      暂无数据（等待用户上报）
                    </div>
                  )}

                  {data && data.total > 0 && (
                    <div className="mt-3">
                      <div className={`${ROW_GRID} mb-1 rounded-lg bg-[#f2edfa] py-[6px]`}>
                        <span className="flex h-5 w-5 items-center justify-center text-[12px] font-semibold text-[#5b3fa8]">
                          Σ
                        </span>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#5b3fa8] text-[11px] font-semibold text-white">
                            全
                          </span>
                          <span className="min-w-0 truncate text-[13px] font-semibold text-[#3d2b70]">
                            {summaryLabel}
                            <span className="ml-1 hidden text-[11px] font-normal text-black/45 sm:inline">
                              （{fmt(data.summary.users)} 人）
                            </span>
                          </span>
                        </div>
                        <MetricCells metric={data.summary} showGift={showGift} sort={sort} />
                      </div>

                      <div className="space-y-0.5">
                        {rows.map((row) => (
                          <RowView
                            key={`${side}-${row.uid}`}
                            row={row}
                            showGift={showGift}
                            sort={sort}
                          />
                        ))}
                      </div>

                      {canExpand && (
                        <button
                          type="button"
                          onClick={() => expandRows(card)}
                          aria-label="展开更多"
                          className="mx-auto mt-1.5 flex items-center gap-0.5 rounded-full px-3 py-1 text-[11px] font-medium text-black/40 transition hover:bg-black/[0.04] hover:text-black/65 active:scale-95"
                        >
                          <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-4 w-4"
                          >
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                          <span>展开更多</span>
                        </button>
                      )}

                      <p className="mt-1 px-2 text-right text-[10px] text-black/25">
                        共 {fmt(data.total)} 条
                      </p>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <p className="mt-8 text-center text-[14px] leading-5 text-black/30">
          榜单仅供娱乐，只统计了使用【B瓜】软件的用户。如果想上榜，可以使用软件查看自己的数据。
        </p>

        <SiteHomeButton />
      </div>
    </main>
  );
}
