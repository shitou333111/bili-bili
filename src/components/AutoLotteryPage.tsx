"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { showToast } from "@/lib/toast";
import { getPlatform, type Platform } from "@/lib/platform";
import { serverFetch } from "@/lib/server-api";
import type { AuthSession } from "@/lib/auth/session";
import type { ScanResult } from "@/lib/lottery-scan";
import {
  enterRoomWithSession,
  joinLotteryWithSession,
  drawRedPocketWithSession,
  closeRoomPresence,
  hasPresenceForAccount,
  loadPrizeRecords,
  type PrizeRecord,
} from "@/lib/lottery-client";
import { ensureValidCredentialClient } from "@/lib/bilibili/cookie-refresh-client";

type Props = { onBack: () => void };

/** 客户端每 5 分钟自动从服务器刷新一次扫描结果 */
const AUTO_REFRESH_MS = 5 * 60 * 1000;
/** 倒计时进入该阈值（秒）才建立弹幕在线连接并参与 */
const CONNECT_BEFORE_SEC = 180;

const MIN_VALUE_KEY = "auto_lottery_min_value";

type LogEntry = { time: string; msg: string; type: "info" | "success" | "warn" | "error" };
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

type ServerSnapshot = {
  enabled: boolean;
  scanning: boolean;
  minValue: number;
  serverNow: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  results: ScanResult[];
};

type JoinState = "pending" | "joined" | "failed";

export default function AutoLotteryPage({ onBack }: Props) {
  const platformRef = useRef<Platform | null>(null);
  const [isNative, setIsNative] = useState(false);

  // ===== 服务器扫描结果 =====
  const [results, setResults] = useState<ScanResult[]>([]);
  const [serverEnabled, setServerEnabled] = useState(false);
  const [serverScanning, setServerScanning] = useState(false);
  const [serverMin, setServerMin] = useState(50);
  const [serverLastScanAt, setServerLastScanAt] = useState<number | null>(null);
  const [serverNextScanAt, setServerNextScanAt] = useState<number | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [lastFetchAt, setLastFetchAt] = useState<number>(() => Date.now());

  // ===== 最低价值筛选 =====
  const [minValueInput, setMinValueInput] = useState("0");

  // ===== 账号 =====
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [selectedSids, setSelectedSids] = useState<Set<string>>(new Set());
  const [invalidAccounts, setInvalidAccounts] = useState<Map<string, string>>(new Map());
  const [validatedSids, setValidatedSids] = useState<Set<string>>(new Set());
  const [validating, setValidating] = useState(false);

  // ===== 运行状态 =====
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [joinStates, setJoinStates] = useState<Map<string, JoinState>>(new Map());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  const [prizeRecords, setPrizeRecords] = useState<PrizeRecord[]>([]);
  const [prizeCollapsed, setPrizeCollapsed] = useState(false);

  const runningRef = useRef(false);
  const resultsRef = useRef<ScanResult[]>([]);
  const sessionsRef = useRef<AuthSession[]>([]);
  const selectedSidsRef = useRef<Set<string>>(new Set());
  const offsetRef = useRef(0);
  const minValueRef = useRef(0);
  const attemptsRef = useRef<Set<string>>(new Set());
  const inflightRef = useRef<Set<string>>(new Set());
  const invalidSidsRef = useRef<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);
  const lastFetchRef = useRef(0);

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => {
      const next = [...prev, { time: timestamp(), msg, type }];
      return next.length > 200 ? next.slice(-200) : next;
    });
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    selectedSidsRef.current = selectedSids;
  }, [selectedSids]);
  useEffect(() => {
    offsetRef.current = serverOffset;
  }, [serverOffset]);
  useEffect(() => {
    minValueRef.current = Number(minValueInput) || 0;
  }, [minValueInput]);

  // ===== 初始化：平台、账号、本地最低价值 =====
  useEffect(() => {
    (async () => {
      const platform = await getPlatform();
      platformRef.current = platform;
      setIsNative(!!platform.isNative);
      try {
        const state = await platform.getSessionState();
        const list = state.sessions.filter((s) => s.source !== "server");
        setSessions(list);
        if (state.currentSid && list.some((s) => s.sid === state.currentSid)) {
          setSelectedSids(new Set([state.currentSid]));
        }
      } catch { /* 忽略 */ }
      try {
        const saved = localStorage.getItem(MIN_VALUE_KEY);
        if (saved) {
          setMinValueInput(saved);
        }
      } catch { /* 忽略 */ }
    })();
  }, []);

  // ===== 刷新服务器扫描结果 =====
  const fetchResults = useCallback(
    async (manual = false) => {
      setLoading(true);
      try {
        const res = await serverFetch<{ code: number; message?: string; data?: ServerSnapshot }>(
          "/api/lottery/scan/results",
        );
        if (res.code !== 0 || !res.data) {
          setLoadError(res.message || "读取扫描结果失败");
          return;
        }
        const d = res.data;
        setLoadError("");
        setResults(d.results);
        setServerEnabled(d.enabled);
        setServerScanning(d.scanning);
        setServerMin(d.minValue);
        setServerLastScanAt(d.lastScanAt);
        setServerNextScanAt(d.nextScanAt);
        setServerOffset(d.serverNow - Date.now());
        setLastFetchAt(Date.now());
        lastFetchRef.current = Date.now();
        // 页面最低价值不得低于服务器扫描阈值
        setMinValueInput((prev) => String(Math.max(Number(prev) || 0, d.minValue)));
        if (manual) addLog("已从服务器刷新扫描列表", "success");
      } catch {
        setLoadError("无法连接服务器，请检查网络或服务器状态");
      } finally {
        setLoading(false);
      }
    },
    [addLog],
  );

  useEffect(() => {
    const t = setTimeout(() => void fetchResults(), 0);
    return () => clearTimeout(t);
  }, [fetchResults]);

  // 自动刷新：每 5 分钟从服务器拉取一次；手动刷新会重置计时
  useEffect(() => {
    if (lastFetchRef.current === 0) lastFetchRef.current = Date.now();
    const iv = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastFetchRef.current >= AUTO_REFRESH_MS) {
        void fetchResults();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [fetchResults]);

  // ===== 账号有效性校验 =====
  const validateAccounts = useCallback(async (list: AuthSession[]): Promise<Map<string, AuthSession>> => {
    const validMap = new Map<string, AuthSession>();
    const platform = platformRef.current;
    if (!platform) return validMap;
    setValidating(true);
    const invalid = new Map<string, string>();
    for (const session of list) {
      try {
        const cred = await ensureValidCredentialClient(platform, session);
        if (cred.valid) {
          validMap.set(session.sid, cred.session);
        } else {
          invalid.set(session.sid, cred.reason || "登录已失效，请重新扫码登录");
        }
      } catch {
        invalid.set(session.sid, "登录校验失败");
      }
    }
    setInvalidAccounts(invalid);
    setValidatedSids(new Set(validMap.keys()));
    setValidating(false);
    return validMap;
  }, []);

  const selectedSessions = useMemo(
    () => sessions.filter((s) => selectedSids.has(s.sid)),
    [sessions, selectedSids],
  );

  // 账号列表就绪后主动校验一次，及时发现过期账号并提示
  useEffect(() => {
    if (sessions.length === 0) return;
    const t = setTimeout(() => void validateAccounts(sessions), 0);
    return () => clearTimeout(t);
  }, [sessions, validateAccounts]);

  const toggleAccount = (sid: string) => {
    setSelectedSids((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });
  };

  // ===== 抢奖逻辑 =====
  const processDueItems = useCallback(async () => {
    if (!runningRef.current) return;
    const platform = platformRef.current;
    if (!platform?.isNative) return;
    const serverNowMs = Date.now() + offsetRef.current;
    const list = resultsRef.current;
    const selected = sessionsRef.current.filter((s) => selectedSidsRef.current.has(s.sid));
    if (selected.length === 0) return;

    for (const item of list) {
      const leftMs = item.endTime * 1000 - serverNowMs;
      // 仅在开奖前 3 分钟内参与，避免过早建连
      if (leftMs <= 0 || leftMs > CONNECT_BEFORE_SEC * 1000) continue;
      for (const session of selected) {
        if (invalidSidsRef.current.has(session.sid)) continue;
        const itemId = item.kind === "lottery" ? item.lotteryId : item.lotId;
        if (!itemId) continue;
        const attemptKey = `${session.sid}:${item.kind}:${itemId}`;
        if (attemptsRef.current.has(attemptKey) || inflightRef.current.has(attemptKey)) continue;
        // 奖品价值阈值（页面筛选）
        if (item.value < minValueRef.current) continue;

        inflightRef.current.add(attemptKey);
        const stateKey = `${session.sid}:${item.key}`;
        setJoinStates((prev) => new Map(prev).set(stateKey, "pending"));
        try {
          const presence = hasPresenceForAccount(session.sid, item.roomId)
            || (await enterRoomWithSession(platform, session, item.roomId, item.endTime, {
              uname: item.uname,
              anchorUid: item.uid,
              title: item.title,
            }));
          if (!presence) {
            attemptsRef.current.add(attemptKey);
            setJoinStates((prev) => new Map(prev).set(stateKey, "failed"));
            addLog(`${session.uname} 进入直播间 ${item.uname} 失败`, "warn");
            continue;
          }
          let ok = false;
          let message = "";
          if (item.kind === "lottery" && item.lotteryId) {
            const r = await joinLotteryWithSession(platform, session, item.lotteryId, item.roomId);
            ok = r.code === 0;
            message = r.message || r.msg || "";
            addLog(
              `${session.uname} 参与天选「${item.awardName}」于 ${item.uname}：${ok ? "成功" : `失败(${message})`}`,
              ok ? "success" : "warn",
            );
          } else if (item.kind === "red_pocket" && item.lotId) {
            const r = await drawRedPocketWithSession(platform, session, item.roomId, item.lotId, item.uid);
            ok = r.code === 0;
            message = r.message || r.msg || "";
            addLog(
              `${session.uname} 参与红包于 ${item.uname}：${ok ? "成功" : `失败(${message})`}`,
              ok ? "success" : "warn",
            );
          }
          attemptsRef.current.add(attemptKey);
          setJoinStates((prev) => new Map(prev).set(stateKey, ok ? "joined" : "failed"));
          if (!ok && /登录|凭证|未登录|失效/.test(message)) {
            setInvalidAccounts((prev) => new Map(prev).set(session.sid, message || "登录已失效"));
          }
        } catch (e) {
          attemptsRef.current.add(attemptKey);
          setJoinStates((prev) => new Map(prev).set(stateKey, "failed"));
          addLog(`${session.uname} 参与「${item.uname}」异常：${e instanceof Error ? e.message : String(e)}`, "error");
        } finally {
          inflightRef.current.delete(attemptKey);
        }
      }
    }
  }, [addLog]);

  // 运行中每 3 秒检查一次到期项
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => void processDueItems(), 3000);
    void processDueItems();
    return () => clearInterval(iv);
  }, [running, processDueItems]);

  // 新结果到达时立即检查
  useEffect(() => {
    if (runningRef.current) void processDueItems();
  }, [results, processDueItems]);

  const reloadPrizeRecords = useCallback(async () => {
    const list = sessionsRef.current;
    const all: PrizeRecord[] = [];
    for (const s of list) {
      const records = await loadPrizeRecords(s);
      all.push(...records);
    }
    all.sort((a, b) => b.wonAt - a.wonAt);
    setPrizeRecords(all);
  }, []);

  // ===== 开始 / 停止 =====
  const start = async () => {
    if (!isNative) {
      showToast("自动抢仅支持客户端（Tauri）", "error");
      return;
    }
    if (selectedSessions.length === 0) {
      showToast("请先选择至少一个账号", "error");
      return;
    }
    // 开始前校验账号，过期账号提示并跳过
    const valid = await validateAccounts(selectedSessions);
    if (valid.size === 0) {
      showToast("所选账号均已失效，请到「帮助」页「添加新账号」重新扫码登录", "error");
      return;
    }
    const invalidSids = new Set(selectedSessions.filter((s) => !valid.has(s.sid)).map((s) => s.sid));
    invalidSidsRef.current = invalidSids;
    if (invalidSids.size > 0) {
      setSelectedSids((prev) => new Set([...prev].filter((sid) => !invalidSids.has(sid))));
    }
    attemptsRef.current.clear();
    inflightRef.current.clear();
    setJoinStates(new Map());
    runningRef.current = true;
    setRunning(true);
    addLog(`开始自动抢，共 ${valid.size} 个有效账号`, "success");
    if (invalidAccounts.size > 0) {
      addLog(`有 ${invalidAccounts.size} 个账号登录已失效，已跳过`, "warn");
    }
    void processDueItems();
  };

  const stop = () => {
    runningRef.current = false;
    setRunning(false);
    closeRoomPresence();
    addLog("已停止自动抢，并断开所有直播间在线连接", "warn");
    // 重新拉取中奖记录
    void reloadPrizeRecords();
  };

  useEffect(() => {
    const t = setTimeout(() => void reloadPrizeRecords(), 0);
    return () => clearTimeout(t);
  }, [sessions, reloadPrizeRecords]);

  // ===== 展示 =====
  const serverNowMs = now + serverOffset;
  const visibleResults = useMemo(() => {
    const min = Number(minValueInput) || 0;
    return results
      .filter((r) => r.endTime * 1000 > serverNowMs)
      .filter((r) => r.value >= min)
      .sort((a, b) => a.endTime - b.endTime);
  }, [results, minValueInput, serverNowMs]);

  const refreshLeftSec = Math.max(0, Math.round((AUTO_REFRESH_MS - (now - lastFetchAt)) / 1000));

  const statusFor = (item: ScanResult, session: AuthSession): JoinState | undefined =>
    joinStates.get(`${session.sid}:${item.key}`);

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
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${serverEnabled ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-500"}`}>
          {serverEnabled ? (serverScanning ? "服务器扫描中" : "服务器扫描运行中") : "服务器扫描未开启"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {/* 说明 + 刷新 */}
        <div className="rounded-xl bg-white p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-black/50">
              列表由服务器统一扫描，客户端只负责参与。每 5 分钟自动刷新。
            </p>
            <button
              onClick={() => void fetchResults(true)}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg border border-black/10 px-2 py-1 text-[11px] text-black/60 hover:bg-black/5 disabled:opacity-40"
            >
              <svg className={loading ? "animate-spin" : ""} width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M14 8a6 6 0 1 1-1.76-4.24M14 2v4h-4" />
              </svg>
              刷新
            </button>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-black/40">
            <span>{refreshLeftSec}s 后自动刷新</span>
            <span>上次扫描：{serverLastScanAt ? new Date(serverLastScanAt).toLocaleTimeString("zh-CN") : "—"}</span>
            {serverEnabled && <span>下一轮：{serverNextScanAt ? new Date(serverNextScanAt).toLocaleTimeString("zh-CN") : "—"}</span>}
          </div>
          {loadError && <p className="text-[11px] text-red-500">{loadError}</p>}
          {!serverEnabled && (
            <p className="text-[11px] text-orange-500">服务器扫描当前未开启，请联系管理员在管理后台开启。</p>
          )}
        </div>

        {/* 账号选择 */}
        <div className="rounded-xl bg-white p-2.5 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">参与账号</span>
            <span className="text-[10px] text-black/35">{selectedSids.size}/{sessions.length} 已选</span>
            <button
              onClick={async () => {
                const platform = platformRef.current;
                if (!platform) return;
                const state = await platform.getSessionState();
                const list = state.sessions.filter((s) => s.source !== "server");
                setSessions(list);
                addLog("已重新加载本机账号列表", "info");
              }}
              className="ml-auto text-[10px] text-[#00a1d6]"
            >
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
                const checked = selectedSids.has(s.sid);
                const invalid = invalidAccounts.get(s.sid);
                return (
                  <div key={s.sid} className="flex items-center gap-2 rounded-lg border border-black/5 px-2 py-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAccount(s.sid)}
                      className="accent-[#00a1d6]"
                    />
                    {s.face ? (
                      <img src={s.face} alt="" className="h-6 w-6 rounded-full object-cover" />
                    ) : (
                      <div className="h-6 w-6 rounded-full bg-gray-200" />
                    )}
                    <span className="min-w-0 truncate text-[11px]">{s.uname}</span>
                    <span className="text-[10px] text-black/30">UID {s.mid}</span>
                    {invalid ? (
                      <span className="ml-auto text-[10px] text-red-500">已失效：{invalid}</span>
                    ) : validatedSids.has(s.sid) ? (
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
            如需添加多个账号，请到「帮助」页「添加新账号」扫码登录（本页不提供登录入口）。
          </p>
          <p className="text-[10px] text-red-500">⚠ 不要使用主播账号抢红包，存在封禁风险。</p>
          {validating && <p className="text-[10px] text-black/40">正在校验账号登录状态…</p>}
        </div>

        {/* 最低价值 + 开始/停止 */}
        <div className="rounded-xl bg-white p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-black/50">自动参与的最低价值</span>
            <input
              value={minValueInput}
              onChange={(e) => setMinValueInput(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={() => {
                const v = Math.max(serverMin, Number(minValueInput) || serverMin);
                setMinValueInput(String(v));
                localStorage.setItem(MIN_VALUE_KEY, String(v));
              }}
              inputMode="numeric"
              className="w-16 rounded-lg border border-black/10 px-2 py-1 text-center text-[12px] outline-none focus:border-[#00a1d6]"
            />
            <span className="text-[10px] text-black/40">电池（单份礼物价值，下限 {serverMin}）</span>
          </div>
          {running ? (
            <button onClick={stop} className="w-full rounded-lg bg-red-500 py-2 text-[13px] font-medium text-white hover:opacity-90">
              停止自动抢
            </button>
          ) : (
            <button
              onClick={start}
              className="w-full rounded-lg bg-[#00a1d6] py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
              disabled={!isNative || selectedSessions.length === 0 || validating}
            >
              {isNative ? "开始自动抢" : "自动抢仅支持客户端"}
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
              {results.length === 0 ? "服务器暂未扫描到达到阈值的天选/红包" : "当前筛选条件下没有正在进行的天选/红包"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {visibleResults.map((item) => {
                const leftSec = Math.max(0, Math.round((item.endTime * 1000 - serverNowMs) / 1000));
                return (
                  <div key={item.key} className="rounded-lg border border-black/5 p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openBiliLiveRoom(item.roomId)} className="flex min-w-0 items-center gap-1.5 text-left">
                        {item.face ? (
                          <img src={item.face} alt="" className="h-7 w-7 rounded-full object-cover" />
                        ) : (
                          <div className="h-7 w-7 rounded-full bg-gray-200" />
                        )}
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-medium text-black/80 hover:text-[#00a1d6]">{item.uname || `#${item.roomId}`}</p>
                          <p className="truncate text-[10px] text-black/35">{item.title || `房间 ${item.roomId}`}</p>
                        </div>
                      </button>
                      <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] ${item.kind === "lottery" ? "bg-[#00a1d6]/10 text-[#00a1d6]" : "bg-[#f59e0b]/15 text-[#b45309]"}`}>
                        {item.kind === "lottery" ? "天选" : "红包"}
                      </span>
                      <span className={`ml-auto flex-shrink-0 font-mono text-[12px] ${leftSec <= 60 ? "text-red-500" : "text-black/60"}`}>
                        {formatCountdown(leftSec)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-black/60">
                        {item.kind === "lottery"
                          ? `${item.awardName} x${item.awardNum}`
                          : `${item.awards?.[0]?.giftName || "红包"} · ${item.awards?.length ?? 0} 种奖品`}
                      </span>
                      <span className="flex-shrink-0 text-[#f59e0b]">{item.value} 电池</span>
                      {item.requireText && (
                        <span className="ml-auto flex-shrink-0 truncate text-[10px] text-black/35">{item.requireText}</span>
                      )}
                    </div>
                    {running && selectedSessions.length > 0 && (
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
          <button
            onClick={() => {
              setPrizeCollapsed(!prizeCollapsed);
              if (prizeCollapsed) void reloadPrizeRecords();
            }}
            className="flex w-full items-center gap-2 px-2.5 py-2 text-[12px] hover:bg-black/[0.02]"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${prizeCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
            </svg>
            <span className="font-medium">中奖记录</span>
            <span className="text-black/35">{prizeRecords.length} 条</span>
            <span className="ml-auto text-[10px] text-black/30">本机长期保存</span>
          </button>
          {!prizeCollapsed && (
            <div className="max-h-56 overflow-y-auto border-t border-black/5 px-2.5 py-1.5 space-y-1">
              {prizeRecords.length === 0 ? (
                <p className="text-[10px] text-black/35 py-2 text-center">
                  暂无中奖记录（开奖时客户端会通过直播弹幕连接自动识别并保存）
                </p>
              ) : (
                prizeRecords.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded border border-black/5 px-1.5 py-1 text-[11px]">
                    {r.prizeImage ? (
                      <img src={r.prizeImage} alt="" className="h-6 w-6 rounded object-cover" />
                    ) : (
                      <div className="h-6 w-6 rounded bg-gray-100" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="text-[#f59e0b]">{r.prizeName}</span>
                        {r.prizeNum > 1 ? ` x${r.prizeNum}` : ""}
                      </p>
                      <p className="truncate text-[10px] text-black/35">
                        {r.accountName}（UID {r.accountMid}）· {new Date(r.wonAt).toLocaleString("zh-CN")}
                      </p>
                    </div>
                    <button
                      onClick={() => openBiliLiveRoom(r.roomId)}
                      className="ml-auto flex-shrink-0 truncate text-[10px] text-[#00a1d6]"
                    >
                      {r.roomName || `房间 ${r.roomId}`}
                    </button>
                  </div>
                ))
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
            <div ref={logRef} className="max-h-44 overflow-y-auto border-t border-black/5 px-2.5 py-1.5 space-y-0.5 font-mono text-[10px]">
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
