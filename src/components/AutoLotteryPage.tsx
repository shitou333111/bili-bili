"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  checkLottery,
  joinLottery,
  enterRoom,
  closeRoomPresence,
  hasRoomPresence,
  calcEndTime,
  checkRedPocket,
  drawRedPocket,
  fetchRoomInfoByUid,
  loadSavedLotteryRooms,
  saveLotteryRooms,
  type LotteryInfo,
  type SavedRoom,
  type RedPocketInfo,
} from "@/lib/lottery-client";
import { showToast } from "@/lib/toast";
import { getPlatform } from "@/lib/platform";
import { pickLargestGift } from "@/lib/lottery-client";

type Props = { onBack: () => void };

type RedPocketEntry = { info: RedPocketInfo; joined: boolean };

type RoomStatus = {
  roomid: number;
  status: "waiting" | "no_lottery" | "has_lottery" | "joined";
  lottery?: LotteryInfo;
  end_time?: number;
  // 红包相关（多个红包各自记录参与状态）
  redPockets?: RedPocketEntry[];
};

/** 单房间处理结果，供扫描汇总统计 */
type RoomProcessResult = { detectedLottery: boolean; hasRed: boolean; failed: boolean };

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

/** 扫描间隔：2 分钟一次，便于更快探测到新出现的天选/红包 */
const SCAN_INTERVAL_MS = 2 * 60 * 1000;
/** 倒计时进入该阈值（秒）才建立弹幕在线连接并参与抽奖 */
const CONNECT_BEFORE_SEC = 180;

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
  // 当前已建立弹幕在线连接的直播间（可多个，支持并行在场）
  const [presenceRooms, setPresenceRooms] = useState<Set<number>>(new Set());
  // 正在参与抽奖的直播间（用于显示"抽奖中..."）
  const [processingRoom, setProcessingRoom] = useState<number | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  // 展开的直播间（天选+红包总数 >1 时显示展开/收起）
  const [expandedUids, setExpandedUids] = useState<Set<number>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const intervalsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  // 每个房间的"到点处理"定时器（key: roomid）：在该房下一个尚未进入窗口的抽奖开奖前 CONNECT_BEFORE_SEC 触发，
  // 独立于 2 分钟扫描——到点即重新检测该房并参与天选/红包、建立在场连接
  const roomTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // 正在处理的房间：避免扫描与到点定时器并发处理同一房间导致重复参与
  const roomsInFlightRef = useRef<Set<number>>(new Set());
  // 到点处理函数引用：scheduleRoomTimer 与 processRoom 相互引用，用 ref 打破循环依赖
  const processRoomRef = useRef<(session: number, room: SavedRoom) => Promise<unknown>>(async () => {});
  const runningRef = useRef(false);
  const roomsRef = useRef<SavedRoom[]>([]);
  // 防止扫描重叠（一轮扫描可能阻塞很久，期间定时器再次触发时跳过）
  const scanningRef = useRef(false);
  // 已参与的天选记录（key: roomid）——B站对已参与的天选不再返回，需本地记住以便显示"已参加"
  const joinedRef = useRef<Map<number, { lottery: LotteryInfo; end_time: number }>>(new Map());
  // 已成功参与的天选 id（key: roomid）——仅由 join 成功响应（或 B站返回 status=2）写入，用于显示"已参加"
  const joinedLotteriesRef = useRef<Map<number, number>>(new Map());
  // 已参与的红包记录（key: lot_id）——重新扫描时避免重复点击参与
  const joinedRedPocketsRef = useRef<Map<number, RedPocketInfo>>(new Map());
  // 房间状态镜像：扫描过程中需要读取上一轮状态做合并，用 ref 保证同步可读
  const statusesRef = useRef<Map<number, RoomStatus>>(new Map());
  // 扫描会话号：start/stop 时会自增，用于隔离被停止/被取代的旧扫描，防止其继续执行或占有扫描锁导致重启无响应
  const sessionRef = useRef(0);

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  // 当前会话是否仍有效（运行中 且 是最新一次 start）
  const isSession = (session: number) => runningRef.current && sessionRef.current === session;

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => { const next = [...prev, { time: timestamp(), msg, type }]; return next.length > 200 ? next.slice(-200) : next; });
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const clearAllTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    for (const i of intervalsRef.current) clearInterval(i);
    for (const t of roomTimersRef.current.values()) clearTimeout(t);
    timersRef.current.clear();
    intervalsRef.current.clear();
    roomTimersRef.current.clear();
    roomsInFlightRef.current.clear();
  }, []);

  useEffect(() => () => { clearAllTimers(); closeRoomPresence(); }, [clearAllTimers]);
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
    const target = roomsRef.current.find((r) => r.uid === uid);
    if (target) {
      const t = roomTimersRef.current.get(target.roomid);
      if (t) { clearTimeout(t); roomTimersRef.current.delete(target.roomid); }
      roomsInFlightRef.current.delete(target.roomid);
    }
    setRooms((prev) => prev.filter((r) => r.uid !== uid));
    const next = new Map(statusesRef.current);
    next.delete(uid);
    statusesRef.current = next;
    setRoomStatuses(next);
  }, []);

  const updateRoomStatus = useCallback((uid: number, patch: Partial<RoomStatus> & { roomid: number }) => {
    const next = new Map(statusesRef.current);
    const old = next.get(uid);
    // 合并：红包/天选各自更新自己的字段，避免相互覆盖
    next.set(uid, { ...(old ?? {}), ...patch } as RoomStatus);
    statusesRef.current = next;
    setRoomStatuses(next);
  }, []);

  const toggleExpanded = useCallback((uid: number) => {
    setExpandedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }, []);

  // 立即为房间建立弹幕在场连接，并同步 UI 状态（幂等：已有连接只会延长 deadline，不会打断）
  const connectRoom = useCallback(async (room: SavedRoom, latestEnd: number) => {
    const hadPresence = hasRoomPresence(room.roomid);
    const ok = await enterRoom(room.roomid, latestEnd);
    if (!hadPresence) {
      addLog(ok ? `已在直播间保持在线（弹幕连接）: ${room.uname}` : `建立弹幕在线连接失败: ${room.uname}`, ok ? "success" : "warn");
    }
    if (ok) {
      setPresenceRooms((prev) => {
        if (prev.has(room.roomid)) return prev;
        const next = new Set(prev);
        next.add(room.roomid);
        return next;
      });
    }
  }, [addLog]);

  const cancelRoomTimer = useCallback((roomid: number) => {
    const t = roomTimersRef.current.get(roomid);
    if (t) { clearTimeout(t); roomTimersRef.current.delete(roomid); }
  }, []);

  // 按该房下一个尚未进入 3 分钟窗口的开奖时间安排"到点处理"：
  // 到点即重新检测该房并立即参与天选/红包、建立/维持在场连接，完全独立于 2 分钟扫描
  const scheduleRoomTimer = useCallback((session: number, room: SavedRoom, delaySec: number) => {
    cancelRoomTimer(room.roomid);
    const t = setTimeout(() => {
      roomTimersRef.current.delete(room.roomid);
      if (!runningRef.current || sessionRef.current !== session) return;
      void processRoomRef.current(session, room);
    }, Math.max(0, delaySec * 1000));
    roomTimersRef.current.set(room.roomid, t);
  }, [cancelRoomTimer]);

  // 处理单个房间：检测天选/红包 -> 参与已进入 3 分钟窗口的 -> 维持在场连接 -> 为下一个尚未进入窗口的开奖安排到点定时器。
  // 既被扫描调用（全量），也被到点定时器调用（单房），因此参与不再依赖扫描周期。
  const processRoom = useCallback(async (session: number, rm: SavedRoom): Promise<RoomProcessResult | null> => {
    if (!isSession(session)) return null;
    // 同一房间同时只允许一个处理流程，避免扫描与到点定时器并发导致重复参与
    if (roomsInFlightRef.current.has(rm.roomid)) return null;
    roomsInFlightRef.current.add(rm.roomid);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const [lc, rc] = await Promise.allSettled([checkLottery(rm.roomid), checkRedPocket(rm.roomid)]);
      if (!isSession(session)) return null;
      const rawInfo = lc.status === "fulfilled" ? lc.value : null;
      const rawReds: RedPocketInfo[] = rc.status === "fulfilled" ? rc.value : [];
      const failed = lc.status === "rejected";

      // ---- 天选：解析仍在进行中的那条（B站对已参与的不再返回，回退到本地记录） ----
      let lottery: LotteryInfo | undefined;
      let lotteryEnd = 0;
      if (rawInfo) {
        const joinedInfo = joinedRef.current.get(rm.roomid);
        const isJoined = rawInfo.status !== 1;
        const end = (isJoined && joinedInfo?.end_time) || calcEndTime(rawInfo);
        if (end > nowSec) {
          lottery = rawInfo; lotteryEnd = end;
          joinedRef.current.set(rm.roomid, { lottery: rawInfo, end_time: end });
          // B站明确返回"已参与"时，同样记为已参加
          if (isJoined) joinedLotteriesRef.current.set(rm.roomid, rawInfo.id);
        } else {
          joinedRef.current.delete(rm.roomid);
          joinedLotteriesRef.current.delete(rm.roomid);
        }
      } else {
        const joined = joinedRef.current.get(rm.roomid);
        if (joined && joined.end_time > nowSec) { lottery = joined.lottery; lotteryEnd = joined.end_time; }
        else { joinedRef.current.delete(rm.roomid); joinedLotteriesRef.current.delete(rm.roomid); }
      }
      // "已参加"只依据 join 成功响应记录（其中 id 与当前天选一致），与倒计时无关
      const lotteryJoined = !!lottery && joinedLotteriesRef.current.get(rm.roomid) === lottery.id;

      // ---- 红包：只保留进行中的，多个红包排队时全部展示 ----
      const activeReds = rawReds.filter((rp) => rp.end_time > nowSec);
      updateRoomStatus(rm.uid, {
        roomid: rm.roomid,
        status: lottery ? (lotteryJoined ? "joined" : "has_lottery") : "no_lottery",
        lottery,
        end_time: lottery ? lotteryEnd : undefined,
        redPockets: activeReds.map((info) => ({
          info,
          joined: joinedRedPocketsRef.current.has(info.lot_id) || info.user_status === 1,
        })),
      });

      // ---- 该房间所有抽奖的最晚开奖时间：在场连接保持到此时刻 ----
      let latestEnd = lotteryEnd;
      for (const rp of activeReds) latestEnd = Math.max(latestEnd, rp.end_time);

      // 倒计时 < 3 分钟才参与抽奖（参与本身不需要在直播间）
      const lotteryInWindow = !!lottery && lotteryEnd - nowSec < CONNECT_BEFORE_SEC;
      const anyRedInWindow = activeReds.some((rp) => rp.end_time - nowSec < CONNECT_BEFORE_SEC);

      // ---- 在场连接：进入 3 分钟窗口立即建连。先建连再参与，保证参与时账号已在直播间在线 ----
      if (latestEnd > nowSec) {
        if (hasRoomPresence(rm.roomid)) {
          // 已有连接：仅延长 deadline 至最新开奖时间（幂等，不打断连接）
          await enterRoom(rm.roomid, latestEnd);
        } else if (lotteryInWindow || anyRedInWindow) {
          cancelRoomTimer(rm.roomid);
          await connectRoom(rm, latestEnd);
        }
      }

      // 天选参与：识别到且进入 3 分钟窗口才自动参与；已参加的不重复参与
      if (lottery && lottery.status === 1 && !lotteryJoined && lotteryInWindow) {
        const info = lottery;
        const end = lotteryEnd;
        setProcessingRoom(rm.roomid);
        addLog(`参与抽奖 ${info.award_name} x${info.award_num}（${rm.uname}）`, "info");
        try {
          const result = await joinLottery(info.id, rm.roomid);
          if (result.code === 0) {
            addLog(`参与成功: ${info.award_name} x${info.award_num}`, "success");
            joinedRef.current.set(rm.roomid, { lottery: info, end_time: end });
            joinedLotteriesRef.current.set(rm.roomid, info.id);
            updateRoomStatus(rm.uid, { roomid: rm.roomid, status: "joined", lottery: info, end_time: end });
          } else {
            addLog(`参与失败: ${result.message || result.msg || "未知错误"}`, "warn");
          }
        } catch (err) {
          addLog(`参与异常: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally { setProcessingRoom(null); }
      }

      // 红包参与：轮到的每个红包都尽早参与
      for (const rp of activeReds) {
        if (!isSession(session)) break;
        if (rp.end_time - nowSec >= CONNECT_BEFORE_SEC) continue;
        if (rp.user_status === 1 || joinedRedPocketsRef.current.has(rp.lot_id)) continue;
        const gift = pickLargestGift(rp.awards);
        const label = gift ? `${gift.gift_name} x${gift.num}` : "红包";
        setProcessingRoom(rm.roomid);
        addLog(`参与红包 ${label}（${rm.uname}）`, "info");
        try {
          const result = await drawRedPocket(rm.roomid, rp.lot_id, rm.uid);
          if (result.code === 0) {
            joinedRedPocketsRef.current.set(rp.lot_id, rp);
            addLog(`红包参与成功: ${label}`, "success");
          } else {
            const msg = (result as { message?: string; msg?: string }).message || (result as { message?: string; msg?: string }).msg || "未知错误";
            addLog(`红包参与失败: ${msg}`, "warn");
          }
        } catch (err) {
          addLog(`红包参与异常: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally { setProcessingRoom(null); }
      }
      // 红包参与状态即时反映到 UI（不必等下一轮扫描）
      updateRoomStatus(rm.uid, {
        roomid: rm.roomid,
        redPockets: activeReds.map((info) => ({
          info,
          joined: joinedRedPocketsRef.current.has(info.lot_id) || info.user_status === 1,
        })),
      });

      // ---- 到点调度：为下一个尚未进入 3 分钟窗口的开奖安排"到点处理"（到点重新检测 -> 立即参与 -> 建连） ----
      if (latestEnd > nowSec) {
        // +1 秒确保定时器在窗口内触发，避免恰好落在边界上导致重复调度
        let nextEnd = Infinity;
        if (lottery && !lotteryJoined && lotteryEnd - nowSec >= CONNECT_BEFORE_SEC) nextEnd = Math.min(nextEnd, lotteryEnd);
        for (const rp of activeReds) if (rp.end_time - nowSec >= CONNECT_BEFORE_SEC) nextEnd = Math.min(nextEnd, rp.end_time);
        if (nextEnd !== Infinity) scheduleRoomTimer(session, rm, nextEnd - CONNECT_BEFORE_SEC - nowSec + 1);
        else cancelRoomTimer(rm.roomid);
      } else {
        cancelRoomTimer(rm.roomid);
      }

      return { detectedLottery: !!lottery, hasRed: activeReds.length > 0, failed };
    } finally {
      roomsInFlightRef.current.delete(rm.roomid);
    }
  }, [addLog, updateRoomStatus, connectRoom, cancelRoomTimer, scheduleRoomTimer]);

  // processRoom 每轮渲染都是新引用，用 ref 保持 scheduleRoomTimer 回调能调用到最新实现
  useEffect(() => { processRoomRef.current = processRoom; }, [processRoom]);

  const scanAndProcess = useCallback(async (session: number) => {
    // 一轮扫描可能较久，避免定时器触发时重叠扫描
    if (scanningRef.current) return;
    if (!isSession(session)) return;
    scanningRef.current = true;
    try {
      const roomList = roomsRef.current;
      // 扫描开始即记下一次刷新时间（每 2 分钟），供停止按钮显示倒计时
      setNextScanAt(Date.now() + SCAN_INTERVAL_MS);
      if (roomList.length === 0) { addLog("暂无房间", "warn"); return; }
      addLog(`扫描 ${roomList.length} 个直播间...`, "info");

      let detected = 0, failed = 0, redRooms = 0;
      // 逐房间处理：检测 + 参与（进入 3 分钟窗口即参与）+ 建连 + 安排该房到点定时器
      for (const rm of roomList) {
        if (!isSession(session)) break;
        const res = await processRoom(session, rm);
        if (!res) continue;
        if (res.detectedLottery) detected++;
        if (res.hasRed) redRooms++;
        if (res.failed) failed++;
      }
      if (isSession(session)) {
        setPresenceRooms(new Set(roomList.filter((rm) => hasRoomPresence(rm.roomid)).map((rm) => rm.roomid)));
        addLog(`扫描完成: ${roomList.length}个房间, ${detected}个有天选, ${redRooms}个有红包, ${failed}个失败`, "info");
      }
    } finally {
      scanningRef.current = false;
    }
  }, [addLog, processRoom]);

  const start = useCallback(async () => {
    if (runningRef.current) { addLog("已在运行中", "warn"); return; }
    // 开启新会话：自增会话号使任何残留的旧扫描立即失效，并释放其可能占用的扫描锁，保证新扫描一定能够启动
    sessionRef.current += 1;
    scanningRef.current = false;
    const session = sessionRef.current;
    setRunning(true);
    runningRef.current = true; // 同步置位，保证紧接着调用 scanAndProcess(session) 时 isSession 能通过（effect 同步有延迟）
    setLogs([]);
    setRoomStatuses(new Map());
    statusesRef.current = new Map();
    setExpandedUids(new Set());
    setPresenceRooms(new Set());
    setProcessingRoom(null);
    joinedRef.current.clear();
    joinedLotteriesRef.current.clear();
    joinedRedPocketsRef.current.clear();
    addLog("启动自动抢天选和红包", "success");
    const roomList = roomsRef.current;
    addLog(`当前房间数: ${roomList.length}`, "info");
    if (roomList.length === 0) { addLog("请先添加直播间", "warn"); return; }
    addLog(`房间列表: ${roomList.map((r) => `${r.uname}(#${r.roomid})`).join(", ")}`, "info");
    // 先建立定时器再跑首次扫描：否则首次扫描阻塞较久时定时器未创建，倒计时归零后不会自动刷新
    const iv = setInterval(() => {
      if (runningRef.current && !scanningRef.current) scanAndProcess(sessionRef.current);
    }, SCAN_INTERVAL_MS);
    intervalsRef.current.add(iv);
    scanAndProcess(session);
  }, [addLog, scanAndProcess]);

  const stop = useCallback(() => {
    // 会话号自增：让正在轮询等待的旧扫描立即失效（即使 runningRef 状态尚未同步，也会因会话不匹配而终止）
    sessionRef.current += 1;
    setRunning(false);
    runningRef.current = false; // 同步置位，即使 effect 尚未运行，旧扫描也会立即终止
    setNextScanAt(null);
    setPresenceRooms(new Set());
    setProcessingRoom(null);
    // 立即释放扫描锁：即使旧扫描仍在轮询等待，也允许立刻重新开始
    scanningRef.current = false;
    // 断开弹幕在场连接（账号不再挂在直播间）
    closeRoomPresence();
    clearAllTimers();
    addLog("已停止", "info");
  }, [clearAllTimers, addLog]);

  // 手动刷新探测：立即扫描一次（等同于 2 分钟自动扫描的手动版）。
  // 重置自动计时，使按钮倒计时与实际自动扫描保持一致；扫描过程只做幂等建连，不会打断已有 WS 连接。
  const refreshNow = useCallback(() => {
    if (!runningRef.current || scanningRef.current) return;
    for (const i of intervalsRef.current) clearInterval(i);
    intervalsRef.current.clear();
    const iv = setInterval(() => {
      if (runningRef.current && !scanningRef.current) scanAndProcess(sessionRef.current);
    }, SCAN_INTERVAL_MS);
    intervalsRef.current.add(iv);
    scanAndProcess(sessionRef.current);
  }, [scanAndProcess]);

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
        输入主播 UID 添加，自动检测天选福袋，开奖前进入直播间参与抽奖。这个并不会扫描很多热门直播间然后自动抢天选，那属于灰产。这里的功能只是解决在常看的几个直播间，偶尔忘记参与抽奖的情况。
      </div>

      <div className="flex gap-2">
        <input type="text" value={uidInput} onChange={(e) => setUidInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addRoom(); }}
          placeholder="输入主播 UID，注意不是房间号"
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
            const showLottery = !!st?.lottery;
            const lotteryJoined = st?.status === "joined";
            const isCurrent = presenceRooms.has(r.roomid);
            const isExpanded = expandedUids.has(r.uid);
            // 展示项：天选（最多1个）+ 未结束红包（按开奖时间升序，最早在最前）
            const visibleReds = (st?.redPockets ?? [])
              .filter((e) => e.info.end_time * 1000 > now)
              .sort((a, b) => a.info.end_time - b.info.end_time);
            type DisplayItem =
              | { kind: "lottery"; lottery: LotteryInfo; end_time: number; joined: boolean }
              | { kind: "red"; entry: (typeof visibleReds)[number] };
            const items: DisplayItem[] = [];
            if (showLottery && st?.lottery) items.push({ kind: "lottery", lottery: st.lottery, end_time: st.end_time ?? 0, joined: lotteryJoined });
            for (const e of visibleReds) items.push({ kind: "red", entry: e });
            const totalCount = items.length;

            const renderBadge = (item: DisplayItem) => {
              if (item.kind === "lottery") {
                return (
                  <span className="flex items-center gap-1.5 rounded-full border border-[#00a1d6]/20 bg-[#00a1d6]/10 px-2.5 py-0.5">
                    {item.lottery.award_image && (
                      <img src={item.lottery.award_image} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />
                    )}
                    <span className="text-black/80 font-medium truncate max-w-[8em]">{item.lottery.award_name}</span>
                    <span className="text-orange-500 font-medium">x{item.lottery.award_num}</span>
                  </span>
                );
              }
              const rp = item.entry;
              const gift = pickLargestGift(rp.info.awards);
              return (
                <span className="flex items-center gap-1.5 rounded-full border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-2.5 py-0.5">
                  {gift?.gift_pic ? (
                    <img src={gift.gift_pic} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />
                  ) : rp.info.icon_url ? (
                    <img src={rp.info.icon_url} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />
                  ) : (
                    <svg className="w-4 h-4 text-orange-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M20 6h-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v12h20V8a2 2 0 0 0-2-2zM9 4h6v2H9V4zm-3 8h3v2H6v-2zm5 0h3v2h-3v-2z"/></svg>
                  )}
                  <span className="text-black/80 font-medium truncate max-w-[8em]">{gift?.gift_name ?? "红包"}</span>
                  {rp.info.rp_type === 3 || rp.info.rp_type === 5 ? (
                    <span className="text-orange-500 font-medium">{Math.round((rp.info.total_price ?? 0) / 100)}/{gift?.num ?? 0}</span>
                  ) : gift ? (
                    <span className="text-orange-500 font-medium">x{gift.num}</span>
                  ) : null}
                </span>
              );
            };
            const itemJoined = (item: DisplayItem) => item.kind === "lottery" ? item.joined : item.entry.joined;
            const itemCountdown = (item: DisplayItem) => item.kind === "lottery" ? getCountdown(item.end_time) : getCountdown(item.entry.info.end_time);

            return (
              <div key={r.uid} className={`rounded-lg border bg-white text-xs transition ${isCurrent ? "border-green-300 bg-green-50/50" : "border-black/10"}`}>
                <div className="flex items-center gap-3 px-3 py-2">
                  {/* 仅头像+昵称可点击跳转直播间 */}
                  <button onClick={() => openBiliLiveRoom(r.roomid)} className="flex items-center gap-2 min-w-0 flex-shrink-0 text-left">
                    {r.face ? <img src={r.face} alt="" className="w-8 h-8 rounded-full flex-shrink-0" /> : <div className="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0" />}
                    <span className="text-sm font-medium truncate">{r.uname}</span>
                  </button>
                  {/* 右侧状态 */}
                  {running && st ? (
                    totalCount > 1 ? (
                      <>
                        {/* 昵称右侧所有空间（含其中元素）点击均为展开/收起 */}
                        <button onClick={() => toggleExpanded(r.uid)} className="flex items-center gap-2.5 min-w-0 flex-1 text-left">
                          {renderBadge(items[0])}
                          {itemJoined(items[0]) && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                          <span className="text-red-500 font-mono font-bold">{itemCountdown(items[0])}</span>
                          {/* 总数（独立于展开图标） */}
                          <span className="flex-shrink-0 ml-auto grid place-items-center rounded-full bg-[#00a1d6]/10 text-[#00a1d6] font-bold min-w-[1.75rem] h-7 px-2 text-sm">{totalCount}</span>
                        </button>
                        {/* 独立展开/收起图标：整行展开、收起的标志，置于最右 */}
                        <button onClick={() => toggleExpanded(r.uid)} className="flex-shrink-0 grid place-items-center w-9 h-9 rounded-lg text-black/50 hover:text-black/90 hover:bg-black/5 transition">
                          <svg className={`w-5 h-5 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                      </>
                    ) : (
                      <span className="flex items-center gap-2.5 ml-auto flex-shrink-0 text-sm">
                        {totalCount === 0 && <span className="text-black/35">当前没天选和红包</span>}
                        {totalCount === 1 && (
                          <>
                            {renderBadge(items[0])}
                            {itemJoined(items[0]) && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                            <span className="text-red-500 font-mono font-bold">{itemCountdown(items[0])}</span>
                          </>
                        )}
                      </span>
                    )
                  ) : (
                    !running && (
                      <button onClick={() => removeRoom(r.uid)} className="text-black/25 hover:text-red-500 transition ml-auto flex-shrink-0">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )
                  )}
                  {processingRoom === r.roomid && <span className="text-xs text-green-600 flex-shrink-0">抽奖中...</span>}
                </div>
                {/* 展开面板：显示后续的红包，每行一个 */}
                {isExpanded && totalCount > 1 && (
                  <div className="space-y-1 border-t border-black/5 px-3 py-2">
                    {items.slice(1).map((item, i) => (
                      <div key={i} className="flex items-center gap-2.5 text-xs">
                        {renderBadge(item)}
                        {itemJoined(item) && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                        <span className="text-red-500 font-mono font-bold">{itemCountdown(item)}</span>
                      </div>
                    ))}
                  </div>
                )}
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
          <>
            <button onClick={stop} className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-medium text-white hover:opacity-90 transition">
              停止
            </button>
            <button onClick={refreshNow} className="flex-1 rounded-xl border border-[#00a1d6]/30 bg-[#00a1d6]/10 py-2.5 text-sm font-medium text-[#00a1d6] hover:bg-[#00a1d6]/20 transition">
              {`刷新探测${nextScanAt ? `（${formatCountdown(Math.max(0, (nextScanAt - now) / 1000))}）` : ""}`}
            </button>
          </>
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
