"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { serverApiUrl, isTauri } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { showToast } from "@/lib/toast";
import type { AdminScanSnapshot } from "@/lib/lottery-scan";
import type { AuthSession } from "@/lib/auth/session";
import { buildCookieHeader, ensureValidCredentialClient } from "@/lib/bilibili/cookie-refresh-client";

/** 管理员请求：附带 X-Admin-Sid（与 admin 页面保持同一套跨源处理） */
function getStoredAdminSid(): string | null {
  try {
    return typeof window !== "undefined" ? localStorage.getItem("bili_live_admin_sid") : null;
  } catch {
    return null;
  }
}

async function adminRequest<T>(path: string, body?: unknown): Promise<T> {
  const url = serverApiUrl(path);
  const sid = getStoredAdminSid();
  const headers: Record<string, string> = {};
  if (sid) headers["X-Admin-Sid"] = sid;
  if (body) headers["Content-Type"] = "application/json";
  const options: RequestInit = { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined };
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const res = await tauriFetch(url, options);
    return (await res.json()) as T;
  }
  const res = await fetch(url, { ...options, credentials: "include", cache: "no-store" });
  return (await res.json()) as T;
}

function fmtTime(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("zh-CN");
}

function fmtCountdown(endSec: number, now: number): string {
  const left = Math.max(0, endSec - Math.floor(now / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function openRoom(roomId: number) {
  if (!roomId) return;
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

export default function LotteryScanAdmin() {
  const [data, setData] = useState<AdminScanSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [minValueInput, setMinValueInput] = useState("50");
  const [intervalMinInput, setIntervalMinInput] = useState("5");
  const [requestIntervalInput, setRequestIntervalInput] = useState("450");
  const [redIntervalInput, setRedIntervalInput] = useState("450");
  const [hotLimitInput, setHotLimitInput] = useState("100");
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [pickingSid, setPickingSid] = useState<string | null>(null);
  const [accountMsg, setAccountMsg] = useState("");
  const [uidInput, setUidInput] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState(true);
  const [expandedResults, setExpandedResults] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const initedRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    try {
      const res = await adminRequest<{ code: number; message?: string; data?: AdminScanSnapshot }>(
        "/api/admin/lottery-scan",
      );
      if (res.code !== 0 || !res.data) {
        setError(res.message || "读取失败");
        return;
      }
      setError("");
      setData(res.data);
      if (!initedRef.current) {
        initedRef.current = true;
        setMinValueInput(String(res.data.config.minValue));
        setIntervalMinInput(String(Math.round(res.data.config.scanIntervalMs / 60000)));
        setRequestIntervalInput(String(res.data.config.requestIntervalMs));
        setRedIntervalInput(String(res.data.config.redIntervalMs));
        setHotLimitInput(String(res.data.config.hotRoomsPerPartition));
      }
    } catch {
      if (!silent) setError("无法连接服务器");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const iv = setInterval(() => void load(true), 15000);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [load]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // 本机已登录账号列表（供管理员选择红包扫描账号）
  const loadSessions = useCallback(async () => {
    try {
      const platform = await getPlatform();
      const state = await platform.getSessionState();
      setSessions(state.sessions.filter((s) => s.source !== "server"));
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void loadSessions(), 0);
    return () => clearTimeout(t);
  }, [loadSessions]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await adminRequest<{ code: number; message?: string; data?: AdminScanSnapshot }>(
          "/api/admin/lottery-scan",
          body,
        );
        if (res.code !== 0 || !res.data) {
          showToast(res.message || "操作失败", "error");
          return false;
        }
        setData(res.data);
        return true;
      } catch {
        showToast("无法连接服务器", "error");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const toggleScan = async () => {
    if (!data) return;
    await post({ action: "setEnabled", enabled: !data.config.enabled });
  };

  const saveConfig = async () => {
    const ok = await post({
      action: "setConfig",
      minValue: Number(minValueInput) || 0,
      scanIntervalMs: Math.max(1, Number(intervalMinInput) || 5) * 60000,
      requestIntervalMs: Number(requestIntervalInput) || 450,
      redIntervalMs: Number(redIntervalInput) || 450,
      hotRoomsPerPartition: Number(hotLimitInput) || 0,
    });
    if (ok) showToast("扫描配置已保存");
  };

  // 从本机已登录账号中挑选一个作为服务器红包扫描账号
  const applyScanAccount = async (session: AuthSession) => {
    setPickingSid(session.sid);
    setAccountMsg("");
    try {
      const platform = await getPlatform();
      const cred = await ensureValidCredentialClient(platform, session);
      if (!cred.valid) {
        setAccountMsg(cred.reason || "该账号登录已失效，请到「帮助」页重新扫码登录");
        return;
      }
      const ok = await post({ action: "setAccount", cookie: buildCookieHeader(cred.session) });
      if (ok) setAccountMsg(`已将 ${cred.session.uname || `UID${cred.session.mid}`} 设为扫描账号`);
    } catch {
      setAccountMsg("设置失败，请稍后重试");
    } finally {
      setPickingSid(null);
    }
  };

  const clearScanAccount = async () => {
    setAccountMsg("");
    const ok = await post({ action: "setAccount", cookie: "" });
    if (ok) setAccountMsg("已清除扫描账号");
  };

  const addRoom = async () => {
    const uid = Number(uidInput.trim());
    if (!uid || uid <= 0) {
      showToast("请输入有效的 UID", "error");
      return;
    }
    const ok = await post({ action: "addRoom", uid });
    if (ok) {
      setUidInput("");
      showToast("已添加指定直播间");
    }
  };

  const removeRoom = async (uid: number) => {
    await post({ action: "removeRoom", uid });
  };

  const config = data?.config;
  const state = data?.state;
  const results = (state?.results ?? []).filter((r) => r.endTime > Math.floor(now / 1000));
  const recentRateLimit = (state?.rateLimitEvents ?? []).filter((e) => now - e.at < 30 * 60 * 1000).reverse();

  return (
    <div className="rounded-xl border border-black/10 bg-white/80 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex min-w-0 items-center gap-1.5 text-sm font-bold hover:opacity-80"
        >
          <svg
            className={`h-3.5 w-3.5 flex-shrink-0 text-black/40 transition-transform ${collapsed ? "" : "rotate-90"}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate">自动抢天选/红包（服务器扫描）</span>
        </button>
        {collapsed && config && (
          <span className="flex-shrink-0 text-[11px] text-black/45">
            已扫描 {(state?.results ?? []).filter((r) => r.endTime > Math.floor(now / 1000)).length} 个进行中
          </span>
        )}
        {config && (
          <button
            onClick={toggleScan}
            disabled={saving}
            className={`ml-auto flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
              config.enabled
                ? "bg-red-500 text-white hover:opacity-90"
                : "bg-[#00a1d6] text-white hover:opacity-90"
            }`}
          >
            {config.enabled ? "停止扫描" : "开始扫描"}
          </button>
        )}
      </div>

      {!collapsed && loading && <p className="text-xs text-black/40">加载中…</p>}
      {!collapsed && error && <p className="text-xs text-red-500">{error}</p>}

      {!collapsed && state && config && (
        <>
          {/* 运行状态 */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-black/[0.03] px-2 py-1.5 text-[11px] text-black/55">
            <span>
              状态：
              <span className={config.enabled ? "text-green-600 font-medium" : "text-black/40"}>
                {config.enabled ? (state.scanning ? "扫描中" : "运行中（等待下一轮）") : "已停止"}
              </span>
            </span>
            {state.scanning && (
              <span>
                进度：{state.progress.done}/{state.progress.total}
                {state.progress.currentRoom ? `（房间 ${state.progress.currentRoom}）` : ""}
              </span>
            )}
            <span>上一轮：{fmtTime(state.lastScanAt)}</span>
            <span>下一轮：{config.enabled ? fmtTime(state.nextScanAt) : "—"}</span>
            {state.lastRound && (
              <span>
                本轮：{state.lastRound.rooms} 房间 / 天选 {state.lastRound.lottery} / 红包 {state.lastRound.red} / 失败{" "}
                {state.lastRound.failed}（{Math.round(state.lastRound.durationMs / 1000)} 秒）
              </span>
            )}
          </div>

          {/* 限流告警 */}
          {recentRateLimit.length > 0 && (
            <div className="rounded-lg border border-orange-300/60 bg-orange-50 p-2 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-orange-600">⚠ 触发限流（近 30 分钟 {recentRateLimit.length} 次）</span>
              </div>
              <div className="space-y-0.5 max-h-28 overflow-y-auto">
                {recentRateLimit.map((ev, i) => (
                  <div key={i} className="text-[10px] text-orange-700/80">
                    {fmtTime(ev.at)} · {ev.endpoint === "lottery" ? "天选" : "红包"}接口 code {ev.code} · 连续第 {ev.streak} 次 ·
                    冷却 {Math.round(ev.cooldownMs / 1000)} 秒 {ev.message ? `· ${ev.message}` : ""}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-orange-700/70">
                已自动指数退避降速。若持续触发，请增大请求间隔（毫秒）后保存。
              </p>
            </div>
          )}

          {/* 阈值与频率 */}
          <div className="rounded-lg border border-black/10 p-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <label className="flex items-center gap-1">
                <span className="text-black/50">单份礼物最低价值</span>
                <input
                  value={minValueInput}
                  onChange={(e) => setMinValueInput(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="w-14 rounded border border-black/10 px-1.5 py-0.5 text-center outline-none focus:border-[#00a1d6]"
                />
                <span className="text-black/40">电池</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-black/50">扫描间隔</span>
                <input
                  value={intervalMinInput}
                  onChange={(e) => setIntervalMinInput(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="w-10 rounded border border-black/10 px-1.5 py-0.5 text-center outline-none focus:border-[#00a1d6]"
                />
                <span className="text-black/40">分钟</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-black/50">天选请求间隔</span>
                <input
                  value={requestIntervalInput}
                  onChange={(e) => setRequestIntervalInput(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="w-14 rounded border border-black/10 px-1.5 py-0.5 text-center outline-none focus:border-[#00a1d6]"
                />
                <span className="text-black/40">ms</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-black/50">红包请求间隔</span>
                <input
                  value={redIntervalInput}
                  onChange={(e) => setRedIntervalInput(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="w-14 rounded border border-black/10 px-1.5 py-0.5 text-center outline-none focus:border-[#00a1d6]"
                />
                <span className="text-black/40">ms</span>
              </label>
              <label className="flex items-center gap-1">
                <span className="text-black/50">每分区热门数</span>
                <input
                  value={hotLimitInput}
                  onChange={(e) => setHotLimitInput(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  className="w-10 rounded border border-black/10 px-1.5 py-0.5 text-center outline-none focus:border-[#00a1d6]"
                />
              </label>
              <button
                onClick={saveConfig}
                disabled={saving}
                className="ml-auto rounded bg-[#00a1d6] px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
              >
                保存配置
              </button>
            </div>
            <p className="text-[10px] text-black/35">
              天选按一份礼物价值、普通礼物红包按最大单个礼物价值、电池红包按单份电池数计算；低于阈值的扫描到也不显示。
            </p>
          </div>

          {/* 扫描账号 */}
          <div className="rounded-lg border border-black/10 p-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium">红包扫描账号</span>
              {config.account ? (
                <span className="text-[10px] text-green-600">
                  {config.account.uname}（UID {config.account.uid}）· {fmtDateTime(Date.parse(config.account.updatedAt))}
                </span>
              ) : (
                <span className="text-[10px] text-orange-500">未配置，红包扫描不可用</span>
              )}
            </div>
            <p className="text-[10px] text-black/40">
              天选扫描匿名完成，无需登录；红包接口必须登录，请从本机已登录账号中选择一个专用小号作为扫描账号（建议不要使用主播账号）。
              如需更多账号，请到「帮助」页「添加新账号」扫码登录。
            </p>
            {state.accountStatus?.valid === false && (
              <p className="text-[10px] text-red-500">⚠ {state.accountStatus.message}</p>
            )}
            {sessions.length === 0 ? (
              <p className="text-[10px] text-black/35">本机暂无已登录账号，请先到「帮助」页「添加新账号」扫码登录</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {sessions.map((s) => {
                  const isCurrent = config.account?.uid === s.mid;
                  return (
                    <button
                      key={s.sid}
                      onClick={() => void applyScanAccount(s)}
                      disabled={saving || pickingSid === s.sid || isCurrent}
                      className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] transition disabled:opacity-60 ${
                        isCurrent
                          ? "border-green-500/40 bg-green-500/10 text-green-600"
                          : "border-black/10 bg-black/[0.02] hover:bg-black/5"
                      }`}
                    >
                      {s.face ? (
                        <img src={s.face} alt="" className="h-4 w-4 rounded-full" />
                      ) : (
                        <span className="h-4 w-4 rounded-full bg-gray-200" />
                      )}
                      <span className="max-w-[9em] truncate">{s.uname || `UID${s.mid}`}</span>
                      {isCurrent && <span className="font-medium">当前</span>}
                      {pickingSid === s.sid && <span className="text-black/40">校验中…</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void loadSessions()}
                disabled={saving}
                className="rounded border border-black/10 px-3 py-1 text-[11px] text-black/60 hover:bg-black/5 disabled:opacity-40"
              >
                刷新账号列表
              </button>
              {config.account && (
                <button
                  onClick={() => void clearScanAccount()}
                  disabled={saving}
                  className="rounded border border-black/10 px-3 py-1 text-[11px] text-black/60 hover:bg-black/5 disabled:opacity-40"
                >
                  清除扫描账号
                </button>
              )}
              {accountMsg && <span className="text-[10px] text-black/45">{accountMsg}</span>}
            </div>
          </div>

          {/* 指定直播间 */}
          <div className="rounded-lg border border-black/10 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium">指定直播间</span>
              <span className="text-[10px] text-black/35">{config.customRooms.length} 个</span>
              <input
                value={uidInput}
                onChange={(e) => setUidInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addRoom();
                }}
                placeholder="输入主播 UID"
                className="ml-auto w-32 rounded border border-black/10 px-2 py-1 text-[11px] outline-none focus:border-[#00a1d6]"
              />
              <button
                onClick={addRoom}
                disabled={saving || !uidInput.trim()}
                className="rounded border border-[#00a1d6]/30 bg-[#00a1d6]/10 px-2.5 py-1 text-[11px] text-[#00a1d6] hover:bg-[#00a1d6]/20 disabled:opacity-40"
              >
                添加
              </button>
            </div>
            {config.customRooms.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {config.customRooms.map((r) => (
                  <span key={r.uid} className="flex items-center gap-1 rounded-full border border-black/10 bg-black/[0.02] px-2 py-0.5 text-[10px]">
                    <button onClick={() => openRoom(r.roomid)} className="hover:text-[#00a1d6]">
                      {r.uname || `UID${r.uid}`}
                    </button>
                    <button onClick={() => removeRoom(r.uid)} className="text-black/30 hover:text-red-500">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 常发红包直播间 */}
          <div className="rounded-lg border border-black/10 overflow-hidden">
            <button
              onClick={() => setExpandedHistory(!expandedHistory)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-black/[0.02]"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${expandedHistory ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium">常发红包的直播间</span>
              <span className="text-black/35">{data?.history.length ?? 0} 个</span>
            </button>
            {expandedHistory && (
              <div className="max-h-52 overflow-y-auto border-t border-black/5 px-2 py-1.5 space-y-1">
                {(data?.history.length ?? 0) === 0 ? (
                  <p className="text-[10px] text-black/35">暂无记录（扫描到达到阈值的红包后会自动登记）</p>
                ) : (
                  data!.history.map((h) => (
                    <div key={h.roomid} className="flex items-center gap-2 text-[11px]">
                      <button onClick={() => openRoom(h.roomid)} className="flex min-w-0 items-center gap-1.5 text-left hover:text-[#00a1d6]">
                        {h.face ? <img src={h.face} alt="" className="h-5 w-5 rounded-full" /> : <div className="h-5 w-5 rounded-full bg-gray-200" />}
                        <span className="truncate max-w-[10em]">{h.uname || `UID${h.uid}`}</span>
                      </button>
                      <span className="ml-auto flex-shrink-0 text-orange-500 font-medium">{h.count} 次</span>
                      <span className="flex-shrink-0 text-black/30">{fmtDateTime(h.lastAt)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 扫描结果 */}
          <div className="rounded-lg border border-black/10 overflow-hidden">
            <button
              onClick={() => setExpandedResults(!expandedResults)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-black/[0.02]"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${expandedResults ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium">扫描结果</span>
              <span className="text-black/35">{results.length} 个进行中</span>
            </button>
            {expandedResults && (
              <div className="max-h-72 overflow-y-auto border-t border-black/5 px-2 py-1.5 space-y-1">
                {results.length === 0 ? (
                  <p className="text-[10px] text-black/35">暂无达到阈值的进行中天选/红包</p>
                ) : (
                  results.map((r) => (
                    <div key={r.key} className="flex items-center gap-2 text-[11px] rounded border border-black/5 px-1.5 py-1">
                      <button onClick={() => openRoom(r.roomId)} className="flex min-w-0 items-center gap-1.5 text-left hover:text-[#00a1d6]">
                        {r.face ? <img src={r.face} alt="" className="h-5 w-5 rounded-full" /> : <div className="h-5 w-5 rounded-full bg-gray-200" />}
                        <span className="truncate max-w-[8em]">{r.uname || `#${r.roomId}`}</span>
                      </button>
                      <span className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] ${r.kind === "lottery" ? "bg-[#00a1d6]/10 text-[#00a1d6]" : "bg-[#f59e0b]/15 text-[#b45309]"}`}>
                        {r.kind === "lottery" ? "天选" : "红包"}
                      </span>
                      <span className="min-w-0 truncate text-black/70">
                        {r.kind === "lottery" ? `${r.awardName} x${r.awardNum}` : `${r.awards?.[0]?.giftName || "红包"} ${r.awards?.length ?? 0} 种`}
                      </span>
                      <span className="flex-shrink-0 text-orange-500">{r.value} 电池</span>
                      <span className="flex-shrink-0 text-red-500 font-mono">{fmtCountdown(r.endTime, now)}</span>
                      <span className="flex-shrink-0 text-black/30">
                        {{ custom: "指定", history: "常发", rank: "人气", hot: "热门" }[r.source]}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 运行日志 */}
          <div className="rounded-lg border border-black/10 overflow-hidden">
            <button onClick={() => setLogOpen(!logOpen)} className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] hover:bg-black/[0.02]">
              <svg className={`w-3.5 h-3.5 transition-transform ${logOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium">扫描日志</span>
              <span className="text-black/35">{state.logs.length} 条</span>
            </button>
            {logOpen && (
              <div className="max-h-44 overflow-y-auto border-t border-black/5 px-2 py-1.5 space-y-0.5 font-mono text-[10px]">
                {[...state.logs].reverse().map((l, i) => (
                  <div key={i} className={l.type === "success" ? "text-green-600" : l.type === "warn" ? "text-orange-500" : l.type === "error" ? "text-red-500" : "text-black/45"}>
                    <span className="text-black/30">{fmtTime(l.at)}</span> {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
