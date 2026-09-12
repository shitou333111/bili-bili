"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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
import { pickLargestGift, fetchHotRoomsNative, fetchHotRankListNative, getLotteryBlockedCount, HOT_ROOM_PARTITIONS } from "@/lib/lottery-client";

type Props = { onBack: () => void };

type RedPocketEntry = { info: RedPocketInfo; joined: boolean };

type RoomStatus = {
  roomid: number;
  status: "waiting" | "no_lottery" | "has_lottery" | "joined";
  lottery?: LotteryInfo;
  end_time?: number;
  redPockets?: RedPocketEntry[];
};

type RoomProcessResult = { detectedLottery: boolean; hasRed: boolean; failed: boolean };

/** 热门直播间原始数据（来自服务器 API） */
type HotRoomRaw = {
  roomid: number;
  uid: number;
  title: string;
  uname: string;
  online: number;
  face: string;
  parent_id: number;
  area_id: number;
  area_name: string;
};

/** 分区结果 */
type PartitionResult = { partition: { id: number; name: string }; rooms: HotRoomRaw[] };

/** 保留房间表：roomid -> 所属分区 + 原始数据 */
type RetainedRooms = Map<number, { partitionId: number; raw: HotRoomRaw }>;

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

/** 探测（天选/红包扫描）间隔：10 分钟，从上次探测完成时刻起算 */
const SCAN_INTERVAL_MS = 10 * 60 * 1000;
/** 倒计时进入该阈值（秒）才建立弹幕在线连接并参与抽奖 */
const CONNECT_BEFORE_SEC = 180;
/** 半小时毫秒数：热门列表在每个整点/半点后 1 分钟（北京时间 01 分/31 分）刷新 */
const HALF_HOUR_MS = 30 * 60 * 1000;
/** 刷新点相对整点/半点的偏移：晚 1 分钟（即 01 分、31 分） */
const REFRESH_OFFSET_MS = 60 * 1000;
/** 最低价值设置的本地持久化 key */
const MIN_VALUE_KEY = "auto_lottery_min_value";

/**
 * 下一次列表刷新时间戳（北京时间 01 分/31 分）。
 * 北京时间相对 UTC 为整小时偏移，其"整点/半点"边界与 UTC 的半小时边界重合，
 * 故按绝对时间先取整到最近的 01 分/31 分边界即可，不依赖本地时区/相对倒计时。
 */
function nextHalfHourTs(from = Date.now()): number {
  return Math.floor((from - REFRESH_OFFSET_MS) / HALF_HOUR_MS) * HALF_HOUR_MS + HALF_HOUR_MS + REFRESH_OFFSET_MS;
}

function openBiliLiveRoom(roomId: number) {
  if (!roomId) { showToast("房间号无效"); return; }
  getPlatform().then((platform) => {
    const appScheme = `bilibili://live/${roomId}`;
    const webUrl = `https://live.bilibili.com/${roomId}`;
    if (platform.isNative) {
      import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
        openUrl(appScheme).catch(() => openUrl(webUrl).catch(() => {})),
      ).catch(() => {});
      return;
    }
    window.open(webUrl, "_blank");
  });
}

/** 从原始 API 数据转换为 SavedRoom */
function hotRoomToSaved(r: HotRoomRaw): SavedRoom {
  return { uid: r.uid, roomid: r.roomid, uname: r.uname, title: r.title, face: r.face, online: r.online };
}

/**
 * 合并扫描用房间列表：热门 → 人气 → 保留（已探测到抽奖）→ 指定，按 roomid 去重。
 * 保留房间即使掉出热门列表也会留在扫描列表中，直到探测不到任何天选/红包。
 */
function mergeRoomLists(
  hot: PartitionResult[],
  retained: Iterable<{ raw: HotRoomRaw }>,
  custom: SavedRoom[],
  rank: HotRoomRaw[],
): SavedRoom[] {
  const merged: SavedRoom[] = [];
  const seen = new Set<number>();
  const push = (r: SavedRoom) => { if (seen.has(r.roomid)) return; seen.add(r.roomid); merged.push(r); };
  for (const p of hot) for (const r of p.rooms) push(hotRoomToSaved(r));
  for (const r of rank) push(hotRoomToSaved(r));
  for (const e of retained) push(hotRoomToSaved(e.raw));
  for (const r of custom) push(r);
  return merged;
}

export default function AutoLotteryPage({ onBack }: Props) {
  // 初始即展示全部分区（0 个直播间），刷新列表后再填充各分区直播间
  const [hotPartitions, setHotPartitions] = useState<PartitionResult[]>(
    () => HOT_ROOM_PARTITIONS.map((p) => ({ partition: p, rooms: [] })),
  );
  const [hotRankRooms, setHotRankRooms] = useState<HotRoomRaw[]>([]);
  const [hotRankDrawerOpen, setHotRankDrawerOpen] = useState(false);
  const [expandedPartitions, setExpandedPartitions] = useState<Set<number>>(new Set());
  const [loadingHotRooms, setLoadingHotRooms] = useState(false);
  // ===== 自定义房间（UID） =====
  const [uidInput, setUidInput] = useState("");
  const [customRooms, setCustomRooms] = useState<SavedRoom[]>([]);
  const [customRoomsLoaded, setCustomRoomsLoaded] = useState(false);
  const [customDrawerOpen, setCustomDrawerOpen] = useState(false);
  // ===== 阈值 =====
  const [minValue, setMinValue] = useState(0);
  const [minValueLoaded, setMinValueLoaded] = useState(false);
  // ===== 运行状态 =====
  const [roomStatuses, setRoomStatuses] = useState<Map<number, RoomStatus>>(new Map());
  const [now, setNow] = useState(Date.now());
  const [nextScanAt, setNextScanAt] = useState<number | null>(null);
  const [nextListRefreshAt, setNextListRefreshAt] = useState<number | null>(null);
  /** 已探测到有进行中天选/红包的保留房间（掉出热门列表也保留，直到无抽奖） */
  const [retainedRooms, setRetainedRooms] = useState<RetainedRooms>(new Map());
  const [running, setRunning] = useState(false);
  const [presenceRooms, setPresenceRooms] = useState<Set<number>>(new Set());
  const [processingRoom, setProcessingRoom] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(true);
  const [expandedUids, setExpandedUids] = useState<Set<number>>(new Set());

  const logRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const intervalsRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
  const roomTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const roomsInFlightRef = useRef<Set<number>>(new Set());
  const processRoomRef = useRef<(session: number, room: SavedRoom) => Promise<unknown>>(async () => {});
  const runningRef = useRef(false);
  const roomsRef = useRef<SavedRoom[]>([]);
  const scanningRef = useRef(false);
  const joinedRef = useRef<Map<number, { lottery: LotteryInfo; end_time: number }>>(new Map());
  const joinedLotteriesRef = useRef<Map<number, number>>(new Map());
  const joinedRedPocketsRef = useRef<Map<number, RedPocketInfo>>(new Map());
  const statusesRef = useRef<Map<number, RoomStatus>>(new Map());
  const sessionRef = useRef(0);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  /** 探测函数自身的引用，供探测完成后重新排期下一次探测 */
  const scanAndProcessRef = useRef<((session: number) => Promise<void>) | null>(null);
  /** 列表刷新排期函数引用（自我排期，需用 ref 规避 useCallback 循环依赖） */
  const scheduleListRefreshRef = useRef<(() => void) | null>(null);
  /** 自定义房间的实时引用，供 start 合并房间列表时使用 */
  const customRoomsRef = useRef<SavedRoom[]>([]);
  /** 人气直播间的实时引用，供 start 合并房间列表时使用 */
  const hotRankRoomsRef = useRef<HotRoomRaw[]>([]);
  /** 房间元信息（roomid -> 所属热门分区/原始数据），探测到抽奖时据此登记保留 */
  const hotRoomMetaRef = useRef<Map<number, { partitionId: number; raw: HotRoomRaw }>>(new Map());
  /** 保留房间表的实时引用（仅供回调内读写，渲染用 retainedRooms state） */
  const retainedRoomsRef = useRef<RetainedRooms>(new Map());

  // ===== 合并房间列表（热门 + 人气 + 保留 + 指定，按 roomid 去重） =====
  const allRooms = useMemo(
    () => mergeRoomLists(hotPartitions, retainedRooms.values(), customRooms, hotRankRooms),
    [hotPartitions, customRooms, retainedRooms, hotRankRooms],
  );

  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { roomsRef.current = allRooms; }, [allRooms]);
  useEffect(() => { customRoomsRef.current = customRooms; }, [customRooms]);
  useEffect(() => { hotRankRoomsRef.current = hotRankRooms; }, [hotRankRooms]);
  // 记录热门/人气房间所属分区/原始数据，探测到抽奖时据此登记保留
  useEffect(() => {
    const map = new Map<number, { partitionId: number; raw: HotRoomRaw }>();
    for (const p of hotPartitions) for (const r of p.rooms) map.set(r.roomid, { partitionId: p.partition.id, raw: r });
    for (const r of hotRankRooms) if (!map.has(r.roomid)) map.set(r.roomid, { partitionId: r.parent_id, raw: r });
    hotRoomMetaRef.current = map;
  }, [hotPartitions, hotRankRooms]);

  const isSession = (session: number) => runningRef.current && sessionRef.current === session;
  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => { const next = [...prev, { time: timestamp(), msg, type }]; return next.length > 200 ? next.slice(-200) : next; });
  }, []);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  const clearAllTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    for (const i of intervalsRef.current) clearInterval(i);
    for (const t of roomTimersRef.current.values()) clearTimeout(t);
    for (const t of joinTimersRef.current.values()) clearTimeout(t);
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    if (listRefreshTimerRef.current) { clearTimeout(listRefreshTimerRef.current); listRefreshTimerRef.current = null; }
    timersRef.current.clear();
    intervalsRef.current.clear();
    roomTimersRef.current.clear();
    joinTimersRef.current.clear();
    roomsInFlightRef.current.clear();
  }, []);

  useEffect(() => () => { clearAllTimers(); closeRoomPresence(); }, [clearAllTimers]);
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  // 加载自定义房间
  useEffect(() => {
    loadSavedLotteryRooms().then((saved) => {
      if (saved.length > 0) {
        setCustomRooms(saved);
        addLog(`从本地加载了 ${saved.length} 个指定直播间`, "info");
      }
      setCustomRoomsLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (customRoomsLoaded) saveLotteryRooms(customRooms); }, [customRooms, customRoomsLoaded]);

  // 最低价值：启动时读取本地保存的值，修改后写回，下次启动自动应用
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MIN_VALUE_KEY);
      if (raw != null) setMinValue(Math.max(0, Number(raw) || 0));
    } catch { /* ignore */ }
    setMinValueLoaded(true);
  }, []);
  useEffect(() => {
    if (!minValueLoaded) return;
    try { localStorage.setItem(MIN_VALUE_KEY, String(minValue)); } catch { /* ignore */ }
  }, [minValue, minValueLoaded]);

  // ===== 热门列表获取（仅客户端支持） =====
  const fetchHotRooms = useCallback(async (): Promise<PartitionResult[] | null> => {
    setLoadingHotRooms(true);
    addLog("正在获取热门直播间列表...", "info");
    try {
      const platform = await getPlatform();
      if (!platform.isNative) {
        addLog("该功能仅支持客户端", "warn");
        return null;
      }
      // 客户端直连 B站 API（绕过服务器 IP 风控）
      const partitions = await fetchHotRoomsNative();
      setHotPartitions(partitions);
      const total = partitions.reduce((s, p) => s + p.rooms.length, 0);
      addLog(`获取到 ${partitions.length} 个分区，共 ${total} 个直播间`, "success");
      // 人气直播间（getHotRankList，单次请求）
      const rank = await fetchHotRankListNative();
      hotRankRoomsRef.current = rank;
      setHotRankRooms(rank);
      addLog(`获取到 ${rank.length} 个人气直播间`, "success");
      return partitions;
    } catch (err) {
      addLog(`获取热门列表异常: ${err instanceof Error ? err.message : String(err)}`, "error");
      return null;
    } finally {
      setLoadingHotRooms(false);
    }
  }, [addLog]);

  /** 按北京时间 01 分/31 分排期下一次列表刷新（仅更新列表，不触发探测） */
  const scheduleListRefresh = useCallback(() => {
    if (listRefreshTimerRef.current) clearTimeout(listRefreshTimerRef.current);
    const nextTs = nextHalfHourTs();
    setNextListRefreshAt(nextTs);
    listRefreshTimerRef.current = setTimeout(() => {
      listRefreshTimerRef.current = null;
      if (!runningRef.current) return;
      void fetchHotRooms().then(() => {
        if (runningRef.current) scheduleListRefreshRef.current?.();
      });
    }, Math.max(0, nextTs - Date.now()));
  }, [fetchHotRooms]);
  useEffect(() => { scheduleListRefreshRef.current = scheduleListRefresh; }, [scheduleListRefresh]);

  // ===== 自定义房间操作 =====
  const addRoom = useCallback(async () => {
    const input = uidInput.trim();
    if (!input) return;
    const uid = Number(input);
    if (!uid || uid <= 0) { showToast("请输入有效的 UID"); return; }
    if (customRooms.some((r) => r.uid === uid)) { showToast("该用户已在列表中"); setUidInput(""); return; }
    setUidInput("");
    addLog(`正在查询 UID ${uid} 的直播间...`, "info");
    const info = await fetchRoomInfoByUid(uid);
    if (!info) { addLog(`UID ${uid} 没有直播间或查询失败`, "warn"); return; }
    const room: SavedRoom = { uid, ...info };
    setCustomRooms((prev) => [...prev, room]);
    addLog(`添加 ${info.uname}（#${info.roomid}）`, "success");
  }, [uidInput, customRooms, addLog]);

  const removeRoom = useCallback((uid: number) => {
    const target = roomsRef.current.find((r) => r.uid === uid);
    if (target) {
      const t = roomTimersRef.current.get(target.roomid);
      if (t) { clearTimeout(t); roomTimersRef.current.delete(target.roomid); }
      roomsInFlightRef.current.delete(target.roomid);
    }
    setCustomRooms((prev) => prev.filter((r) => r.uid !== uid));
    const next = new Map(statusesRef.current);
    next.delete(uid);
    statusesRef.current = next;
    setRoomStatuses(next);
  }, []);

  // ===== 核心逻辑 =====
  const updateRoomStatus = useCallback((uid: number, patch: Partial<RoomStatus> & { roomid: number }) => {
    const next = new Map(statusesRef.current);
    const old = next.get(uid);
    next.set(uid, { ...(old ?? {}), ...patch } as RoomStatus);
    statusesRef.current = next;
    setRoomStatuses(next);
  }, []);

  const toggleExpanded = useCallback((uid: number) => {
    setExpandedUids((prev) => { const next = new Set(prev); if (next.has(uid)) next.delete(uid); else next.add(uid); return next; });
  }, []);

  const connectRoom = useCallback(async (room: SavedRoom, latestEnd: number) => {
    const hadPresence = hasRoomPresence(room.roomid);
    const ok = await enterRoom(room.roomid, latestEnd);
    if (!hadPresence) addLog(ok ? `已在直播间保持在线: ${room.uname}` : `建立连接失败: ${room.uname}`, ok ? "success" : "warn");
    if (ok) setPresenceRooms((prev) => { if (prev.has(room.roomid)) return prev; const next = new Set(prev); next.add(room.roomid); return next; });
  }, [addLog]);

  const cancelRoomTimer = useCallback((roomid: number) => {
    const t = roomTimersRef.current.get(roomid);
    if (t) { clearTimeout(t); roomTimersRef.current.delete(roomid); }
  }, []);

  const scheduleRoomTimer = useCallback((session: number, room: SavedRoom, delaySec: number) => {
    cancelRoomTimer(room.roomid);
    const t = setTimeout(() => {
      roomTimersRef.current.delete(room.roomid);
      if (!runningRef.current || sessionRef.current !== session) return;
      void processRoomRef.current(session, room);
    }, Math.max(0, delaySec * 1000));
    roomTimersRef.current.set(room.roomid, t);
  }, [cancelRoomTimer]);

  const processRoom = useCallback(async (session: number, rm: SavedRoom): Promise<RoomProcessResult | null> => {
    if (!isSession(session)) return null;
    if (roomsInFlightRef.current.has(rm.roomid)) return null;
    roomsInFlightRef.current.add(rm.roomid);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const [lc, rc] = await Promise.allSettled([checkLottery(rm.roomid), checkRedPocket(rm.roomid)]);
      if (!isSession(session)) return null;
      const rawInfo = lc.status === "fulfilled" ? lc.value : null;
      const rawReds: RedPocketInfo[] = rc.status === "fulfilled" ? rc.value : [];
      const failed = lc.status === "rejected";

      let lottery: LotteryInfo | undefined;
      let lotteryEnd = 0;
      if (rawInfo) {
        const joinedInfo = joinedRef.current.get(rm.roomid);
        const isJoined = rawInfo.status !== 1;
        const end = (isJoined && joinedInfo?.end_time) || calcEndTime(rawInfo);
        if (end > nowSec) {
          lottery = rawInfo; lotteryEnd = end;
          joinedRef.current.set(rm.roomid, { lottery: rawInfo, end_time: end });
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
      const lotteryJoined = !!lottery && joinedLotteriesRef.current.get(rm.roomid) === lottery.id;
      const activeReds = rawReds.filter((rp) => rp.end_time > nowSec);
      updateRoomStatus(rm.uid, {
        roomid: rm.roomid,
        status: lottery ? (lotteryJoined ? "joined" : "has_lottery") : "no_lottery",
        lottery,
        end_time: lottery ? lotteryEnd : undefined,
        redPockets: activeReds.map((info) => ({ info, joined: joinedRedPocketsRef.current.has(info.lot_id) || info.user_status === 1 })),
      });

      let latestEnd = lotteryEnd;
      for (const rp of activeReds) latestEnd = Math.max(latestEnd, rp.end_time);
      const lotteryInWindow = !!lottery && lotteryEnd - nowSec < CONNECT_BEFORE_SEC;
      const anyRedInWindow = activeReds.some((rp) => rp.end_time - nowSec < CONNECT_BEFORE_SEC);

      if (latestEnd > nowSec) {
        if (hasRoomPresence(rm.roomid)) {
          await enterRoom(rm.roomid, latestEnd);
        } else if (lotteryInWindow || anyRedInWindow) {
          cancelRoomTimer(rm.roomid);
          await connectRoom(rm, latestEnd);
        }
      }

      if (lottery && lottery.status === 1 && !lotteryJoined && lotteryInWindow) {
        const info = lottery;
        setProcessingRoom(rm.roomid);
        addLog(`参与抽奖 ${info.award_name} x${info.award_num}（${rm.uname}）`, "info");
        try {
          const result = await joinLottery(info.id, rm.roomid);
          if (result.code === 0) {
            addLog(`参与成功: ${info.award_name} x${info.award_num}`, "success");
            joinedRef.current.set(rm.roomid, { lottery: info, end_time: lotteryEnd });
            joinedLotteriesRef.current.set(rm.roomid, info.id);
            updateRoomStatus(rm.uid, { roomid: rm.roomid, status: "joined", lottery: info, end_time: lotteryEnd });
          } else {
            addLog(`参与失败: ${result.message || result.msg || "未知错误"}`, "warn");
          }
        } catch (err) {
          addLog(`参与异常: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally { setProcessingRoom(null); }
      }

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
            addLog(`红包参与失败: ${(result as { message?: string }).message || "未知错误"}`, "warn");
          }
        } catch (err) {
          addLog(`红包参与异常: ${err instanceof Error ? err.message : String(err)}`, "error");
        } finally { setProcessingRoom(null); }
      }
      updateRoomStatus(rm.uid, {
        roomid: rm.roomid,
        redPockets: activeReds.map((info) => ({ info, joined: joinedRedPocketsRef.current.has(info.lot_id) || info.user_status === 1 })),
      });

      if (latestEnd > nowSec) {
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

  useEffect(() => { processRoomRef.current = processRoom; }, [processRoom]);

  const scanAndProcess = useCallback(async (session: number) => {
    if (scanningRef.current) return;
    if (!isSession(session)) return;
    scanningRef.current = true;
    setScanning(true);
    const roomList = roomsRef.current;
    try {
      if (roomList.length === 0) { addLog("暂无房间", "warn"); return; }
      addLog(`扫描 ${roomList.length} 个直播间...`, "info");
      const blockedBefore = getLotteryBlockedCount();
      let detected = 0, failed = 0, redRooms = 0;
      // 保留/释放的决策，扫描结束后统一应用
      const toRetain = new Map<number, { partitionId: number; raw: HotRoomRaw }>();
      const toDrop: number[] = [];
      for (const rm of roomList) {
        if (!isSession(session)) break;
        const res = await processRoom(session, rm);
        if (!res) continue;
        if (res.detectedLottery) detected++;
        if (res.hasRed) redRooms++;
        if (res.failed) failed++;
        // 保留已探测到有抽奖的房间（即使掉出热门列表），直到没有任何天选/红包
        if (res.failed) continue;
        const current = retainedRoomsRef.current;
        if (res.detectedLottery || res.hasRed) {
          const meta = hotRoomMetaRef.current.get(rm.roomid) ?? current.get(rm.roomid);
          if (meta) toRetain.set(rm.roomid, meta);
        } else if (current.has(rm.roomid)) {
          toDrop.push(rm.roomid);
        }
      }
      if (toRetain.size > 0 || toDrop.length > 0) {
        const next = new Map(retainedRoomsRef.current);
        for (const [id, meta] of toRetain) next.set(id, meta);
        for (const id of toDrop) next.delete(id);
        retainedRoomsRef.current = next;
        setRetainedRooms(next);
      }
      if (isSession(session)) {
        setPresenceRooms(new Set(roomList.filter((rm) => hasRoomPresence(rm.roomid)).map((rm) => rm.roomid)));
        addLog(`扫描完成: ${roomList.length}个房间, ${detected}个有天选, ${redRooms}个有红包, ${failed}个失败`, "info");
        const blocked = getLotteryBlockedCount() - blockedBefore;
        if (blocked > 0) addLog(`天选接口触发风控限流 -352 ${blocked} 次，已自动降速冷却`, "warn");
      }
    } finally {
      scanningRef.current = false;
      setScanning(false);
      // 探测完成后才开始计时，并自排期下一次探测（间隔 10 分钟）
      if (isSession(session)) {
        setNextScanAt(Date.now() + SCAN_INTERVAL_MS);
        if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
        scanTimerRef.current = setTimeout(() => {
          scanTimerRef.current = null;
          void scanAndProcessRef.current?.(sessionRef.current);
        }, SCAN_INTERVAL_MS);
      }
    }
  }, [addLog, processRoom]);
  useEffect(() => { scanAndProcessRef.current = scanAndProcess; }, [scanAndProcess]);

  // ===== 清理过期的 join 定时器（开奖后移除） =====
  const cleanupStaleTimers = useCallback(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [roomid, t] of joinTimersRef.current) {
      const st = statusesRef.current.get(roomid);
      if (!st?.lottery || (st.end_time ?? 0) <= nowSec) {
        clearTimeout(t);
        joinTimersRef.current.delete(roomid);
      }
    }
  }, []);

  // ===== 启动 =====
  const start = useCallback(async () => {
    if (runningRef.current) { addLog("已在运行中", "warn"); return; }
    sessionRef.current += 1;
    scanningRef.current = false;
    const session = sessionRef.current;
    setRunning(true);
    runningRef.current = true;
    setLogs([]);
    setRoomStatuses(new Map());
    statusesRef.current = new Map();
    setExpandedUids(new Set());
    setPresenceRooms(new Set());
    setProcessingRoom(null);
    setNextScanAt(null);
    setNextListRefreshAt(null);
    joinedRef.current.clear();
    joinedLotteriesRef.current.clear();
    joinedRedPocketsRef.current.clear();
    addLog("启动自动抢天选和红包", "success");

    // 获取热门列表
    const partitions = await fetchHotRooms();
    if (!isSession(session)) return;
    if (partitions) {
      const meta = new Map<number, { partitionId: number; raw: HotRoomRaw }>();
      for (const p of partitions) for (const r of p.rooms) meta.set(r.roomid, { partitionId: p.partition.id, raw: r });
      for (const r of hotRankRoomsRef.current) if (!meta.has(r.roomid)) meta.set(r.roomid, { partitionId: r.parent_id, raw: r });
      hotRoomMetaRef.current = meta;
    }
    // 同步重建房间列表（state 更新是异步的），确保首次探测能拿到房间
    const roomList = mergeRoomLists(partitions ?? [], retainedRoomsRef.current.values(), customRoomsRef.current, hotRankRoomsRef.current);
    roomsRef.current = roomList;
    addLog(`当前房间数: ${roomList.length}`, "info");
    if (roomList.length === 0) addLog("暂无直播间", "warn");

    // 列表刷新按北京时间 01 分/31 分自排期（不触发探测）
    scheduleListRefresh();
    // 每分钟清理过期的 join 定时器
    const cleanupIv = setInterval(cleanupStaleTimers, 60_000);
    intervalsRef.current.add(cleanupIv);
    // 立即探测一次（探测完成后自动排期下一次）
    await scanAndProcess(session);
  }, [addLog, scanAndProcess, fetchHotRooms, cleanupStaleTimers, scheduleListRefresh]);

  // ===== 停止 =====
  const stop = useCallback(() => {
    sessionRef.current += 1;
    setRunning(false);
    runningRef.current = false;
    setNextScanAt(null);
    setNextListRefreshAt(null);
    setPresenceRooms(new Set());
    setProcessingRoom(null);
    scanningRef.current = false;
    closeRoomPresence();
    clearAllTimers();
    addLog("已停止", "info");
  }, [clearAllTimers, addLog]);

  // ===== 手动刷新探测：立即触发一次扫描（结束后重新开始 10 分钟倒计时，不更新直播间列表） =====
  const refreshScanNow = useCallback(async () => {
    if (!runningRef.current || scanningRef.current) return;
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    setNextScanAt(null);
    await scanAndProcess(sessionRef.current);
  }, [scanAndProcess]);

  // ===== 手动刷新列表：重新抓取各分区直播间列表，并按北京时间 01 分/31 分重排下次刷新（不触发探测） =====
  // 注意：这里只更新 hotPartitions/房间列表，不调用 closeRoomPresence、不清空定时器，
  // 已建立的弹幕在场连接（presenceMap，模块级、按 roomId 管理）保持不断开。
  const refreshListNow = useCallback(async () => {
    if (!runningRef.current) return;
    if (listRefreshTimerRef.current) { clearTimeout(listRefreshTimerRef.current); listRefreshTimerRef.current = null; }
    await fetchHotRooms();
    if (runningRef.current) scheduleListRefresh();
  }, [fetchHotRooms, scheduleListRefresh]);

  const getCountdown = (endTs: number) => formatCountdown(Math.max(0, (endTs * 1000 - now) / 1000));

  /** 该房间当前是否有进行中的天选或红包（用于分区列表只显示有抽奖的直播间） */
  const roomHasLottery = (uid: number) => {
    const st = roomStatuses.get(uid);
    if (!st) return false;
    if (st.lottery && (st.end_time ?? 0) * 1000 > now) return true;
    return (st.redPockets ?? []).some((e) => e.info.end_time * 1000 > now);
  };

  // ===== 渲染辅助 =====
  type DisplayItem =
    | { kind: "lottery"; lottery: LotteryInfo; end_time: number; joined: boolean }
    | { kind: "red"; entry: RedPocketEntry };

  const renderBadge = (item: DisplayItem) => {
    if (item.kind === "lottery") {
      return (
        <span className="flex items-center gap-1.5 rounded-full border border-[#00a1d6]/20 bg-[#00a1d6]/10 px-2.5 py-0.5">
          {item.lottery.award_image && <img src={item.lottery.award_image} alt="" className="w-4 h-4 rounded-sm flex-shrink-0" />}
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

  const renderRoom = (r: SavedRoom) => {
    const st = roomStatuses.get(r.uid);
    const lotteryJoined = st?.status === "joined";
    const isCurrent = presenceRooms.has(r.roomid);
    const isExpanded = expandedUids.has(r.uid);
    const visibleReds = (st?.redPockets ?? []).filter((e) => e.info.end_time * 1000 > now).sort((a, b) => a.info.end_time - b.info.end_time);
    const items: DisplayItem[] = [];
    if (st?.lottery) items.push({ kind: "lottery", lottery: st.lottery, end_time: st.end_time ?? 0, joined: lotteryJoined });
    for (const e of visibleReds) items.push({ kind: "red", entry: e });
    const totalCount = items.length;
    const itemJoined = (item: DisplayItem) => item.kind === "lottery" ? item.joined : item.entry.joined;
    const itemCountdown = (item: DisplayItem) => item.kind === "lottery" ? getCountdown(item.end_time) : getCountdown(item.entry.info.end_time);

    return (
      <div key={r.uid} className={`rounded-lg border bg-white text-xs transition ${isCurrent ? "border-green-300 bg-green-50/50" : "border-black/10"}`}>
        <div className="flex items-center gap-3 px-3 py-2">
          <button onClick={() => openBiliLiveRoom(r.roomid)} className="flex items-center gap-2 min-w-0 flex-shrink-0 text-left">
            {r.face ? <img src={r.face} alt="" className="w-7 h-7 rounded-full flex-shrink-0" /> : <div className="w-7 h-7 rounded-full bg-gray-200 flex-shrink-0" />}
            <span className="font-medium truncate max-w-[8em]">{r.uname}</span>
          </button>
          {running && st ? (
            totalCount > 1 ? (
              <>
                <button onClick={() => toggleExpanded(r.uid)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
                  {renderBadge(items[0])}
                  {itemJoined(items[0]) && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                  <span className="text-red-500 font-mono font-bold">{itemCountdown(items[0])}</span>
                  <span className="flex-shrink-0 ml-auto grid place-items-center rounded-full bg-[#00a1d6]/10 text-[#00a1d6] font-bold min-w-[1.5rem] h-6 px-1.5 text-xs">{totalCount}</span>
                </button>
                <button onClick={() => toggleExpanded(r.uid)} className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-lg text-black/50 hover:text-black/90 hover:bg-black/5 transition">
                  <svg className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                </button>
              </>
            ) : (
              <span className="flex items-center gap-2 ml-auto flex-shrink-0">
                {totalCount === 0 && <span className="text-black/35">没有天选红包</span>}
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
            <button onClick={() => removeRoom(r.uid)} className="text-black/25 hover:text-red-500 transition ml-auto flex-shrink-0">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          )}
          {processingRoom === r.roomid && <span className="text-xs text-green-600 flex-shrink-0">抽奖中...</span>}
        </div>
        {isExpanded && totalCount > 1 && (
          <div className="space-y-1 border-t border-black/5 px-3 py-2">
            {items.slice(1).map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {renderBadge(item)}
                {itemJoined(item) && <span className="text-green-600 font-medium flex-shrink-0">已参加</span>}
                <span className="text-red-500 font-mono font-bold">{itemCountdown(item)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /** 人气直播间中当前有天选/红包的（仅这些用于展示） */
  const visibleRankRooms = hotRankRooms.filter((r) => roomHasLottery(r.uid));

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
        自动扫描各分区热门直播间，检测天选福袋和红包，开奖前自动进入直播间参与。支持按奖品价值阈值过滤。
      </div>

      {/* 阈值设置 */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-black/50">最低价值（电池）:</span>
        <input type="number" min={0} value={minValue} onChange={(e) => setMinValue(Math.max(0, Number(e.target.value)))}
          className="w-20 rounded-lg border border-black/15 bg-white px-2 py-1 text-sm outline-none focus:border-[#00a1d6]/50 transition" />
        <span className="text-black/35">总价值低于此值的天选/红包不显示</span>
      </div>

      {/* 按钮行 */}
      <div className="flex gap-2">
        {!running ? (
          <button onClick={start} disabled={loadingHotRooms}
            className="flex-1 rounded-xl bg-[#00a1d6] py-2.5 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50">
            {loadingHotRooms ? "获取列表中..." : "自动抢天选/红包"}
          </button>
        ) : (
          <>
            <button onClick={stop} className="flex-1 h-10 flex items-center justify-center whitespace-nowrap rounded-xl bg-red-500 text-xs font-medium text-white hover:opacity-90 transition">
              停止
            </button>
            <button onClick={refreshListNow} disabled={loadingHotRooms}
              className="flex-1 h-10 flex items-center justify-center whitespace-nowrap rounded-xl border border-black/15 bg-black/[0.03] text-xs font-medium text-black/70 hover:bg-black/[0.06] transition disabled:opacity-50">
              {loadingHotRooms ? "刷新中..." : `刷新列表${nextListRefreshAt ? `（${formatCountdown(Math.max(0, (nextListRefreshAt - now) / 1000))}）` : ""}`}
            </button>
            <button onClick={refreshScanNow} disabled={scanning}
              className="flex-1 h-10 flex items-center justify-center whitespace-nowrap rounded-xl border border-[#00a1d6]/30 bg-[#00a1d6]/10 text-xs font-medium text-[#00a1d6] hover:bg-[#00a1d6]/20 transition disabled:opacity-50">
              {scanning ? "探测中..." : `刷新探测${nextScanAt ? `（${formatCountdown(Math.max(0, (nextScanAt - now) / 1000))}）` : ""}`}
            </button>
          </>
        )}
      </div>

      {/* 直播间分类：指定 / 人气 / 热门分区，合并为一个整体，仅用横线分隔 */}
      <div className="rounded-lg border border-black/10 bg-white overflow-hidden divide-y divide-black/10">
        {/* 指定直播间抽屉（置顶） */}
        <div>
          <button onClick={() => setCustomDrawerOpen(!customDrawerOpen)}
            className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-black/[0.02] transition">
            <span className="flex items-center gap-2">
              <svg className={`w-3.5 h-3.5 transition-transform ${customDrawerOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
              <span className="font-medium">指定直播间</span>
              <span className="text-black/35">{customRooms.length}个</span>
            </span>
          </button>
          {customDrawerOpen && (
            <div className="space-y-2 border-t border-black/5 px-3 py-2">
              <div className="flex gap-2">
                <input type="text" value={uidInput} onChange={(e) => setUidInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addRoom(); }}
                  placeholder="输入主播 UID"
                  className="flex-1 rounded-lg border border-black/15 bg-white px-3 py-1.5 text-sm outline-none focus:border-[#00a1d6]/50 transition" />
                <button onClick={addRoom} disabled={!uidInput.trim()}
                  className="rounded-lg border border-[#00a1d6]/30 bg-[#00a1d6]/10 px-3 py-1.5 text-xs text-[#00a1d6] font-medium hover:bg-[#00a1d6]/20 transition disabled:opacity-40">
                  添加
                </button>
              </div>
              <div className="space-y-1">
                {customRooms.map((r) => renderRoom(r))}
              </div>
            </div>
          )}
        </div>

        {/* 人气直播间抽屉（指定直播间下方）：来自 getHotRankList，仅显示有天选/红包的直播间 */}
        <div>
          <button onClick={() => setHotRankDrawerOpen(!hotRankDrawerOpen)}
            className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-black/[0.02] transition">
            <span className="flex items-center gap-2">
              <svg className={`w-3.5 h-3.5 transition-transform ${hotRankDrawerOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
              <span className="font-medium">人气直播间</span>
              <span className="text-black/35">{hotRankRooms.length}个直播间</span>
              {visibleRankRooms.length > 0 && <span className="text-[#00a1d6] font-medium">{visibleRankRooms.length}个有抽奖</span>}
            </span>
          </button>
          {hotRankDrawerOpen && (
            <div className="space-y-1 border-t border-black/5 px-2 py-2 max-h-[60vh] overflow-y-auto">
              {visibleRankRooms.length === 0 ? (
                <div className="px-3 py-2 text-xs text-black/35">{hotRankRooms.length === 0 ? "未获取到直播间" : "暂无天选/红包"}</div>
              ) : (
                visibleRankRooms.map((r) => renderRoom(hotRoomToSaved(r)))
              )}
            </div>
          )}
        </div>

        {/* 热门分区抽屉：显示全部分区（便于确认分区是否抓取成功），
            分区内只显示有天选或红包的直播间；pr.rooms 完整列表保留用于定时扫描 */}
        {hotPartitions.map((pr) => {
          // 分区内合并「保留房间」（已探测到抽奖但掉出热门列表的），再只显示有抽奖的
          const prRooms = [...pr.rooms];
          const prSeen = new Set(prRooms.map((r) => r.roomid));
          for (const e of retainedRooms.values()) {
            if (e.partitionId === pr.partition.id && !prSeen.has(e.raw.roomid)) prRooms.push(e.raw);
          }
          const visibleRooms = prRooms.filter((r) => roomHasLottery(r.uid));
          const isOpen = expandedPartitions.has(pr.partition.id);
          return (
            <div key={pr.partition.id}>
              <button onClick={() => setExpandedPartitions((prev) => { const next = new Set(prev); if (next.has(pr.partition.id)) next.delete(pr.partition.id); else next.add(pr.partition.id); return next; })}
                className="flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-black/[0.02] transition">
                <span className="flex items-center gap-2">
                  <svg className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                  <span className="font-medium">{pr.partition.name}</span>
                  <span className="text-black/35">{prRooms.length}个直播间</span>
                  {visibleRooms.length > 0 && <span className="text-[#00a1d6] font-medium">{visibleRooms.length}个有抽奖</span>}
                </span>
              </button>
              {isOpen && (
                <div className="space-y-1 border-t border-black/5 px-2 py-2 max-h-[60vh] overflow-y-auto">
                  {visibleRooms.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-black/35">{prRooms.length === 0 ? "未获取到直播间" : "暂无天选/红包"}</div>
                  ) : (
                    visibleRooms.map((r) => renderRoom(hotRoomToSaved(r)))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 日志 */}
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
