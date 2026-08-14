"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { serverApiUrl, serverFetch } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { fetchMedicalRoomId, fetchMedicalUniversal, fetchMedicalUname } from "@/lib/medical-client";
import { showToast } from "@/lib/toast";

type Member = {
  uid: number;
  uname: string;
  face: string;
  position: number;
  room_id: number;
  price: number; // price/100 后的分数
  exited: boolean;
};

type Props = {
  currentUid: number;
  currentUname: string;
  onBack: () => void;
};

type LocalRecord = {
  recordId: string;
  gameTime: string;
  gameTimeTs: number;
  bizSessionId: string;
  laifuOwnerUid: number;
  laifuOwnerUname: string;
  totalAmount: number;
  perPersonAmount: number;
  recipients: Array<{ uid: number; uname: string; amount: number }>;
};

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 保留 0.1 位 */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * 计算医药费总额：
 * - 打满固定 552
 * - 未打满 = 第二名分数 ÷100 向下取整；当分数 > 10000 时，后 3 位当作 0（如 39282 → 390）
 */
function calcTotal(score: number, dm: boolean): number {
  if (dm) return 552;
  const base = Math.floor(score / 100);
  return score > 10000 ? Math.floor(base / 10) * 10 : base;
}

/** 最多 9 位主播，使用 9 种区分度高的固定颜色 */
const UID_COLORS = [
  "#e74c3c", // 红
  "#2ecc71", // 绿
  "#3498db", // 蓝
  "#f39c12", // 橙
  "#9b59b6", // 紫
  "#1abc9c", // 青
  "#e67e22", // 橙红
  "#2980b9", // 深蓝
  "#16a085", // 深青
];

/** 根据 UID 取一种稳定的徽章背景色 */
function uidColor(uid: number): string {
  return UID_COLORS[Math.abs(uid) % UID_COLORS.length];
}

/** 收款码本地存储路径（Tauri 原生模式） */
async function qrLocalFile(uid: number): Promise<string> {
  const platform = await getPlatform();
  return `${await platform.getDataDir()}/uid_${uid}/qrcode.dataurl`;
}

/** 读取某 UID 的收款码图片源：原生读本地，Web 走服务器 */
async function resolveQrSrc(uid: number): Promise<string | null> {
  const platform = await getPlatform();
  if (platform.isNative) {
    try {
      const file = await qrLocalFile(uid);
      if (await platform.exists(file)) return await platform.readFile(file);
    } catch {
      return null;
    }
    return null;
  }
  return serverApiUrl(`/api/qrcode?mid=${uid}`);
}

/** 保存某 UID 的收款码：原生写本地，Web 走服务器 */
async function saveQr(
  uid: number,
  uname: string,
  dataUrl: string,
): Promise<{ ok: boolean; message: string }> {
  const platform = await getPlatform();
  if (platform.isNative) {
    try {
      const file = await qrLocalFile(uid);
      await platform.mkdir(file.replace(/\/[^/]+$/, ""));
      await platform.writeFile(file, dataUrl);
      return { ok: true, message: "收款码已更新" };
    } catch {
      return { ok: false, message: "上传失败" };
    }
  }
  try {
    const r = (await serverFetch("/api/qrcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mid: uid, uname, dataUrl }),
    })) as { code?: number; message?: string };
    return r?.code === 0 ? { ok: true, message: "收款码已更新" } : { ok: false, message: r?.message || "上传失败" };
  } catch {
    return { ok: false, message: "上传失败" };
  }
}

/** 常用静态图片格式白名单 */
const QR_ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function gridRows(count: number): number[] {
  if (count <= 4) return [2, 2];
  if (count === 5) return [2, 3];
  return [2, 2, 2]; // 6
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 收款码缩略图：点击放大，未配置时显示提示 */
function QrThumb({ uid, name }: { uid: number; name: string }) {
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  const [zoom, setZoom] = useState(false);
  const [url, setUrl] = useState<string>("");

  // 平台感知：原生读本地，Web 走服务器
  useEffect(() => {
    let alive = true;
    setState("loading");
    resolveQrSrc(uid).then((src) => {
      if (!alive) return;
      if (!src) {
        setState("missing");
        return;
      }
      setUrl(src);
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  return (
    <>
      <button
        onClick={() => {
          if (state === "ok") setZoom(true);
        }}
        className="w-12 h-12 flex-shrink-0 rounded-lg border border-black/10 bg-white flex items-center justify-center overflow-hidden"
      >
        {state !== "ok" ? (
          <span className="text-[8px] text-black/40 px-0.5 text-center leading-tight">
            {state === "loading" ? "加载中" : (
              <span className="inline-block leading-tight">
                未配置
                <br />
                二维码
              </span>
            )}
          </span>
        ) : (
          <img src={url} onLoad={() => setState("ok")} onError={() => setState("missing")} className="w-full h-full object-contain" alt="" />
        )}
      </button>
      {zoom && state === "ok" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={() => setZoom(false)}>
            <div className="bg-white rounded-2xl p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <img src={url} className="w-64 h-64 object-contain" alt="" />
              <div className="mt-3 text-center text-sm text-black/70 font-medium">{name}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default function MedicalFeeSettlement({ currentUid, currentUname, onBack }: Props) {
  const [uidInput, setUidInput] = useState(String(currentUid || ""));
  const [queriedUid, setQueriedUid] = useState<number>(currentUid || 0);
  const [nickname, setNickname] = useState(currentUname || "");
  const [roomId, setRoomId] = useState(0);
  const [participants, setParticipants] = useState<Member[]>([]);
  const [bizSessionId, setBizSessionId] = useState("");
  const [nChannel, setNChannel] = useState(0);
  const [hasBizSession, setHasBizSession] = useState(false);
  const [settled, setSettled] = useState(false);
  const [pollEnabled, setPollEnabled] = useState(true);
  const [roles, setRoles] = useState<Record<number, "fa" | "shou" | "none">>({});
  const [lastClick, setLastClick] = useState(0);
  const [stats, setStats] = useState<{ paid: number; received: number; paidCount: number; receivedCount: number } | null>(null);
  const [qrPickUid, setQrPickUid] = useState(0);
  const [qrVersion, setQrVersion] = useState(0);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [myQrUrl, setMyQrUrl] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<LocalRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const myQrCheckRef = useRef(0); // 用于在配置后刷新本机收款码预览

  // refs 保存最新状态，供轮询/归档读取，避免闭包过期
  const stateRef = useRef({ queriedUid, roomId, participants, bizSessionId, settled, pollEnabled });
  stateRef.current = { queriedUid, roomId, participants, bizSessionId, settled, pollEnabled };
  const settledRef = useRef(settled);
  settledRef.current = settled;
  const rolesRef = useRef(roles);
  rolesRef.current = roles;
  const archivedRef = useRef(false);
  const operatorRef = useRef({ uid: currentUid, uname: currentUname });
  operatorRef.current = { uid: currentUid, uname: currentUname };

  // 派生计算
  const sorted = useMemo(() => [...participants].sort((a, b) => b.price - a.price), [participants]);
  const secondScore = sorted[1]?.price ?? 0;
  const isDaMan = secondScore >= 55000;
  const isGameActive = nChannel >= 7 && secondScore >= 1000;
  const intervalMs = useMemo(() => {
    // 未成局（无论几人）→ 180s；成局后 7 人未打满 → 180s；打满或 8/9 人 → 10s
    if (!isGameActive) return 180000;
    if (nChannel === 7 && !isDaMan) return 180000;
    return 10000;
  }, [isGameActive, nChannel, isDaMan]);

  // 拉取数据
  const poll = useCallback(async () => {
    const st = stateRef.current;
    if (!st.queriedUid || !st.pollEnabled || st.settled) return;
    let rid = st.roomId;
    if (!rid) {
      const rr = await fetchMedicalRoomId(st.queriedUid);
      rid = Number(rr?.data?.roomid);
      if (!rid) return;
      setRoomId(rid);
    }
    const res = await fetchMedicalUniversal(rid, st.queriedUid);
    const json = res as any;
    if (!json || json.code !== 0 || !json.data) return;
    const d = json.data;
    const sessionId = d.biz_session_id ?? "";
    if (st.bizSessionId && sessionId && st.bizSessionId !== sessionId) {
      // 新一局：重置历史参与人
      setBizSessionId(sessionId);
      setParticipants([]);
      setRoles({});
      setSettled(false);
      stateRef.current.bizSessionId = sessionId;
      stateRef.current.participants = [];
    } else if (!st.bizSessionId && sessionId) {
      setBizSessionId(sessionId);
      stateRef.current.bizSessionId = sessionId;
    }
    const members = d.members ?? [];
    const channelUsers = d.channel_users ?? [];
    setNChannel(channelUsers.length);
    setHasBizSession(!!sessionId);
    const oldMap = new Map(stateRef.current.participants.map((p) => [p.uid, p]));
    const map = new Map<number, Member>();
    for (const uidStr of channelUsers) {
      const uid = Number(uidStr);
      const member = members.find((m: any) => Number(m.uid) === uid);
      if (member) {
        const priceRaw = member?.biz_extra_data?.multi_conn?.price ?? 0;
        map.set(uid, {
          uid,
          uname: member.uname ?? "",
          face: member.face ?? "",
          position: member.position ?? 0,
          room_id: member.room_id ?? 0,
          price: priceRaw / 100,
          exited: false,
        });
      } else {
        const old = oldMap.get(uid);
        if (old) map.set(uid, { ...old, exited: true });
      }
    }
    const next = Array.from(map.values());
    setParticipants(next);
    stateRef.current.participants = next;
    const self = members.find((m: any) => Number(m.uid) === Number(st.queriedUid));
    if (self?.uname) setNickname(self.uname);
  }, []);

  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  // 轮询定时器
  useEffect(() => {
    if (!pollEnabled) return;
    pollRef.current();
    const t = window.setInterval(() => pollRef.current(), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs, pollEnabled, queriedUid]);

  // 查询指定 UID 时切换
  const applyUid = useCallback(async () => {
    const uid = Number(uidInput.trim());
    if (!uid) {
      showToast("请输入正确的 UID");
      return;
    }
    setQueriedUid(uid);
    setRoomId(0);
    setParticipants([]);
    setBizSessionId("");
    setSettled(false);
    setRoles({});
    setNChannel(0);
    setHasBizSession(false);
    setPollEnabled(true);
    stateRef.current.queriedUid = uid;
    stateRef.current.roomId = 0;
    stateRef.current.participants = [];
    stateRef.current.bizSessionId = "";
    // 查询昵称
    const r = await fetchMedicalUname(uid);
    if (r?.code === 0 && r?.data?.uname) setNickname(r.data.uname);
    else setNickname("");
    loadStats(uid);
    // 立即触发一次拉取（无需等轮询间隔）
    pollRef.current();
  }, [uidInput]);

  // 结算
  const settle = useCallback(async () => {
    await pollRef.current();
    const ps = stateRef.current.participants;
    if (ps.length < 2) return;
    const sl = [...ps].sort((a, b) => b.price - a.price);
    const winner = sl[0];
    const laifu = sl[1];
    const newRoles: Record<number, "fa" | "shou" | "none"> = {};
    for (const p of ps) newRoles[p.uid] = "none";
    if (laifu && !laifu.exited) newRoles[laifu.uid] = "fa";
    const s2 = laifu?.price ?? 0;
    const dm = s2 >= 55000;
    // 打满时无论几人局，只有 3/4/5/6 名共 4 人吃医药费；未打满时 3~7 名共 5 人
    let count = dm ? 4 : 5;
    for (const c of sl) {
      if (count <= 0) break;
      if (c.uid === winner?.uid || c.uid === laifu?.uid || c.exited) continue;
      newRoles[c.uid] = "shou";
      count--;
    }
    setRoles(newRoles);
    setSettled(true);
    setLastClick(Date.now());
    setPollEnabled(false);
    stateRef.current.settled = true;
    stateRef.current.pollEnabled = false;
  }, [nChannel]);

  // 恢复监测（误点结算后重新开始自动侦测，不归档）
  const resume = useCallback(() => {
    setSettled(false);
    setRoles({});
    setPollEnabled(true);
    setLastClick(0);
    stateRef.current.settled = false;
    stateRef.current.pollEnabled = true;
    archivedRef.current = false;
  }, []);

  // 手动切换 发/收
  const toggleRole = useCallback((uid: number, type: "fa" | "shou") => {
    setRoles((prev) => {
      const cur = prev[uid] ?? "none";
      let next: "fa" | "shou" | "none" = cur;
      if (type === "fa") next = cur === "fa" ? "none" : "fa";
      else next = cur === "shou" ? "none" : "shou";
      const newRoles = { ...prev, [uid]: next };
      if (type === "fa" && next === "fa") {
        for (const k of Object.keys(newRoles)) {
          if (Number(k) !== uid && newRoles[Number(k)] === "fa") newRoles[Number(k)] = "none";
        }
      }
      return newRoles;
    });
    setLastClick(Date.now());
  }, []);

  // 结算金额（派生，随分数/角色变化实时重算）
  const derived = useMemo(() => {
    const laifuUid = Object.entries(roles).find(([, r]) => r === "fa")?.[0];
    const laifuScore = participants.find((p) => p.uid === Number(laifuUid))?.price ?? secondScore;
    const dm = laifuScore >= 55000;
    // 总额 = calcTotal（未打满按分数÷100，后3位当0；打满固定 552）
    const total = calcTotal(laifuScore, dm);
    const shouUids = Object.entries(roles)
      .filter(([, r]) => r === "shou")
      .map(([u]) => Number(u));
    // 人均 = 总额 ÷ 收医药费人数，保留 0.1 位（每个人相同）
    const perPerson = shouUids.length ? round1(total / shouUids.length) : 0;
    return { laifuUid: Number(laifuUid), total, dm, shouUids, perPerson, laifuScore };
  }, [roles, participants, secondScore]);

  // 更新分数
  const updateScore = useCallback((uid: number, value: number) => {
    setParticipants((prev) => prev.map((p) => (p.uid === uid ? { ...p, price: value } : p)));
    setLastClick(Date.now());
  }, []);

  // 归档数据
  const loadLocalRecords = useCallback(async (): Promise<LocalRecord[]> => {
    try {
      const platform = await getPlatform();
      if (!platform.isNative) return [];
      const stt = await platform.getSessionState();
      const session = stt.sessions.find((s) => s.sid === stt.currentSid);
      if (!session) return [];
      const dir = `${await platform.getDataDir()}/uid_${session.mid}`;
      if (!(await platform.exists(`${dir}/medical-fee-records.json`))) return [];
      const raw = await platform.readFile(`${dir}/medical-fee-records.json`);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : parsed?.records ?? [];
    } catch {
      return [];
    }
  }, []);

  const saveLocalRecords = useCallback(async (records: LocalRecord[]) => {
    try {
      const platform = await getPlatform();
      if (!platform.isNative) return;
      const stt = await platform.getSessionState();
      const session = stt.sessions.find((s) => s.sid === stt.currentSid);
      if (!session) return;
      const dir = `${await platform.getDataDir()}/uid_${session.mid}`;
      await platform.mkdir(dir);
      await platform.writeFile(`${dir}/medical-fee-records.json`, JSON.stringify(records, null, 2));
    } catch {
      // 忽略
    }
  }, []);

  const uploadRecords = useCallback(async (records: LocalRecord[]) => {
    try {
      const op = operatorRef.current;
      await serverFetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mid: op.uid,
          uname: op.uname,
          files: { "medical-fee-records.json": JSON.stringify(records) },
        }),
      });
    } catch {
      // 忽略
    }
  }, []);

  // 打开本机记录列表（仅原生 Tauri 有本地文件，Web 无本地记录）
  const openHistory = useCallback(async () => {
    const recs = await loadLocalRecords();
    setHistoryRecords(recs);
    setShowHistory(true);
  }, [loadLocalRecords]);

  const archive = useCallback(async () => {
    if (archivedRef.current) return;
    archivedRef.current = true;
    const st = stateRef.current;
    const rl = rolesRef.current;
    const laifuUid = Object.entries(rl).find(([, r]) => r === "fa")?.[0];
    if (!laifuUid) {
      archivedRef.current = false;
      return;
    }
    const laifuScore = st.participants.find((p) => p.uid === Number(laifuUid))?.price ?? 0;
    const dmNow = laifuScore >= 55000;
    const total = calcTotal(laifuScore, dmNow);
    const shouUids = Object.entries(rl)
      .filter(([, r]) => r === "shou")
      .map(([u]) => Number(u));
    const perPerson = shouUids.length ? round1(total / shouUids.length) : 0;
    const now = Math.floor(Date.now() / 1000);
    const laifuName = st.participants.find((p) => p.uid === Number(laifuUid))?.uname ?? "";
    const record: LocalRecord = {
      recordId: st.bizSessionId ? `biz_${st.bizSessionId}` : `t_${now}_${st.queriedUid}`,
      gameTime: formatTime(now),
      gameTimeTs: now,
      bizSessionId: st.bizSessionId,
      laifuOwnerUid: Number(laifuUid),
      laifuOwnerUname: laifuName,
      totalAmount: total,
      perPersonAmount: perPerson,
      // 只保留收医药费者明细，用于统计每人收到金额；不保存全部参与者明细以精简数据。
      recipients: shouUids.map((uid) => {
        const p = st.participants.find((x) => x.uid === uid);
        return { uid, uname: p?.uname ?? "", amount: perPerson };
      }),
    };
    try {
      const existing = await loadLocalRecords();
      const records = [record, ...existing.filter((r) => r.recordId !== record.recordId)].slice(0, 20);
      await saveLocalRecords(records);
      await uploadRecords(records);
    } catch (e) {
      console.warn("[Medical] 归档失败:", e);
    }
    // 归档完成：恢复轮询，等待新一局
    setSettled(false);
    setRoles({});
    setPollEnabled(true);
    stateRef.current.settled = false;
    stateRef.current.pollEnabled = true;
    archivedRef.current = false;
  }, [loadLocalRecords, saveLocalRecords, uploadRecords]);

  // 结算后 3 分钟未点击 → 归档
  useEffect(() => {
    if (!settled || !derived.shouUids.length) return;
    const t = window.setTimeout(() => {
      if (Date.now() - lastClick >= 3 * 60 * 1000) archive();
    }, 3 * 60 * 1000);
    return () => window.clearTimeout(t);
  }, [settled, lastClick, derived.shouUids.length, archive]);

  // 退出页面自动归档
  useEffect(() => {
    return () => {
      if (settledRef.current) archive();
    };
  }, [archive]);

  // 拉取历史统计
  const loadStats = useCallback(async (uid: number) => {
    try {
      const r = (await serverFetch(`/api/medical/stats?uid=${uid}`)) as {
        code?: number;
        data?: { paid?: number; received?: number; paidCount?: number; receivedCount?: number };
      };
      if (r?.code === 0 && r?.data) {
        setStats({
          paid: Number(r.data.paid ?? 0),
          received: Number(r.data.received ?? 0),
          paidCount: Number(r.data.paidCount ?? 0),
          receivedCount: Number(r.data.receivedCount ?? 0),
        });
      }
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    if (queriedUid) loadStats(queriedUid);
  }, [queriedUid, loadStats]);

  // 上传/展示收款码
  const onPickQr = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // 限定常用静态图片格式
      if (!QR_ACCEPT_TYPES.includes(file.type)) {
        showToast("仅支持 PNG/JPG/WebP/GIF 图片");
        e.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = String(reader.result || "");
        if (!dataUrl.startsWith("data:image/")) {
          showToast("请选择图片文件");
          return;
        }
        const op = operatorRef.current;
        const res = await saveQr(op.uid, op.uname, dataUrl);
        showToast(res.message);
        if (res.ok) {
          setQrVersion((v) => v + 1);
          setMyQrUrl(dataUrl);
        }
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  // 打开收款码配置弹窗，检测当前用户是否已配置
  const openQrModal = useCallback(async () => {
    setQrModalOpen(true);
    setMyQrUrl(null);
    const op = operatorRef.current;
    const src = await resolveQrSrc(op.uid);
    setMyQrUrl(src);
  }, []);

  // 复制所有收款码
  const copyAllQr = useCallback(async () => {
    const shouUids = Object.entries(roles)
      .filter(([, r]) => r === "shou")
      .map(([u]) => Number(u));
    if (!shouUids.length) {
      showToast("当前没有收医药费的用户");
      return;
    }
    const items: Array<{ img: HTMLImageElement; name: string }> = [];
    for (const uid of shouUids) {
      try {
        const src = await resolveQrSrc(uid);
        if (!src) continue;
        const img = await loadImage(src);
        items.push({ img, name: participants.find((p) => p.uid === uid)?.uname ?? "" });
      } catch {
        // 未配置则跳过
      }
    }
    if (!items.length) {
      showToast("收医药费的用户均未配置收款码");
      return;
    }
    const rows = gridRows(items.length);
    const cellW = 300;
    const nameH = 44;
    const gap = 12;
    const cols = Math.max(...rows);
    const canvasW = cols * cellW + (cols - 1) * gap;
    const canvasH = rows.reduce((acc, r) => acc + r, 0) * (cellW + nameH) + (rows.length - 1) * gap;
    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvasW, canvasH);
    let idx = 0;
    let y = 0;
    for (const row of rows) {
      const rowW = row * cellW + (row - 1) * gap;
      const startX = (canvasW - rowW) / 2;
      for (let i = 0; i < row; i++) {
        const x = startX + i * (cellW + gap);
        const item = items[idx];
        if (item) {
          ctx.drawImage(item.img, x, y, cellW, cellW);
          ctx.fillStyle = "#000";
          ctx.font = "16px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(item.name, x + cellW / 2, y + cellW + nameH - 14);
        }
        idx++;
      }
      y += cellW + nameH + gap;
    }
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) {
      showToast("生成失败");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("所有收款码已复制，去微信粘贴发送到文件助手，然后依次识别付款");
    } catch {
      showToast("复制失败，请手动保存");
    }
  }, [roles, participants]);

  const isNotMulti = nChannel > 0 && nChannel < 7;

  return (
    <div className="space-y-2">
      {/* 顶部栏 */}
      <div className="flex items-center gap-4 py-1">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>
        <span className="text-sm font-semibold">医药费</span>
        <button
          onClick={() => setShowHelp(true)}
          className="flex h-5 w-5 items-center justify-center rounded-full text-black/35 hover:bg-black/5 hover:text-black/70 transition"
          title="使用说明"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={openHistory}
            className="shrink-0 rounded-full border border-black/10 bg-white px-3 py-1 text-xs text-black/60 hover:bg-black/5 transition"
          >
            历史记录
          </button>
          <button
            onClick={openQrModal}
            className="shrink-0 rounded-full bg-[#1f1c17] px-3 py-1 text-xs text-white font-medium hover:opacity-90 transition"
          >
            配置收款码
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={onPickQr}
          />
        </div>
      </div>

      {/* UID 查询 + 徽章 + 统计 */}
      <div className="rounded-xl border border-black/10 bg-white/85 px-2.5 py-1 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
        <div className="flex items-center gap-2">
          <input
            value={uidInput}
            onChange={(e) => setUidInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyUid();
            }}
            placeholder="输入 UID"
            inputMode="numeric"
            className="min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:border-black/30"
          />
          <button
            onClick={applyUid}
            className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-sm text-white hover:bg-blue-600 transition"
          >
            查询
          </button>
          <span className="shrink-0 max-w-[120px] truncate rounded-full bg-black/5 px-3 py-1.5 text-xs text-black/60">
            {nickname || `UID ${queriedUid || "-"}`}
          </span>
        </div>
        {stats && (
          <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-red-50 px-2 py-1">
              <div className="text-black/45">累计发放医药费</div>
              <div className="font-semibold text-[#e74c3c]">
                {stats.paid} 元 <span className="text-black/35 font-normal">({stats.paidCount} 局)</span>
              </div>
            </div>
            <div className="rounded-lg bg-green-50 px-2 py-1">
              <div className="text-black/45">累计收到医药费</div>
              <div className="font-semibold text-[#2ecc71]">
                {stats.received} 元 <span className="text-black/35 font-normal">({stats.receivedCount} 局)</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 状态提示 */}
      <div className="flex items-center gap-2 rounded-xl border border-black/10 bg-white/80 py-2 pl-4 pr-2 text-xs text-black/55 backdrop-blur">
        <div className="flex-1 min-w-0">
        {!roomId ? (
          <span>正在获取房间信息…</span>
        ) : nChannel === 0 ? (
          <span>
            {hasBizSession ? "已进入多人连线，正在等待更多参与者加入…" : "未参与多人连线，暂未成局"}
            <span className="text-black/30"> 每{Math.round(intervalMs / 1000)}秒更新一次</span>
          </span>
        ) : isNotMulti ? (
          <span>
            当前 {nChannel} 人连线，暂未成局（需至少 7 人）
            <span className="text-black/30"> 每{Math.round(intervalMs / 1000)}秒更新一次</span>
          </span>
        ) : !isGameActive ? (
          <span>
            {nChannel} 人接力中，尚未成局（第二名需≥1000） 每{Math.round(intervalMs / 1000)}秒更新一次
          </span>
        ) : (
          <span className="text-black/70">
            {nChannel} 人接力中，{isDaMan ? "已打满" : "未打满"}。每{Math.round(intervalMs / 1000)}秒更新一次{settled}
          </span>
        )}
        </div>
        <button
          onClick={() => pollRef.current()}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-black/45 hover:bg-black/5 hover:text-black/80 transition"
          title="立即刷新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M4.58 9A8 8 0 1 1 4 14" />
          </svg>
        </button>
      </div>

      {/* 参与人卡片（结算期即使有人离场少于7人仍保留显示） */}
      {(nChannel >= 7 || settled) && (
        <div className="space-y-1">
          {sorted.map((p) => {
            const role = settled ? roles[p.uid] ?? "none" : "none";
            return (
              <div
                key={p.uid}
                className={`rounded-xl border pl-2.5 pr-2.5 py-1 flex items-center gap-1.5 shadow-[0_20px_80px_rgba(31,28,23,0.06)] backdrop-blur ${
                  p.exited ? "border-dashed border-black/15 bg-gray-100/70" : "border-black/10 bg-white/85"
                }`}
              >
                {/* 头像 + 昵称（同一行：头像左，昵称右），固定宽度以对齐分数列 */}
                <div className="flex items-center gap-1.5 flex-shrink-0 w-32">
                  {p.face ? (
                    <img
                      src={p.face.startsWith("//") ? "https:" + p.face : p.face}
                      alt=""
                      className="w-11 h-11 rounded-full object-cover flex-shrink-0"
                      onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-full bg-black/5 flex items-center justify-center text-sm text-black/40 flex-shrink-0">
                      {p.uname?.slice(0, 1) || "?"}
                    </div>
                  )}
                  <div className="flex flex-col min-w-0">
                    <span
                      className="max-w-[96px] rounded-md px-1.5 py-0.5 text-[10px] text-white break-all leading-tight text-center"
                      style={{ backgroundColor: uidColor(p.uid) }}
                    >
                      {p.uname || `UID ${p.uid}`}
                    </span>
                    {p.exited && <span className="mt-0.5 text-[9px] text-black/35">已离场</span>}
                  </div>
                </div>

                {/* 分数（结算前只读，结算后可编辑） */}
                <div className="flex-1 min-w-0 flex justify-center">
                  <input
                    value={p.price}
                    onChange={(e) => updateScore(p.uid, Number(e.target.value) || 0)}
                    readOnly={!settled}
                    inputMode="numeric"
                    className="w-[74px] rounded-lg border border-black/10 bg-white px-1 py-1 text-sm text-center focus:outline-none focus:border-black/30 disabled:cursor-not-allowed"
                  />
                </div>

                {/* 发/收 圆形按钮 */}
                <div className="flex flex-row items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => settled && toggleRole(p.uid, "fa")}
                    disabled={!settled}
                    className={`w-11 h-11 rounded-full text-sm font-bold transition active:scale-95 flex items-center justify-center ${
                      role === "fa" ? "bg-[#e74c3c] text-white shadow" : "bg-gray-100 text-black/40 disabled:text-black/25"
                    }`}
                  >
                    发
                  </button>
                  <button
                    onClick={() => settled && toggleRole(p.uid, "shou")}
                    disabled={!settled}
                    className={`w-11 h-11 rounded-full text-sm font-bold transition active:scale-95 flex items-center justify-center ${
                      role === "shou" ? "bg-[#2ecc71] text-white shadow" : "bg-gray-100 text-black/40 disabled:text-black/25"
                    }`}
                  >
                    收
                  </button>
                </div>

                {/* 收款码缩略图（仅收医药费者显示） */}
                <div className="flex-shrink-0">
                  {settled && role === "shou" ? (
                    <QrThumb key={`${p.uid}-${qrVersion}`} uid={p.uid} name={p.uname || `UID ${p.uid}`} />
                  ) : (
                    <div className="w-12 h-12" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 结算区 */}
      {(nChannel >= 7 || settled) && (
        <>
          <button
            onClick={settled ? resume : settle}
            disabled={!settled && !isGameActive}
            className={`mx-auto flex w-1/2 items-center justify-center rounded-lg border px-6 py-1.5 text-sm font-medium transition active:scale-95 ${
              settled || isGameActive
                ? "border-transparent bg-[#1f1c17] text-white shadow hover:opacity-90"
                : "border-black/10 bg-white text-black/35 cursor-not-allowed"
            }`}
          >
            {settled ? "重新监测" : "结算医药费"}
          </button>
          {settled && (
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1 flex justify-center text-sm text-black/60">
                {derived.total} / {derived.shouUids.length} = 每人{" "}
                <span className="font-bold text-[#2ecc71]">{derived.perPerson} 元</span>
              </div>
              <button
                onClick={copyAllQr}
                className="shrink-0 rounded-lg bg-[#555] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition"
              >
                复制全部收款码
              </button>
            </div>
          )}
        </>
      )}

      {/* 收款码配置弹窗 */}
      {qrModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
            onClick={() => setQrModalOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {myQrUrl ? (
                <div className="flex flex-col items-center">
                  <div className="text-sm font-semibold text-black/80 mb-3">我的收款码</div>
                  <img
                    src={myQrUrl}
                    className="w-40 h-40 object-contain rounded-lg border border-black/10"
                    alt="收款码"
                  />
                  <div className="mt-4 w-full">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full rounded-lg bg-[#1f1c17] py-2 text-sm font-medium text-white hover:opacity-90 transition"
                    >
                      更新收款码
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div className="text-sm font-semibold text-black/80 mb-2">我的收款码</div>
                  <p className="text-xs text-black/55 leading-relaxed text-center mb-4">
                    一次添加，永远有效。只要对方也使用本软件，每次收医药费不必再展示二维码，也不必去接力群领红包。收款码不是付款码，不必担心资金风险。
                  </p>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full rounded-lg bg-[#1f1c17] py-2 text-sm font-medium text-white hover:opacity-90 transition"
                  >
                    添加收款码
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* 本机记录列表弹窗 */}
      {showHistory &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
            onClick={() => setShowHistory(false)}
          >
            <div
              className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-black/80">
                  本机记录（最新 {historyRecords.length} 条）
                </div>
                <button
                  onClick={() => setShowHistory(false)}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-black/40 hover:bg-black/5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2">
                {historyRecords.length === 0 ? (
                  <div className="py-10 text-center text-sm text-black/40">暂无本机归档记录</div>
                ) : (
                  historyRecords.map((r) => {
                    const shou = r.recipients.map((x) => ({ uid: x.uid, name: x.uname }));
                    const laifuName = r.laifuOwnerUname ?? "";
                    return (
                      <div key={r.recordId} className="rounded-xl border border-black/10 bg-white p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-black/50">{r.gameTime}</span>
                          <span className="text-xs text-black/50">总额 {r.totalAmount} · 每人 {r.perPersonAmount}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="text-red-500 flex-shrink-0">发</span>
                          <span
                            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-white"
                            style={{ backgroundColor: uidColor(r.laifuOwnerUid) }}
                          >
                            {laifuName}
                          </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="text-green-600 flex-shrink-0">收</span>
                          {shou.map((s, i) => (
                            <span
                              key={i}
                              className="rounded-md px-1.5 py-0.5 text-xs font-medium text-white"
                              style={{ backgroundColor: uidColor(s.uid) }}
                            >
                              {s.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 使用说明弹窗 */}
      {showHelp &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
            onClick={() => setShowHelp(false)}
          >
            <div
              className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-sm font-semibold text-black/80 mb-3 text-center">使用说明</div>
              <ol className="space-y-3 text-xs text-black/70 leading-relaxed list-none">
                <li className="flex gap-2">
                  <span className="text-black/30 flex-shrink-0">1.</span>
                  <span>
                    自动检测谁发医药费、谁吃医药费、以及发多少。但自动检测不准确，因为有很多意外情况，比如有人掉线、开局时没有清分、主持人自定义了接力规则等等。接力结束点击&lt;结算医药费&gt;之后，一定要人工确认识别的准确性；如果识别到的收发医药费主播与实际不一致，可以点击每个用户右侧的红/绿收发按钮手动调整，也会自动更新医药费的计算。
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-black/30 flex-shrink-0">2.</span>
                  <span>
                    每个用户可以配置自己的收款码，也就是上传到软件，一次即可。以后结算时，发医药费的主播就可以看到，自行扫码支付，不用再出示收款码，也不用再统计去哪个群发收红包。不过这个功能需要越来越多的主播使用本软件并配置自己的收款码才有效。
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="text-black/30 flex-shrink-0">3.</span>
                  <span>
                    发医药费时，依次扫描收款码付款。另一个方便的操作是点击&lt;复制全部收款码&gt;，打开微信发送给文件助手或小号，在微信中依次长按识别付款码进行支付。
                  </span>
                </li>
              </ol>
              <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 leading-relaxed">
                <span className="font-semibold">免责声明：</span>
                结算时一定要核对是发放给正确的人和正确的数额，由于使用本软件导致的错发损失，概不负责。
              </div>
              <button
                onClick={() => setShowHelp(false)}
                className="mt-4 w-full rounded-lg bg-[#1f1c17] py-2 text-sm font-medium text-white hover:opacity-90 transition"
              >
                知道了
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}