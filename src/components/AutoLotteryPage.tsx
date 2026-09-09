"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  checkLottery,
  joinLottery,
  enterRoom,
  calcEndTime,
  filterCloseLotteries,
  fetchRoomInfoByUid,
  loadSavedLotteryRooms,
  saveLotteryRooms,
  type LotteryRoom,
  type LotteryInfo,
  type SavedRoom,
} from "@/lib/lottery-client";
import { showToast } from "@/lib/toast";
import { getPlatform } from "@/lib/platform";

type Props = { onBack: () => void };

type RoomStatus = {
  roomid: number;
  status: "waiting" | "no_lottery" | "has_lottery" | "joined";
  lottery?: LotteryInfo;
  end_time?: number;
};

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type LogEntry = { time: string; msg: string; type: "info" | "success" | "warn" | "error" };
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 打开B站直播间（同主播推荐卡片）：
 * - 优先用 bilibili://live/{roomId} 协议唤起B站APP
 * - 失败则 fallback 到 WebView / 浏览器打开 https://live.bilibili.com/{roomId}
 */
async function openBiliLiveRoom(roomId: number) {
  if (!roomId) {
    showToast("房间号无效");
    return;
  }
  const platform = await getPlatform();
  const appScheme = `bilibili://live/${roomId}`;
  const webUrl = `https://live.bilibili.com/${roomId}`;

  if (platform.isNative) {
    let opened = false;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      try {
        await openUrl(appScheme);
        opened = true;
      } catch {
        try {
          await openUrl(webUrl);
          opened = true;
        } catch { /* ignore */ }
      }
    } catch { /* plugin-opener 不可用，降级到 window.open */ }
    if (opened) return;
  }

  try {
    const schemeWin = window.open(appScheme, "_blank");
    setTimeout(() => {
      try {
        if (schemeWin) {
          schemeWin.location.href = webUrl;
        }
      } catch { /* ignore cross-origin */ }
    }, 1200);
  } catch {
    window.open(webUrl, "_blank");
  }
}

export default function AutoLotteryPage({ onBack }: Props) {
  const [uidInput, setUidInput] = useState("");
  const [rooms, setRooms] = useState<SavedRoom[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [roomStatuses, setRoomStatuses] = useState<Map<number, RoomStatus>>(new Map());
  const [now, setNow] = useState(Date.now());
  const [nextScanAt, setNextScanAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [currentRoom, setCurrentRoom] = useState<number | null>(null);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const intervalsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const runningRef = useRef(false);
  const roomsRef = useRef<SavedRoom[]>([]);
  // 已参与的天选记录（key: roomid）——B站对已参与的天选不再返回，需本地记住以便显示"已参加"
  const joinedRef = useRef<Map<number, { lottery: LotteryInfo; end_time: number }>>(new Map());

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => { const next = [...prev, { time: timestamp(), msg, type }]; return next.length > 200 ? next.slice(-200) : next; });
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const clearAllTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    for (const i of intervalsRef.current) clearInterval(i);
    timersRef.current.clear();
    intervalsRef.current.clear();
  }, []);

  useEffect(() => () => clearAllTimers(), [clearAllTimers]);
  // 倒计时走秒的 now 独立管理：不放入 intervalsRef，避免 stop() 的 clearAllTimers 将其清除导致倒计时定格
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // 启动时从本地文件加载已保存的房间
  useEffect(() => {
    loadSavedLotteryRooms().then((saved) => {
      if (saved.length > 0) {
        setRooms(saved);
        addLog(`从本地加载了 ${saved.length} 个直播间`, "info");
      }
      setRoomsLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 房间变化时自动保存
  useEffect(() => {
    if (roomsLoaded) saveLotteryRooms(rooms);
  }, [rooms, roomsLoaded]);

  const addRoom = useCallback(async () => {
    const input = uidInput.trim();
    if (!input) return;
    const uid = Number(input);
    if (!uid || uid <= 0) { showToast("请输入有效的 UID"); return; }
    if (rooms.some((r) => r.uid === uid)) { showToast("该用户已在列表中"); setUidInput(""); return; }
    setUidInput("");
    addLog(`正在查询 UID ${uid} 的直播间...`, "info");
    const info = await fetchRoomInfoByUid(uid);
    if (!info) { addLog(`UID ${uid} 没有直播间或查询失败`, "warn"); return; }
    const room: SavedRoom = { uid, ...info };
    setRooms((prev) => [...prev, room]);
    addLog(`添加 ${info.uname}（#${info.roomid}）`, "success");
  }, [uidInput, rooms, addLog]);

  const removeRoom = useCallback((uid: number) => {
    setRooms((prev) => prev.filter((r) => r.uid !== uid));
    setRoomStatuses((prev) => { const next = new Map(prev); next.delete(uid); return next; });
  }, []);

  const updateRoomStatus = useCallback((uid: number, status: RoomStatus) => {
    setRoomStatuses((prev) => { const next = new Map(prev); next.set(uid, status); return next; });
  }, []);

  const processLottery = useCallback(async (uid: number, lr: LotteryRoom) => {
    const roomId = lr.roomid;
    const lotteryId = lr.lottery.id;
    const endTs = lr.end_time * 1000;
    // 识别到天选后立即参与抽奖（参与本身不需要在直播间）
    setJoiningId(lotteryId);
    addLog(`参与抽奖 ${lr.lottery.award_name} x${lr.lottery.award_num}（${lr.uname}）`, "info");
    try {
      const result = await joinLottery(lotteryId, roomId);
      if (result.code === 0) {
        addLog(`参与成功: ${lr.lottery.award_name} x${lr.lottery.award_num}`, "success");
        // 记住已参与的天选：B站对已参与的不再返回，重新扫描时据此显示"已参加"
        joinedRef.current.set(roomId, { lottery: lr.lottery, end_time: lr.end_time });
        updateRoomStatus(uid, { roomid: roomId, status: "joined", lottery: lr.lottery, end_time: lr.end_time });
      }
      else addLog(`参与失败: ${result.message || result.msg || "未知错误"}`, "warn");
    } catch (err) { addLog(`参与异常: ${err instanceof Error ? err.message : String(err)}`, "error"); }
    finally { setJoiningId(null); }
    if (!runningRef.current) return;
    // 开奖前3秒进入直播间（开奖时必须在直播间才能中奖）
    const enterAt = endTs - 3000;
    const waitMs = enterAt - Date.now();
    if (waitMs > 0) {
      addLog(`等待 ${Math.round(waitMs / 1000)}s 后进入 ${lr.uname}`, "info");
      await new Promise((r) => setTimeout(r, waitMs));
    }
    if (!runningRef.current) return;
    setCurrentRoom(roomId);
    addLog(`进入直播间 ${lr.uname}（#${roomId}）`, "info");
    try { await enterRoom(roomId); } catch {}
    // 开奖结束3秒后切换到下一个直播间
    const switchWait = endTs + 3000 - Date.now();
    if (switchWait > 0) await new Promise((r) => setTimeout(r, switchWait));
    setCurrentRoom(null);
  }, [addLog, updateRoomStatus]);

  const scanAndProcess = useCallback(async () => {
    const roomList = roomsRef.current;
    // 扫描开始即记下一次刷新时间（每 5 分钟），供停止按钮显示倒计时
    setNextScanAt(Date.now() + 5 * 60 * 1000);
    if (roomList.length === 0) { addLog("暂无房间", "warn"); return; }
    addLog(`扫描 ${roomList.length} 个直播间...`, "info");
    const checks = await Promise.allSettled(roomList.map(async (rm) => {
      try {
        const info = await checkLottery(rm.roomid);
        return { rm, info, err: null };
      } catch (err) {
        return { rm, info: null, err: err instanceof Error ? err.message : String(err) };
      }
    }));
    if (!runningRef.current) return;
    const found: LotteryRoom[] = [];
    let checked = 0, detected = 0, failed = 0;
    for (const c of checks) {
      if (c.status !== "fulfilled") { failed++; continue; }
      const { rm, info, err } = c.value;
      checked++;
      if (err) { failed++; addLog(`${rm.uname}(#${rm.roomid}): 检测失败 ${err}`, "warn"); }
      else if (info) {
        detected++;
        const lr: LotteryRoom = { roomid: rm.roomid, uname: rm.uname, title: rm.title, face: rm.face, online: rm.online, lottery: info, end_time: calcEndTime(info) };
        updateRoomStatus(rm.uid, { roomid: rm.roomid, status: "has_lottery", lottery: info, end_time: lr.end_time });
        found.push(lr);
      } else {
        // 检测不到天选：若此前已参与且未开奖，显示"已参加"并保留礼物/倒计时
        const joined = joinedRef.current.get(rm.roomid);
        if (joined && joined.end_time * 1000 > Date.now()) {
          updateRoomStatus(rm.uid, { roomid: rm.roomid, status: "joined", lottery: joined.lottery, end_time: joined.end_time });
        } else {
          joinedRef.current.delete(rm.roomid);
          updateRoomStatus(rm.uid, { roomid: rm.roomid, status: "no_lottery" });
        }
      }
    }
    addLog(`扫描完成: ${checked}个房间, ${detected}个有天选, ${failed}个失败`, "info");
    const filtered = filterCloseLotteries(found);
    if (found.length - filtered.length > 0) addLog(`过滤掉 ${found.length - filtered.length} 个间隔<6秒的天选`, "info");
    if (filtered.length === 0) addLog("未检测到天选", "info");
    else addLog(`检测到 ${filtered.length} 个天选`, "success");
    for (const lr of filtered) {
      if (!runningRef.current) break;
      const uid = roomList.find((r) => r.roomid === lr.roomid)?.uid ?? 0;
      await processLottery(uid, lr);
    }
  }, [addLog, processLottery, updateRoomStatus]);

  const start = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    setRoomStatuses(new Map());
    addLog("启动自动抢天选", "success");
    const roomList = roomsRef.current;
    addLog(`当前房间数: ${roomList.length}`, "info");
    if (roomList.length === 0) { addLog("请先添加直播间", "warn"); return; }
    addLog(`房间列表: ${roomList.map((r) => `${r.uname}(#${r.roomid})`).join(", ")}`, "info");
    await scanAndProcess();
    const iv = setInterval(() => { if (runningRef.current) scanAndProcess(); }, 5 * 60 * 1000);
    intervalsRef.current.add(iv);
  }, [addLog, scanAndProcess]);

  const stop = useCallback(() => {
    setRunning(false);
    setCurrentRoom(null);
    setJoiningId(null);
    setNextScanAt(null);
    clearAllTimers();
    addLog("已停止", "info");
  }, [clearAllTimers, addLog]);

  const getCountdown = (endTs: number) => formatCountdown(Math.max(0, (endTs * 1000 - now) / 1000));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 py-1">
        <button onClick={() => { stop(); onBack(); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          返回
        </button>
        <span className="text-sm font-semibold">自动抢天选福袋</span>
        {running && <span className="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">运行中</span>}
      </div>

      <div className="rounded-lg border border-[#00a1d6]/20 bg-[#00a1d6]/10 px-3 py-2 text-xs text-[#00a1d6]">
        输入主播 UID 添加，自动检测天选福袋，开奖前进入直播间参与抽奖，房间列表自动保存。这个并不会扫描很多热门直播间然后自动抢天选，那属于灰产。这里的功能只是解决在常看的几个直播间，偶尔忘记参与抽奖的情况。
      </div>

      <div className="flex gap-2">
        <input type="text" value={uidInput} onChange={(e) => setUidInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addRoom(); }}
          placeholder="输入主播 UID，回车添加"
          className="flex-1 rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none focus:border-[#00a1d6]/50 transition" />
        <button onClick={addRoom} disabled={!uidInput.trim()}
          className="rounded-lg border border-[#00a1d6]/30 bg-[#00a1d6]/10 px-3 py-2 text-xs text-[#00a1d6] font-medium hover:bg-[#00a1d6]/20 transition disabled:opacity-40">
          添加
        </button>
      </div>

      {rooms.length > 0 && (
        <div className="space-y-1">
          {rooms.map((r) => {
            const st = roomStatuses.get(r.uid);
            const showLottery = (st?.status === "has_lottery" || st?.status === "joined") && st.lottery && st.end_time;
            const isCurrent = currentRoom === r.roomid;
            return (
              <div key={r.uid} className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-xs transition ${
                isCurrent ? "border-green-300 bg-green-50/50" : "border-black/10"
              }`}>
                <button onClick={() => openBiliLiveRoom(r.roomid)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                  {r.face ? <img src={r.face} alt="" className="w-8 h-8 rounded-full flex-shrink-0" /> : <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />}
                  <span className="text-sm font-medium truncate">{r.uname}</span>
                </button>
                {/* 右侧状态 */}
                {running && st && (
                  <span className="flex items-center gap-2.5 ml-auto flex-shrink-0 text-sm">
                    {st.status === "no_lottery" && <span className="text-black/35">当前无天选</span>}
                    {showLottery && st.lottery && st.end_time && (
                      <>
                        <span className="flex items-center gap-1.5 rounded-full border border-[#00a1d6]/20 bg-[#00a1d6]/10 px-2.5 py-0.5">
                          {st.lottery.award_image && (
                            <img src={st.lottery.award_image} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />
                          )}
                          <span className="text-black/80 font-medium truncate max-w-[8em]">{st.lottery.award_name}</span>
                          <span className="text-orange-500 font-medium">x{st.lottery.award_num}</span>
                        </span>
                        {st.status === "joined" && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                        <span className="text-red-500 font-mono font-bold">{getCountdown(st.end_time)}</span>
                      </>
                    )}
                  </span>
                )}
                {!running && (
                  <button onClick={() => removeRoom(r.uid)} className="text-black/25 hover:text-red-500 transition ml-auto flex-shrink-0">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                )}
                {isCurrent && joiningId && <span className="text-xs text-green-600 flex-shrink-0">抽奖中...</span>}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        {!running ? (
          <button onClick={start} className="flex-1 rounded-xl bg-[#00a1d6] py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50">
            {`开始自动抢（${rooms.length} 个房间）`}
          </button>
        ) : (
          <button onClick={stop} className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-medium text-white hover:opacity-90 transition">
            {`停止${nextScanAt ? `（下次自动抢 ${formatCountdown(Math.max(0, (nextScanAt - now) / 1000))}）` : ""}`}
          </button>
        )}
      </div>

      {logs.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <button onClick={() => setLogsCollapsed(!logsCollapsed)} className="flex items-center gap-1 text-xs font-medium text-black/50 hover:text-black/80 transition">
              <svg className={`w-3.5 h-3.5 transition-transform ${logsCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              运行日志
              <span className="text-black/25">({logs.length})</span>
            </button>
            {!logsCollapsed && (
              <div className="flex gap-2">
                <button onClick={() => { const text = logs.map((l) => `${l.time} ${l.msg}`).join("\n"); navigator.clipboard.writeText(text).then(() => showToast("已复制日志")).catch(() => {}); }}
                  className="text-[10px] text-black/30 hover:text-[#00a1d6] transition">复制</button>
                <button onClick={() => setLogs([])} className="text-[10px] text-black/30 hover:text-black/60 transition">清空</button>
              </div>
            )}
          </div>
          {!logsCollapsed && (
            <div ref={logRef} className="max-h-48 overflow-y-auto rounded-lg border border-black/10 bg-gray-50 p-2 text-[11px] leading-relaxed font-mono space-y-0.5">
              {logs.map((log, i) => (
                <div key={i} className={`${log.type === "success" ? "text-green-600" : log.type === "warn" ? "text-orange-500" : log.type === "error" ? "text-red-500" : "text-black/50"}`}>
                  <span className="text-black/30">{log.time}</span> {log.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
