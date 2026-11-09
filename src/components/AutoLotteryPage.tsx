"use client";

import { useState, useEffect, useMemo } from "react";
import { showToast } from "@/lib/toast";
import { getPlatform } from "@/lib/platform";
import type { ScanResult } from "@/lib/lottery-scan";
import type { AuthSession } from "@/lib/auth/session";
import { RED_POCKET_DAILY_LIMIT, type PrizeRecord } from "@/lib/lottery-client";
import {
  useAutoLotteryRunner,
  initRunner,
  startRunner,
  stopRunner,
  reloadSessions,
  toggleAccount,
  setMinValueInput,
  commitMinValue,
  reloadPrizeRecords,
  type JoinState,
} from "@/lib/auto-lottery-runner";

type Props = { onBack: () => void };

/** 开奖后列表继续展示的时长（毫秒），用于显示中奖/未中奖结果 */
const RESULT_LINGER_MS = 5000;

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 固定宽度的中奖时间：MM-DD HH:mm，保证每行时间列左侧对齐 */
function formatWonAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openBiliLiveRoom(roomId: number) {
  if (!roomId) {
    showToast("房间号无效", "error");
    return;
  }
  getPlatform().then((platform) => {
    const appScheme = `bilibili://live/${roomId}`;
    const webUrl = `https://live.bilibili.com/${roomId}`;
    if (platform.isNative) {
      import("@tauri-apps/plugin-opener")
        .then(({ openUrl }) => openUrl(appScheme).catch(() => openUrl(webUrl).catch(() => {})))
        .catch(() => {});
      return;
    }
    window.open(webUrl, "_blank");
  });
}

export default function AutoLotteryPage({ onBack }: Props) {
  const runner = useAutoLotteryRunner();
  const [now, setNow] = useState(() => Date.now());
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  const [prizeCollapsed, setPrizeCollapsed] = useState(false);
  // 默认所有账号分组展开；记录被手动折叠的账号 mid
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<number>>(() => new Set());

  // 首次进入时初始化后台运行器（已初始化则幂等返回）
  useEffect(() => {
    void initRunner();
  }, []);

  // 倒计时每秒刷新（纯展示，不影响后台参与逻辑）
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const {
    isNative,
    running,
    results,
    server,
    sessions,
    selectedSids,
    invalidAccounts,
    validatedSids,
    validating,
    joinStates,
    logs,
    prizeRecords,
    minValue,
  } = runner;

  const selectedSessions = useMemo(
    () => sessions.filter((s) => selectedSids.includes(s.sid)),
    [sessions, selectedSids],
  );

  const serverNowMs = now + server.offset;
  const visibleResults = useMemo(() => {
    const min = Number(minValue) || 0;
    return results
      // 开奖后继续保留 5 秒，用于展示中奖/未中奖结果
      .filter((r) => r.endTime * 1000 + RESULT_LINGER_MS > serverNowMs)
      .filter((r) => r.value >= min)
      .sort((a, b) => a.endTime - b.endTime);
  }, [results, minValue, serverNowMs]);

  /** 按抽奖 ID 匹配中奖记录（用于开奖后展示结果） */
  const winRecordFor = (item: ScanResult): PrizeRecord | undefined => {
    if (item.kind === "lottery") {
      if (!item.lotteryId) return undefined;
      return prizeRecords.find((p) => p.kind === "lottery" && p.lotteryId === item.lotteryId);
    }
    if (!item.lotId) return undefined;
    return prizeRecords.find((p) => p.kind === "red_pocket" && p.redLotId === item.lotId);
  };

  const statusFor = (item: ScanResult, session: AuthSession): JoinState | undefined =>
    joinStates[`${session.sid}:${item.key}`];

  const totalPrizeValue = prizeRecords.reduce((sum, r) => sum + (r.prizeValue || 0), 0);

  /** 按账号归组统计中奖记录（记录在 runner 中已按时间倒序） */
  const prizeGroups = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const startMs = todayStart.getTime();
    const map = new Map<number, {
      mid: number;
      name: string;
      records: PrizeRecord[];
      totalValue: number;
      redToday: number;
      latestAt: number;
    }>();
    for (const r of prizeRecords) {
      let g = map.get(r.accountMid);
      if (!g) {
        g = { mid: r.accountMid, name: r.accountName, records: [], totalValue: 0, redToday: 0, latestAt: r.wonAt };
        map.set(r.accountMid, g);
      }
      g.records.push(r);
      g.totalValue += r.prizeValue || 0;
      if (r.kind === "red_pocket" && r.wonAt >= startMs) g.redToday += 1;
      if (r.wonAt > g.latestAt) g.latestAt = r.wonAt;
    }
    return [...map.values()].sort((a, b) => b.latestAt - a.latestAt);
  }, [prizeRecords]);

  const toggleAccountGroup = (mid: number) => {
    setCollapsedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-[#f5f6f7]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-black/5">
        <button onClick={onBack} className="p-1 -ml-1 text-black/60 hover:text-black">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="text-[15px] font-semibold">自动抢天选和红包</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {/* 账号选择 */}
        <div className="rounded-xl bg-white p-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">参与账号</span>
            <span className="text-[10px] text-black/35">{selectedSids.length}/{sessions.length} 已选</span>
            <button onClick={() => void reloadSessions()} className="ml-auto text-[10px] text-[#00a1d6]">
              重新加载账号
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="text-[11px] text-black/45">
              本机暂无已登录账号。请到「帮助」页「添加新账号」扫码登录后再回来。
            </p>
          ) : (
            <div className="space-y-1">
              {sessions.map((s) => {
                const checked = selectedSids.includes(s.sid);
                const invalid = invalidAccounts[s.sid];
                return (
                  <div key={s.sid} className="flex items-center gap-2 rounded-lg border border-black/5 px-2 py-1">
                    <input type="checkbox" checked={checked} onChange={() => toggleAccount(s.sid)} className="accent-[#00a1d6]" />
                    {s.face ? (
                      <img src={s.face} alt="" className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <div className="h-6 w-6 rounded-full bg-gray-200" />
                    )}
                    <span className="min-w-0 truncate text-[11px]">{s.uname}</span>
                    <span className="text-[10px] text-black/30">UID {s.mid}</span>
                    {invalid ? (
                      <span className="ml-auto text-[10px] text-red-500">已失效：{invalid}</span>
                    ) : validatedSids.includes(s.sid) ? (
                      <span className="ml-auto text-[10px] text-green-500">有效</span>
                    ) : (
                      <span className="ml-auto text-[10px] text-black/30">未校验</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-black/40">
            「帮助」页「添加新账号」扫码登录（本页不提供登录入口）。
            <br />
            <span className="text-red-500">⚠</span> 不建议使用主播账号抢红包，存在风险，后果自负。</p>
          {validating && <p className="text-[10px] text-black/40">正在校验账号登录状态…</p>}
        </div>

        {/* 最低价值 + 开始/停止 */}
        <div className="rounded-xl bg-white p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-black/50">单份礼物达到多少电池才抢</span>
            <input
              value={minValue}
              onChange={(e) => setMinValueInput(e.target.value)}
              onBlur={commitMinValue}
              inputMode="numeric"
              className="h-6 w-16 rounded border border-black/10 px-1.5 py-0 text-center text-[11px] leading-none outline-none focus:border-[#00a1d6]"
            />
            <span className="text-[10px] text-black/40">（下限{server.minValue}，太低不划算）</span>
          </div>
          {running ? (
            <button onClick={stopRunner} className="w-full rounded-lg bg-red-500 py-2 text-[13px] font-medium text-white hover:opacity-90">
              停止自动抢
            </button>
          ) : (
            <button
              onClick={() => void startRunner()}
              className={`w-full rounded-lg py-2 text-[13px] font-medium text-white transition ${
                !server.enabled
                  ? "cursor-not-allowed bg-gray-300 text-white/80"
                  : "bg-[#00a1d6] hover:opacity-90 disabled:opacity-40"
              }`}
              disabled={!server.enabled || !isNative || selectedSessions.length === 0 || validating}
            >
              {!server.enabled ? "服务当前不可用" : isNative ? "开始自动抢" : "自动抢仅支持客户端"}
            </button>
          )}
        </div>

        {/* 扫描结果 */}
        <div className="rounded-xl bg-white p-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">进行中的天选/红包</span>
            <span className="text-[10px] text-black/35">{visibleResults.length} 个</span>
          </div>
          {visibleResults.length === 0 ? (
            <p className="text-[11px] text-black/40 py-3 text-center">
              {results.length === 0 ? "暂未扫描到达到阈值的天选/红包" : "当前筛选条件下没有正在进行的天选/红包"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleResults.map((item) => {
                const ended = item.endTime * 1000 <= serverNowMs;
                const leftSec = Math.max(0, Math.round((item.endTime * 1000 - serverNowMs) / 1000));
                const battery = item.kind === "red_pocket" && (item.rpType === 3 || item.rpType === 5);
                const kindIcon = item.kind === "lottery" ? "/tianxuan.png" : battery ? "/gift-battery.avif" : "/red_pocket.png";
                const kindLabel = item.kind === "lottery" ? "天选" : battery ? "电池红包" : "红包";
                const won = ended ? winRecordFor(item) : undefined;
                return (
                  <div key={item.key} className="rounded-lg border border-black/5 p-2 space-y-1">
                    <div
                      className="grid items-center gap-x-1.5"
                      style={{ gridTemplateColumns: "28px 120px minmax(0, 1fr) 46px" }}
                    >
                      {item.face ? (
                        <img src={item.face} alt="" className="h-7 w-7 rounded-full object-cover" />
                      ) : (
                        <div className="h-7 w-7 rounded-full bg-gray-200" />
                      )}
                      <button
                        onClick={() => openBiliLiveRoom(item.roomId)}
                        className="min-w-0 truncate text-left text-[12px] font-medium text-black/80 hover:text-[#00a1d6]"
                      >
                        {item.uname || `#${item.roomId}`}
                      </button>
                      {ended ? (
                        /* 开奖后展示结果：中奖礼物或未中奖 */
                        <div className="flex min-w-0 items-center gap-1.5">
                          <img src={kindIcon} alt={kindLabel} title={kindLabel} className="h-5 w-5 flex-shrink-0 rounded object-cover" />
                          {won ? (
                            <>
                              <span className="min-w-0 truncate text-[11px] font-medium text-green-600">
                                中奖：{won.prizeName}
                                {won.prizeNum > 1 ? ` x${won.prizeNum}` : ""}
                              </span>
                              {won.prizeValue ? (
                                <span className="flex-shrink-0 whitespace-nowrap text-[10px] text-green-600">+{won.prizeValue} 电池</span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-[11px] text-black/35">未中奖</span>
                          )}
                        </div>
                      ) : (
                        /* 礼物信息（天选/电池红包/红包图标 + 奖品 + 金额）作为一组紧挨排列 */
                        <div className="flex min-w-0 items-center gap-1.5">
                          <img
                            src={kindIcon}
                            alt={kindLabel}
                            title={kindLabel}
                            className="h-5 w-5 flex-shrink-0 rounded object-cover"
                          />
                          <span className="min-w-0 truncate text-[11px] text-black/60">
                            {item.kind === "lottery" ? `${item.awardName} x${item.awardNum}` : item.awards?.[0]?.giftName || kindLabel}
                          </span>
                          <span className="flex-shrink-0 whitespace-nowrap text-[10px] text-[#f59e0b]">{item.value} 电池</span>
                        </div>
                      )}
                      {ended ? (
                        <span className="text-right text-[10px] text-black/35">已开奖</span>
                      ) : (
                        <span className={`text-right font-mono text-[12px] ${leftSec <= 60 ? "text-red-500" : "text-black/60"}`}>
                          {formatCountdown(leftSec)}
                        </span>
                      )}
                    </div>
                    {item.requireText && (
                      <div className="flex items-center gap-2 text-[10px] text-black/35">
                        <span className="min-w-0 truncate">{item.requireText}</span>
                      </div>
                    )}
                    {!ended && running && selectedSessions.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {selectedSessions.map((s) => {
                          const st = statusFor(item, s);
                          return (
                            <span
                              key={s.sid}
                              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                st === "joined"
                                  ? "bg-green-100 text-green-600"
                                  : st === "failed"
                                    ? "bg-red-100 text-red-500"
                                    : st === "pending"
                                      ? "bg-blue-100 text-blue-500"
                                      : "bg-black/5 text-black/40"
                              }`}
                            >
                              {s.uname}：{st === "joined" ? "已参与" : st === "failed" ? "失败" : st === "pending" ? "参与中" : "等待"}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 中奖记录 */}
        <div className="rounded-xl bg-white overflow-hidden">
          {/* 用 div 而不是 button：内部还有「刷新」按钮，button 嵌套 button 会导致 hydration 报错 */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => setPrizeCollapsed(!prizeCollapsed)}
            className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-[12px] hover:bg-black/[0.02]"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${prizeCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium">中奖记录</span>
            <span className="text-black/35">{prizeRecords.length} 条</span>
            <span className="text-[#f59e0b]">共 {totalPrizeValue} 电池</span>
            <span className="ml-auto flex items-center gap-1 text-[10px] text-black/30">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void reloadPrizeRecords();
                }}
                className="rounded border border-black/10 px-1.5 py-0.5 hover:bg-black/5"
              >
                刷新
              </button>
              本机长期保存
            </span>
          </div>
          {!prizeCollapsed && (
            <div className="max-h-56 overflow-y-auto border-t border-black/5 px-2.5 py-1.5 space-y-1">
              {prizeGroups.length === 0 ? (
                <p className="text-[10px] text-black/35 py-2 text-center">
                  暂无中奖记录
                </p>
              ) : (
                prizeGroups.map((g) => {
                  const collapsed = collapsedAccounts.has(g.mid);
                  const redFull = g.redToday >= RED_POCKET_DAILY_LIMIT;
                  return (
                    <div key={g.mid} className="overflow-hidden rounded border border-black/5">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleAccountGroup(g.mid)}
                        className={`flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 py-1 text-[11px] ${
                          redFull ? "bg-red-50" : "bg-black/[0.02]"
                        }`}
                      >
                        <svg className={`h-3 w-3 flex-shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className={`font-medium ${redFull ? "text-red-600" : ""}`}>{g.name}</span>
                        <span className={redFull ? "text-red-500" : "text-black/40"}>{g.records.length} 次</span>
                        <span className={redFull ? "text-red-500" : "text-[#f59e0b]"}>共 {g.totalValue} 电池</span>
                        <span className={redFull ? "text-red-500" : "text-black/40"}>红包 {g.redToday} 次</span>
                        {redFull && (
                          <span className="text-[10px] text-red-500">红包日额满，不再抢</span>
                        )}
                      </div>
                      {!collapsed && (
                        <div className="divide-y divide-black/5">
                          {g.records.map((r) => (
                            <div
                              key={r.id}
                              className="grid items-center gap-x-1.5 px-1.5 py-1 text-[11px]"
                              style={{ gridTemplateColumns: "24px minmax(0, 1fr) 72px 100px" }}
                            >
                              {r.prizeImage ? (
                                <img src={r.prizeImage} alt="" className="h-6 w-6 rounded object-cover" />
                              ) : (
                                <div className="h-6 w-6 rounded bg-gray-100" />
                              )}
                              <span className="min-w-0 truncate">
                                <span className="text-[#f59e0b]">{r.prizeName}</span>
                                {r.prizeNum > 1 ? ` x${r.prizeNum}` : ""}
                                {r.prizeValue ? (
                                  <span className="text-black/40"> · {r.prizeValue} 电池</span>
                                ) : null}
                              </span>
                              <span className="text-[10px] tabular-nums text-black/35">
                                {formatWonAt(r.wonAt)}
                              </span>
                              <button
                                onClick={() => openBiliLiveRoom(r.roomId)}
                                className="min-w-0 truncate text-left text-[10px] text-[#00a1d6]"
                              >
                                {r.roomName || `房间 ${r.roomId}`}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* 日志 */}
        <div className="rounded-xl bg-white overflow-hidden">
          <button onClick={() => setLogsCollapsed(!logsCollapsed)} className="flex w-full items-center gap-2 px-2.5 py-2 text-[12px] hover:bg-black/[0.02]">
            <svg className={`w-3.5 h-3.5 transition-transform ${logsCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium">运行日志</span>
            <span className="text-black/35">{logs.length} 条</span>
          </button>
          {!logsCollapsed && (
            <div className="max-h-44 overflow-y-auto border-t border-black/5 px-2.5 py-1.5 space-y-0.5 font-mono text-[10px]">
              {logs.length === 0 ? (
                <p className="text-black/30">暂无日志</p>
              ) : (
                logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.type === "success" ? "text-green-600" : l.type === "warn" ? "text-orange-500" : l.type === "error" ? "text-red-500" : "text-black/45"
                    }
                  >
                    <span className="text-black/30">{l.time}</span> {l.msg}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
