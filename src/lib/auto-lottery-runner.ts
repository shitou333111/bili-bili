"use client";

/**
 * 自动抢天选/红包 —— 后台运行器（模块级单例）
 *
 * 为什么不在组件里：用户要求「开始自动抢后退出页面仍继续运行」。
 * 组件卸载会清掉 setInterval / state，因此把运行状态、长轮询、参与循环都放到模块级单例，
 * 页面只作为视图订阅它。组件卸载不影响运行；只有「停止自动抢」才会终止。
 */

import { useSyncExternalStore } from "react";
import { showToast } from "./toast";
import { getPlatform, type Platform } from "./platform";
import { serverFetch } from "./server-api";
import type { AuthSession } from "./auth/session";
import type { ScanResult } from "./lottery-scan";
import {
  enterRoomWithSession,
  joinLotteryWithSession,
  drawRedPocketWithSession,
  closeRoomPresence,
  hasPresenceForAccount,
  loadPrizeRecords,
  onPrizeRecord,
  isAlreadyJoinedResult,
  RED_POCKET_DAILY_LIMIT,
  type PrizeRecord,
} from "./lottery-client";
import { ensureValidCredentialClient } from "./bilibili/cookie-refresh-client";
import { setAutoLotteryRunning } from "./auto-lottery-status";

/** 倒计时进入该阈值（秒）才建立弹幕在线连接并参与 */
const CONNECT_BEFORE_SEC = 180;
/** 长轮询单次等待上限（略小于 HTTP 客户端超时，保证正常返回） */
const LONG_POLL_TIMEOUT_MS = 20_000;
/** 兜底定时刷新（即使没有变化也重新拉一次元信息） */
const FALLBACK_REFRESH_MS = 5 * 60 * 1000;
/** 运行中检查到期项的间隔 */
const PROCESS_INTERVAL_MS = 3000;

const MIN_VALUE_KEY = "auto_lottery_min_value";
const SELECTED_SIDS_KEY = "auto_lottery_selected_sids";

export type JoinState = "pending" | "joined" | "failed";
export type LogEntry = { time: string; msg: string; type: "info" | "success" | "warn" | "error" };

type ServerSnapshot = {
  enabled: boolean;
  scanning: boolean;
  minValue: number;
  serverNow: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  generation: number;
  results: ScanResult[];
};

export type RunnerState = {
  ready: boolean;
  isNative: boolean;
  running: boolean;
  results: ScanResult[];
  server: {
    enabled: boolean;
    scanning: boolean;
    minValue: number;
    lastScanAt: number | null;
    nextScanAt: number | null;
    offset: number;
    lastFetchAt: number;
  };
  sessions: AuthSession[];
  selectedSids: string[];
  invalidAccounts: Record<string, string>;
  validatedSids: string[];
  validating: boolean;
  joinStates: Record<string, JoinState>;
  logs: LogEntry[];
  prizeRecords: PrizeRecord[];
  minValue: string;
  loading: boolean;
  loadError: string;
};

const initialState: RunnerState = {
  ready: false,
  isNative: false,
  running: false,
  results: [],
  server: {
    enabled: false,
    scanning: false,
    minValue: 50,
    lastScanAt: null,
    nextScanAt: null,
    offset: 0,
    lastFetchAt: 0,
  },
  sessions: [],
  selectedSids: [],
  invalidAccounts: {},
  validatedSids: [],
  validating: false,
  joinStates: {},
  logs: [],
  prizeRecords: [],
  minValue: "50",
  loading: false,
  loadError: "",
};

// ===== 单例状态 =====

let state: RunnerState = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setState(patch: Partial<RunnerState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribeRunner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRunnerState(): RunnerState {
  return state;
}

/** React Hook：订阅后台运行器状态 */
export function useAutoLotteryRunner(): RunnerState {
  return useSyncExternalStore(subscribeRunner, getRunnerState, getRunnerState);
}

// ===== 内部可变引用 =====

let platform: Platform | null = null;
let initPromise: Promise<void> | null = null;
let generation = 0;
let polling = false;
let processing = false;
let processTimer: ReturnType<typeof setInterval> | null = null;
const attempts = new Set<string>();
const inflight = new Set<string>();

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function addLog(msg: string, type: LogEntry["type"] = "info") {
  const next = [...state.logs, { time: timestamp(), msg, type }];
  setState({ logs: next.length > 200 ? next.slice(-200) : next });
}

function readSavedSelection(): string[] | null {
  try {
    const raw = localStorage.getItem(SELECTED_SIDS_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
}

function persistSelection(sids: string[]) {
  try {
    localStorage.setItem(SELECTED_SIDS_KEY, JSON.stringify(sids));
  } catch { /* 忽略 */ }
}

// ===== 初始化 =====

/** 幂等初始化：加载平台、账号、本地配置，并启动长轮询 */
export function initRunner(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const p = await getPlatform();
      platform = p;
      setState({ isNative: !!p.isNative });
    } catch { /* 忽略 */ }

    let minValue = "50";
    try {
      const saved = localStorage.getItem(MIN_VALUE_KEY);
      if (saved) minValue = saved;
    } catch { /* 忽略 */ }
    setState({ minValue });

    // 中奖记录实时更新
    onPrizeRecord((record) => {
      if (state.prizeRecords.some((r) => r.id === record.id)) return;
      const next = [record, ...state.prizeRecords].sort((a, b) => b.wonAt - a.wonAt);
      setState({ prizeRecords: next });
    });

    await reloadSessionsInner(true);
    await reloadPrizeRecordsInner();
    setState({ ready: true });

    void refreshResults(false);
    void pollLoop();
    const list = state.sessions;
    if (list.length > 0) void validateAccounts(list);
    if (state.running) startProcessTimer();
  })();
  return initPromise;
}

// ===== 服务器扫描结果 =====

/** 从服务器拉取最新扫描结果 */
export async function refreshResults(manual = false): Promise<void> {
  setState({ loading: true });
  try {
    const res = await serverFetch<{ code: number; message?: string; data?: ServerSnapshot }>(
      "/api/lottery/scan/results",
    );
    if (res.code !== 0 || !res.data) {
      setState({ loadError: res.message || "读取扫描结果失败", loading: false });
      return;
    }
    const d = res.data;
    generation = d.generation;
    const minV = Math.max(Number(state.minValue) || 0, d.minValue);
    setState({
      results: d.results,
      server: {
        enabled: d.enabled,
        scanning: d.scanning,
        minValue: d.minValue,
        lastScanAt: d.lastScanAt,
        nextScanAt: d.nextScanAt,
        offset: d.serverNow - Date.now(),
        lastFetchAt: Date.now(),
      },
      minValue: String(minV),
      loadError: "",
      loading: false,
    });
    if (manual) addLog("已从服务器刷新扫描列表", "success");
    if (state.running) void processDueItems();
  } catch {
    setState({ loadError: "无法连接服务器，请检查网络或服务器状态", loading: false });
  }
}

/**
 * 长轮询：服务器扫描到新天选/红包时会立即唤醒本次等待，
 * 客户端随即拉取最新列表，实现近实时推送（无需每 5 分钟才更新一次）。
 */
async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    try {
      const since = generation;
      const res = await serverFetch<{
        code: number;
        data?: { generation: number; changed: boolean; serverNow: number };
      }>(`/api/lottery/scan/wait?since=${since}&timeout=${LONG_POLL_TIMEOUT_MS}`, undefined, LONG_POLL_TIMEOUT_MS + 7000);
      if (res.code === 0 && res.data?.changed) {
        await refreshResults(false);
      } else if (Date.now() - state.server.lastFetchAt > FALLBACK_REFRESH_MS) {
        await refreshResults(false);
      }
    } catch {
      // 网络异常 / 长轮询超时：退避后重试，避免刷屏
      await new Promise((r) => setTimeout(r, 15000));
      if (Date.now() - state.server.lastFetchAt > FALLBACK_REFRESH_MS) {
        await refreshResults(false);
      }
    }
  }
}

// ===== 账号 =====

async function reloadSessionsInner(useSaved: boolean): Promise<void> {
  if (!platform) return;
  try {
    const st = await platform.getSessionState();
    const list = st.sessions.filter((s) => s.source !== "server");
    const prev = state.selectedSids;
    let next = prev.filter((sid) => list.some((s) => s.sid === sid));
    if (next.length === 0) {
      const saved = useSaved ? readSavedSelection() : null;
      if (saved) next = saved.filter((sid) => list.some((s) => s.sid === sid));
    }
    if (next.length === 0 && st.currentSid && list.some((s) => s.sid === st.currentSid)) {
      next = [st.currentSid];
    }
    setState({ sessions: list, selectedSids: next });
    if (next.length > 0) persistSelection(next);
  } catch { /* 忽略 */ }
}

/** 重新加载本机已登录账号列表（保留已有选择） */
export async function reloadSessions(): Promise<void> {
  await reloadSessionsInner(false);
  addLog("已重新加载本机账号列表", "info");
  if (state.sessions.length > 0) void validateAccounts(state.sessions);
}

async function validateAccounts(list: AuthSession[]): Promise<Map<string, AuthSession>> {
  const validMap = new Map<string, AuthSession>();
  if (!platform) return validMap;
  setState({ validating: true });
  const invalid: Record<string, string> = {};
  for (const session of list) {
    try {
      const cred = await ensureValidCredentialClient(platform, session);
      if (cred.valid) {
        validMap.set(session.sid, cred.session);
      } else {
        invalid[session.sid] = cred.reason || "登录已失效，请重新扫码登录";
      }
    } catch {
      invalid[session.sid] = "登录校验失败";
    }
  }
  setState({
    invalidAccounts: invalid,
    validatedSids: [...validMap.keys()],
    validating: false,
  });
  return validMap;
}

/** 勾选 / 取消勾选参与账号（自动持久化） */
export function toggleAccount(sid: string) {
  const set = new Set(state.selectedSids);
  if (set.has(sid)) set.delete(sid);
  else set.add(sid);
  const arr = [...set];
  persistSelection(arr);
  setState({ selectedSids: arr });
}

// ===== 最低价值 =====

export function setMinValueInput(v: string) {
  setState({ minValue: v.replace(/[^\d]/g, "") });
}

/** 失焦时按服务器阈值做下限收敛并持久化 */
export function commitMinValue() {
  const min = state.server.minValue;
  const v = Math.max(min, Number(state.minValue) || min);
  setState({ minValue: String(v) });
  try {
    localStorage.setItem(MIN_VALUE_KEY, String(v));
  } catch { /* 忽略 */ }
}

// ===== 参与逻辑 =====

function setJoinState(key: string, value: JoinState) {
  setState({ joinStates: { ...state.joinStates, [key]: value } });
}

/** 该账号今天已中奖的红包次数（B站限制每天 20 次，达到后不再抢红包） */
function redWinsToday(mid: number): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  return state.prizeRecords.filter(
    (r) => r.accountMid === mid && r.kind === "red_pocket" && r.wonAt >= startMs,
  ).length;
}

async function processDueItems(): Promise<void> {
  if (!state.running || processing) return;
  const p = platform;
  if (!p?.isNative) return;
  processing = true;
  try {
    const serverNowMs = Date.now() + state.server.offset;
    const selected = state.sessions.filter((s) => state.selectedSids.includes(s.sid));
    if (selected.length === 0) return;

    for (const item of state.results) {
      const leftMs = item.endTime * 1000 - serverNowMs;
      if (leftMs <= 0 || leftMs > CONNECT_BEFORE_SEC * 1000) continue;
      for (const session of selected) {
        if (state.invalidAccounts[session.sid]) continue;
        // 达到当日红包中奖上限后，该账号不再参与红包（天选不受此限制）
        if (item.kind === "red_pocket" && redWinsToday(session.mid) >= RED_POCKET_DAILY_LIMIT) continue;
        const itemId = item.kind === "lottery" ? item.lotteryId : item.lotId;
        if (!itemId) continue;
        const attemptKey = `${session.sid}:${item.kind}:${itemId}`;
        if (attempts.has(attemptKey) || inflight.has(attemptKey)) continue;
        if (item.value < (Number(state.minValue) || 0)) continue;

        inflight.add(attemptKey);
        const stateKey = `${session.sid}:${item.key}`;
        setJoinState(stateKey, "pending");
        try {
          const presence =
            hasPresenceForAccount(session.sid, item.roomId) ||
            (await enterRoomWithSession(p, session, item.roomId, item.endTime, {
              uname: item.uname,
              anchorUid: item.uid,
              title: item.title,
              prizeValue: item.value,
            }));
          if (!presence) {
            attempts.add(attemptKey);
            setJoinState(stateKey, "failed");
            addLog(`${session.uname} 进入直播间 ${item.uname} 失败`, "warn");
            continue;
          }
          let ok = false;
          let message = "";
          if (item.kind === "lottery" && item.lotteryId) {
            const r = await joinLotteryWithSession(p, session, item.lotteryId, item.roomId);
            ok = r.code === 0;
            message = r.message || r.msg || "";
            const already = !ok && isAlreadyJoinedResult(r);
            if (already) ok = true;
            addLog(
              `${session.uname} 参与天选「${item.awardName}」于 ${item.uname}：${
                ok ? (already ? "已参与" : "成功") : `失败(${message})`
              }`,
              ok ? "success" : "warn",
            );
          } else if (item.kind === "red_pocket" && item.lotId) {
            const r = await drawRedPocketWithSession(p, session, item.roomId, item.lotId, item.uid);
            ok = r.code === 0;
            message = r.message || r.msg || "";
            const already = !ok && isAlreadyJoinedResult(r);
            if (already) ok = true;
            addLog(
              `${session.uname} 参与红包于 ${item.uname}：${ok ? (already ? "已参与" : "成功") : `失败(${message})`}`,
              ok ? "success" : "warn",
            );
          }
          attempts.add(attemptKey);
          setJoinState(stateKey, ok ? "joined" : "failed");
          if (!ok && /登录|凭证|未登录|失效/.test(message)) {
            setState({
              invalidAccounts: { ...state.invalidAccounts, [session.sid]: message || "登录已失效" },
            });
          }
        } catch (e) {
          attempts.add(attemptKey);
          setJoinState(stateKey, "failed");
          addLog(
            `${session.uname} 参与「${item.uname}」异常：${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        } finally {
          inflight.delete(attemptKey);
        }
      }
    }
  } finally {
    processing = false;
  }
}

function startProcessTimer() {
  if (processTimer) return;
  processTimer = setInterval(() => void processDueItems(), PROCESS_INTERVAL_MS);
  void processDueItems();
}

function stopProcessTimer() {
  if (processTimer) {
    clearInterval(processTimer);
    processTimer = null;
  }
}

// ===== 开始 / 停止 =====

export async function startRunner(): Promise<void> {
  if (!platform?.isNative) {
    showToast("自动抢仅支持客户端（Tauri）", "error");
    return;
  }
  const selected = state.sessions.filter((s) => state.selectedSids.includes(s.sid));
  if (selected.length === 0) {
    showToast("请先选择至少一个账号", "error");
    return;
  }
  const valid = await validateAccounts(selected);
  if (valid.size === 0) {
    showToast("所选账号均已失效，请到「帮助」页「添加新账号」重新扫码登录", "error");
    return;
  }
  const invalidSids = selected.filter((s) => !valid.has(s.sid)).map((s) => s.sid);
  if (invalidSids.length > 0) {
    const next = state.selectedSids.filter((sid) => !invalidSids.includes(sid));
    persistSelection(next);
    setState({ selectedSids: next });
  }

  attempts.clear();
  inflight.clear();
  setState({ joinStates: {}, running: true });
  setAutoLotteryRunning(true);
  addLog(`开始自动抢，共 ${valid.size} 个有效账号`, "success");
  if (Object.keys(state.invalidAccounts).length > 0) {
    addLog(`有 ${Object.keys(state.invalidAccounts).length} 个账号登录已失效，已跳过`, "warn");
  }
  startProcessTimer();
}

export function stopRunner(): void {
  setState({ running: false });
  setAutoLotteryRunning(false);
  stopProcessTimer();
  closeRoomPresence();
  addLog("已停止自动抢，并断开所有直播间在线连接", "warn");
  void reloadPrizeRecordsInner();
}

// ===== 中奖记录 =====

async function reloadPrizeRecordsInner(): Promise<void> {
  const all: PrizeRecord[] = [];
  for (const s of state.sessions) {
    const records = await loadPrizeRecords(s);
    all.push(...records);
  }
  all.sort((a, b) => b.wonAt - a.wonAt);
  setState({ prizeRecords: all });
}

/** 重新读取全部账号的中奖记录 */
export async function reloadPrizeRecords(): Promise<void> {
  await reloadPrizeRecordsInner();
}
