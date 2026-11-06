"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  calcFeeSplit,
  defaultFeeRoles,
  planFeeGroups,
  type FeeRoles,
  type WeChatGroup,
} from "@/lib/medical-fee-calc";
import { readViewerProfile, writeViewerProfile, type ViewerProfile } from "@/lib/viewer-profile";
import SiteHomeButton from "@/components/SiteHomeButton";

const UID_STORAGE_KEY = "bili_live_micro_light_uid";
const AUTO_SAVE_DELAY = 10_000;

type Anchor = { uid: number; name: string; votes: number; roomId: number };

type SavedPay = {
  payerUid: number;
  payerAmount: number;
  receiverUids: number[];
  perPerson: number;
  scores: Record<string, number>;
  updatedAt: string;
};

type Entry = {
  pkId: number;
  startAt: number;
  endAt: number;
  duration: number;
  participants: number;
  secondVotes: number;
  void: boolean;
  expired: boolean;
  anchors: Anchor[];
  saved: SavedPay | null;
};

type RecordsData = {
  uid: number;
  uname: string;
  face: string;
  roomId: number;
  month: string;
  validHours: number;
  seasonId: number;
  monthlyPaidCount: number;
  monthlyReceivedCount: number;
  entries: Entry[];
};

type GroupPublic = WeChatGroup & { memberCount: number; mine: boolean };

type ConfigData = {
  validHours: number;
  membership: string[];
  groups: GroupPublic[];
};

type EditState = {
  scores: Record<number, number>;
  payerUid: number;
  receiverUids: number[];
};

type Period = "all" | "month" | "week";
type LeaderBoardKey = "leiFeng" | "chiHuo" | "jingLi";

type LeaderRow = {
  uid: number;
  uname: string;
  paid: number;
  received: number;
  net: number;
  paidCount: number;
  receivedCount: number;
  value: number;
  rank: number;
};

type Leaderboards = {
  month: string;
  week: string;
  leiFeng: LeaderRow[];
  chiHuo: LeaderRow[];
  jingLi: LeaderRow[];
  me: { uid: number; leiFeng: LeaderRow | null; chiHuo: LeaderRow | null; jingLi: LeaderRow | null } | null;
};

/** 群徽章配色（按后台配置顺序循环使用，保证不同群颜色不同） */
const GROUP_COLORS = [
  "#e2574c",
  "#2e9e6b",
  "#3182bd",
  "#d98214",
  "#8e5bb5",
  "#159a8c",
  "#b0513a",
  "#b8336a",
  "#4a5bbf",
  "#4b7b8a",
  "#7a8a1f",
  "#8c6239",
];

function groupColor(index: number): string {
  return GROUP_COLORS[(Math.max(1, index) - 1) % GROUP_COLORS.length];
}

function fixImage(url?: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatClock(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function money(n: number): string {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const PERIOD_LABELS: Array<{ key: Period; label: string }> = [
  { key: "all", label: "历史" },
  { key: "month", label: "本月" },
  { key: "week", label: "本周" },
];

const LEADER_META: Record<
  LeaderBoardKey,
  { title: string; desc: string; accent: string; valueLabel: string }
> = {
  leiFeng: { title: "雷锋榜", desc: "发", accent: "text-[#c0392b]", valueLabel: "已发" },
  chiHuo: { title: "爽吃榜", desc: "吃", accent: "text-[#2e9e6b]", valueLabel: "已收" },
  jingLi: { title: "净吃榜", desc: "吃-发", accent: "text-[#3182bd]", valueLabel: "净吃" },
};

export default function MedicalFeeDashboard() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [uidInput, setUidInput] = useState("");
  const [uid, setUid] = useState<number | null>(null);
  const [data, setData] = useState<RecordsData | null>(null);
  /** 本地缓存的昵称/头像：与「备用药」页面共用，切换页面时立即显示，避免 UID 闪变 */
  const [profile, setProfile] = useState<ViewerProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "paid" | "received">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [edits, setEdits] = useState<Record<number, EditState>>({});
  const [saving, setSaving] = useState<Record<number, boolean>>({});
  const [faces, setFaces] = useState<Record<number, string>>({});
  const [groupModal, setGroupModal] = useState<string | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);

  const [leaderPeriod, setLeaderPeriod] = useState<Period>("all");
  const [leaderboards, setLeaderboards] = useState<Partial<Record<Period, Leaderboards>>>({});

  const dataRef = useRef<RecordsData | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const editsRef = useRef(edits);
  const uidRef = useRef<number | null>(uid);
  const saveTimers = useRef<Map<number, number>>(new Map());
  const requestedFaces = useRef<Set<number>>(new Set());

  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  useEffect(() => {
    editsRef.current = edits;
  }, [edits]);
  useEffect(() => {
    uidRef.current = uid;
  }, [uid]);

  // 点击提示图标以外的任意区域时关闭提示
  useEffect(() => {
    if (!tipOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (hintRef.current && !hintRef.current.contains(event.target as Node)) {
        setTipOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [tipOpen]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  // ===== 数据加载 =====

  const loadConfig = useCallback(async (targetUid: number) => {
    try {
      const res = await fetch(`/api/medical-fee/config?uid=${targetUid || 0}`, { cache: "no-store" });
      const json = await res.json();
      if (json?.code === 0) setConfig(json.data as ConfigData);
    } catch {
      /* 忽略：配置加载失败不影响记录 */
    }
  }, []);

  const loadRecords = useCallback(async (targetUid: number, force = false) => {
    setError("");
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch(`/api/medical-fee/records?uid=${targetUid}`, { cache: "no-store" });
      const json = await res.json();
      if (json?.code !== 0) {
        setData(null);
        setError(json?.message || "加载失败，请稍后重试");
        return;
      }
      setData(json.data as RecordsData);
      const next = json.data as RecordsData;
      if (next?.uname) {
        setProfile({ uid: targetUid, uname: next.uname, face: next.face || "", savedAt: Date.now() });
        writeViewerProfile(targetUid, next.uname, next.face || "");
      }
      setExpanded(new Set());
      setExpiredOpen(false);
      setEdits({});
    } catch {
      setData(null);
      setError("网络异常，请稍后重试");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadLeaderboards = useCallback(async (targetUid: number, period: Period) => {
    try {
      const res = await fetch(
        `/api/medical-fee/leaderboard?period=${period}&uid=${targetUid || 0}&limit=20`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (json?.code === 0) {
        setLeaderboards((prev) => ({ ...prev, [period]: json.data as Leaderboards }));
      }
    } catch {
      /* 忽略：榜单加载失败不影响主流程 */
    }
  }, []);

  // 首次进入：拉配置并恢复 UID
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfig(0);
      void loadLeaderboards(0, "all");
      void loadLeaderboards(0, "month");
      void loadLeaderboards(0, "week");
      let saved = "";
      try {
        saved = localStorage.getItem(UID_STORAGE_KEY) ?? "";
      } catch {
        saved = "";
      }
      const savedUid = Number(saved.replace(/[^\d]/g, ""));
      if (savedUid > 0) {
        // 先用两个页面共享的缓存同步渲染昵称/头像，避免先显示 UID 再闪变
        const cachedProfile = readViewerProfile(savedUid);
        if (cachedProfile) setProfile(cachedProfile);
        setUid(savedUid);
        setUidInput(String(savedUid));
        void loadConfig(savedUid);
        void loadRecords(savedUid);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      for (const t of saveTimers.current.values()) window.clearTimeout(t);
      saveTimers.current.clear();
    };
  }, [loadConfig, loadRecords, loadLeaderboards]);

  // UID 变化时刷新榜单（「我的排名」高亮需要 UID）
  useEffect(() => {
    if (!uid) return;
    const timer = window.setTimeout(() => {
      void loadLeaderboards(uid, "all");
      void loadLeaderboards(uid, "month");
      void loadLeaderboards(uid, "week");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [uid, loadLeaderboards]);

  const submitUid = () => {
    const next = Number(uidInput.replace(/[^\d]/g, ""));
    if (!next || next <= 0) {
      showToast("请输入正确的 B站 UID");
      return;
    }
    try {
      localStorage.setItem(UID_STORAGE_KEY, String(next));
    } catch {
      /* 隐私模式等场景忽略 */
    }
    setUid(next);
    setData(null);
    const cachedProfile = readViewerProfile(next);
    setProfile(cachedProfile);
    void loadConfig(next);
    void loadRecords(next);
    void loadLeaderboards(next, "all");
    void loadLeaderboards(next, "month");
    void loadLeaderboards(next, "week");
  };

  const changeUid = () => {
    setUid(null);
    setData(null);
    setProfile(null);
    setUidInput("");
    setError("");
    setExpanded(new Set());
    setExpiredOpen(false);
    setEdits({});
    void loadConfig(0);
    try {
      localStorage.removeItem(UID_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  // ===== 自动上传 =====

  const uploadRecord = useCallback(
    async (pkId: number) => {
      const entry = dataRef.current?.entries.find((e) => e.pkId === pkId);
      const edit = editsRef.current[pkId];
      const operator = uidRef.current;
      if (!entry || !edit || !operator || entry.expired) return;
      if (!edit.payerUid || edit.receiverUids.length === 0) return;

      setSaving((prev) => ({ ...prev, [pkId]: true }));
      const names: Record<string, string> = {};
      entry.anchors.forEach((a) => {
        names[String(a.uid)] = a.name;
      });
      try {
        const res = await fetch("/api/medical-fee/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uid: operator,
            pkId: entry.pkId,
            pkStartAt: entry.startAt,
            pkEndAt: entry.endAt,
            payerUid: edit.payerUid,
            receiverUids: edit.receiverUids,
            scores: edit.scores,
            names,
          }),
        });
        const json = await res.json();
        if (json?.code !== 0) {
          showToast(json?.message || "自动保存失败");
          return;
        }
        const rec = json.data?.record as SavedPay;
        const paidCount = json.data?.monthlyPaidCount;
        const receivedCount = json.data?.monthlyReceivedCount;
        void loadLeaderboards(operator, "all");
        void loadLeaderboards(operator, "month");
        void loadLeaderboards(operator, "week");
        setData((prev) =>
          prev
            ? {
                ...prev,
                monthlyPaidCount:
                  typeof paidCount === "number" ? paidCount : prev.monthlyPaidCount,
                monthlyReceivedCount:
                  typeof receivedCount === "number" ? receivedCount : prev.monthlyReceivedCount,
                entries: prev.entries.map((e) =>
                  e.pkId === pkId
                    ? {
                        ...e,
                        saved: {
                          payerUid: rec.payerUid,
                          payerAmount: rec.payerAmount,
                          receiverUids: rec.receiverUids,
                          perPerson: rec.perPerson,
                          scores: rec.scores,
                          updatedAt: rec.updatedAt,
                        },
                      }
                    : e,
                ),
              }
            : prev,
        );
      } catch {
        showToast("自动保存失败，请检查网络");
      } finally {
        setSaving((prev) => ({ ...prev, [pkId]: false }));
      }
    },
    [showToast, loadLeaderboards],
  );

  const scheduleUpload = useCallback(
    (pkId: number) => {
      const old = saveTimers.current.get(pkId);
      if (old) window.clearTimeout(old);
      const timer = window.setTimeout(() => {
        saveTimers.current.delete(pkId);
        void uploadRecord(pkId);
      }, AUTO_SAVE_DELAY);
      saveTimers.current.set(pkId, timer);
    },
    [uploadRecord],
  );

  // ===== 记录展开 / 编辑 =====

  const ensureEdit = useCallback((entry: Entry) => {
    setEdits((prev) => {
      if (prev[entry.pkId]) return prev;
      const scores: Record<number, number> = {};
      entry.anchors.forEach((a) => {
        const savedScore = entry.saved?.scores?.[String(a.uid)];
        scores[a.uid] = typeof savedScore === "number" ? savedScore : a.votes;
      });
      const roles = entry.saved
        ? { payerUid: entry.saved.payerUid, receiverUids: entry.saved.receiverUids }
        : defaultFeeRoles(entry.anchors.map((a) => ({ uid: a.uid, votes: scores[a.uid] })));
      return {
        ...prev,
        [entry.pkId]: { scores, payerUid: roles.payerUid, receiverUids: roles.receiverUids },
      };
    });
  }, []);

  const toggleEntry = (entry: Entry) => {
    if (entry.expired) return;
    const willOpen = !expanded.has(entry.pkId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(entry.pkId)) next.delete(entry.pkId);
      else next.add(entry.pkId);
      return next;
    });
    if (willOpen) {
      ensureEdit(entry);
      scheduleUpload(entry.pkId);
    }
  };

  const updateScore = (pkId: number, anchorUid: number, value: number) => {
    setEdits((prev) => {
      const cur = prev[pkId];
      if (!cur) return prev;
      return { ...prev, [pkId]: { ...cur, scores: { ...cur.scores, [anchorUid]: value } } };
    });
    scheduleUpload(pkId);
  };

  const updateRole = (pkId: number, anchorUid: number, role: "fa" | "shou" | "none") => {
    setEdits((prev) => {
      const cur = prev[pkId];
      if (!cur) return prev;
      let payerUid = cur.payerUid;
      let receiverUids = [...cur.receiverUids];
      if (role === "fa") {
        if (payerUid === anchorUid) payerUid = 0;
        else payerUid = anchorUid;
        receiverUids = receiverUids.filter((u) => u !== anchorUid);
      } else if (role === "shou") {
        if (payerUid === anchorUid) {
          payerUid = 0;
          receiverUids = receiverUids.filter((u) => u !== anchorUid);
        } else if (receiverUids.includes(anchorUid)) {
          receiverUids = receiverUids.filter((u) => u !== anchorUid);
        } else {
          receiverUids.push(anchorUid);
        }
      } else {
        if (payerUid === anchorUid) payerUid = 0;
        receiverUids = receiverUids.filter((u) => u !== anchorUid);
      }
      return { ...prev, [pkId]: { ...cur, payerUid, receiverUids } };
    });
    scheduleUpload(pkId);
  };

  // ===== 头像懒加载 =====

  useEffect(() => {
    const needed: Array<{ uid: number; roomId: number }> = [];
    const collect = (a: Anchor) => {
      if (!a.uid || requestedFaces.current.has(a.uid)) return;
      requestedFaces.current.add(a.uid);
      needed.push({ uid: a.uid, roomId: a.roomId });
    };
    if (data) {
      for (const pkId of expanded) {
        const entry = data.entries.find((e) => e.pkId === pkId);
        entry?.anchors.forEach(collect);
      }
    }
    // 榜单头像
    for (const period of ["all", "month", "week"] as Period[]) {
      const board = leaderboards[period];
      if (!board) continue;
      for (const key of ["leiFeng", "chiHuo", "jingLi"] as LeaderBoardKey[]) {
        for (const row of board[key]) {
          if (!row.uid || requestedFaces.current.has(row.uid)) continue;
          requestedFaces.current.add(row.uid);
          needed.push({ uid: row.uid, roomId: 0 });
        }
      }
    }
    if (needed.length === 0) return;
    void (async () => {
      // 分批请求，避免单次 URL 过长。
      // 注意：不能因为 effect 重跑就中断后续批次，否则剩余 UID 会永久被
      // requestedFaces 占位而不再请求，头像就永远加载不出来。
      for (let i = 0; i < needed.length; i += 30) {
        const chunk = needed.slice(i, i + 30);
        try {
          const res = await fetch(
            `/api/medical-fee/faces?items=${chunk.map((x) => `${x.uid}:${x.roomId}`).join(",")}`,
            { cache: "no-store" },
          );
          const json = await res.json();
          if (json?.code !== 0) {
            for (const item of chunk) requestedFaces.current.delete(item.uid);
            continue;
          }
          const got = json.data as Record<string, { uname: string; face: string }>;
          setFaces((prev) => {
            const next = { ...prev };
            for (const [key, value] of Object.entries(got)) {
              if (value?.face) next[Number(key)] = fixImage(value.face);
            }
            return next;
          });
        } catch {
          // 请求失败时释放占位，后续依赖变化时可以重试
          for (const item of chunk) requestedFaces.current.delete(item.uid);
        }
      }
    })();
  }, [expanded, data, leaderboards]);

  // ===== 微信群登记 =====

  const toggleMembership = async (groupId: string, add: boolean) => {
    if (!uid) {
      showToast("请先填写并保存你的 UID");
      return;
    }
    setMembershipBusy(true);
    try {
      const res = await fetch("/api/medical-fee/membership", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, groupId, action: add ? "add" : "remove" }),
      });
      const json = await res.json();
      if (json?.code !== 0) {
        showToast(json?.message || "保存失败");
        return;
      }
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              groups: prev.groups.map((g) => {
                if (g.id !== groupId) return g;
                const already = g.members.includes(uid);
                const members = add
                  ? already
                    ? g.members
                    : [...g.members, uid]
                  : g.members.filter((u) => u !== uid);
                return {
                  ...g,
                  mine: add,
                  members,
                  memberCount: members.length,
                };
              }),
            }
          : prev,
      );
      setGroupModal(null);
      showToast(add ? "已添加到我的微信群" : "已从我的微信群移除");
    } catch {
      showToast("网络异常，请稍后重试");
    } finally {
      setMembershipBusy(false);
    }
  };

  // ===== 派生数据 =====

  const groups = config?.groups ?? [];
  const entries = data?.entries ?? [];
  const filteredEntries = entries.filter((e) => {
    if (filter === "paid") return Boolean(e.saved && e.saved.payerUid === uid);
    if (filter === "received") return Boolean(e.saved && uid && e.saved.receiverUids.includes(uid));
    return true;
  });
  const activeEntries = filteredEntries.filter((e) => !e.expired);
  const expiredEntries = filteredEntries.filter((e) => e.expired);
  const modalGroup = groupModal ? groups.find((g) => g.id === groupModal) ?? null : null;

  return (
    <>
      <header className="text-center">
        <p className="text-[14px] leading-6 text-[#6d6470] sm:text-[15px]">
          多人接力 PK，快速算出医药费要发在哪些微信群
        </p>
      </header>

      {/* ===== 医药费微信群统计（页面最上方） ===== */}
      <section className="mt-10 rounded-2xl border border-black/[0.07] bg-white px-4 py-4 shadow-[0_20px_56px_-32px_rgba(120,80,120,0.4)] sm:px-6">
        <div className="flex items-center justify-center gap-2">
          <span className="text-[17px] font-semibold">医药费微信群统计</span>
          <span className="text-[12px] text-black/35">{groups.length} 个群</span>
        </div>
        <p className="mt-2 text-[13px] leading-5 text-black/45">
          医药费仍然通过主播微信群收发，这里只是方便统计发在哪些群。点击选择你所在的微信群：
        </p>
        {groups.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-black/[0.015] px-4 py-5 text-center text-[13px] text-black/40">
            管理员还没有配置医药费微信群
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {groups.map((g) => {
              const my = g.mine;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGroupModal(g.id)}
                  className={`group flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-left transition active:scale-[0.97] ${
                    my
                      ? "border-transparent text-white shadow-[0_6px_18px_-10px_rgba(0,0,0,0.5)]"
                      : "border-black/10 bg-white hover:border-black/25"
                  }`}
                  style={my ? { backgroundColor: groupColor(g.index) } : undefined}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${
                      my ? "bg-white/25 text-white" : "text-white"
                    }`}
                    style={my ? undefined : { backgroundColor: groupColor(g.index) }}
                  >
                    {g.index}
                  </span>
                  <span className={`max-w-[150px] truncate text-[13px] font-medium ${my ? "text-white" : "text-black/70"}`}>
                    {g.name}
                  </span>
                  {my && <CheckIcon className="h-3 w-3 shrink-0 text-white/90" />}
                </button>
              );
            })}
          </div>
        )}
        {!uid && (
          <p className="mt-2 text-center text-[12px] text-black/35">填写 UID 后即可登记自己所在的微信群。</p>
        )}
      </section>

      {/* ===== UID 输入 / 我的身份 ===== */}
      <section className="mt-8 rounded-2xl border border-black/[0.07] bg-white p-4 shadow-[0_20px_56px_-32px_rgba(120,80,120,0.4)] sm:p-7">
        {!uid ? (
          <>
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.04] text-black/60">
                <UserIcon className="h-4 w-4" />
              </span>
              输入你的 UID，开始发放医药费
            </div>
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                submitUid();
              }}
            >
              <input
                value={uidInput}
                onChange={(e) => setUidInput(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="请输入 B站 UID（纯数字）"
                inputMode="numeric"
                className="min-w-0 flex-1 rounded-2xl border border-black/10 bg-white px-4 py-3 text-[14px] outline-none transition focus:border-[#39b992] focus:ring-4 focus:ring-[#39b992]/15"
              />
              <button
                type="submit"
                className="rounded-2xl bg-[#221d24] px-6 py-3 text-[13px] font-medium text-white transition hover:opacity-90"
              >
                开始
              </button>
            </form>
            <p className="mt-3 text-[12px] leading-5 text-black/40">
              无需登录。UID 会记住，也会用于登记你所在的医药费微信群。
            </p>
          </>
        ) : (
          <>
          <div className="flex flex-wrap items-center gap-4">
            {(data?.face && fixImage(data.face)) || profile?.face || faces[uid] ? (
              <img
                src={fixImage(data?.face) || profile?.face || faces[uid]}
                alt={data?.uname || profile?.uname || ""}
                className="h-14 w-14 rounded-full object-cover shadow-sm"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/5 text-black/30">
                <UserIcon className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[17px] font-semibold">
                {data?.uname || profile?.uname || (loading ? "加载中…" : `UID ${uid}`)}
              </div>
              <div className="mt-1 text-[12px] text-black/40">{uid}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  void loadConfig(uid);
                  void loadRecords(uid, true);
                }}
                disabled={refreshing}
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-[12px] text-black/60 transition hover:border-black/25 active:scale-90 disabled:opacity-60"
              >
                {refreshing ? "刷新中…" : "刷新"}
              </button>
              <button
                onClick={changeUid}
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-[12px] text-black/60 transition hover:border-black/25"
              >
                更换 UID
              </button>
            </div>
          </div>
          <div className="mt-5 border-t border-black/[0.06] pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold">PK记录</span>
          {data && (
            <div className="ml-auto flex items-center gap-1.5">
              {(
                [
                  { key: "all", label: "本月全部" },
                  { key: "paid", label: `本月已发${data.monthlyPaidCount}次` },
                  { key: "received", label: `本月已吃${data.monthlyReceivedCount}次` },
                ] as const
              ).map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition ${
                    filter === f.key
                      ? "bg-[#221d24] text-white"
                      : "border border-black/10 bg-white text-black/50 hover:border-black/25"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="mt-2 text-[13px] leading-5 text-black/45">
          只统计已结束且未流局，有效期2小时内的多人接力PK。只能记录到PK条结束时的分数，如果分数不准确，可以手动修改分数、指定发/收。
        </p>

        {!uid ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-black/[0.015] px-4 py-6 text-center text-[13px] text-black/40">
            填写 UID 后查看本月 PK 记录
          </p>
        ) : loading && !data ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-black/[0.015] px-4 py-6 text-center text-[13px] text-black/40">
            正在读取 PK 记录…
          </p>
        ) : error ? (
          <p className="mt-3 rounded-xl border border-dashed border-red-200 bg-red-50 px-4 py-6 text-center text-[13px] text-red-500">
            {error}
          </p>
        ) : activeEntries.length === 0 && expiredEntries.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-black/[0.015] px-4 py-6 text-center text-[13px] text-black/40">
            本月还没有可发放医药费的多人 PK 记录（流局场次已自动隐藏）。
          </p>
        ) : (
          <div className="mt-3 overflow-hidden rounded-2xl border border-black/[0.07] bg-[#fbfaff]">
            {activeEntries.map((entry, idx) => (
              <RecordBlock
                key={entry.pkId}
                entry={entry}
                index={idx}
                open={expanded.has(entry.pkId)}
                edit={edits[entry.pkId]}
                saving={Boolean(saving[entry.pkId])}
                groups={groups}
                uid={uid}
                faces={faces}
                onToggle={() => toggleEntry(entry)}
                onScore={updateScore}
                onRole={updateRole}
              />
            ))}
            {expiredEntries.length > 0 && (
              <div className={activeEntries.length > 0 ? "border-t border-black/[0.06]" : ""}>
                <button
                  type="button"
                  onClick={() => setExpiredOpen((v) => !v)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[12px] text-black/45 transition hover:bg-black/[0.02]"
                >
                  <LockIcon className="h-3.5 w-3.5" />
                  <span>已过期记录（{expiredEntries.length}）</span>
                  <span className="ml-auto">{expiredOpen ? "收起" : "展开"}</span>
                  <ChevronIcon
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${expiredOpen ? "rotate-90" : ""}`}
                  />
                </button>
                {expiredOpen &&
                  expiredEntries.map((entry) => (
                    <div
                      key={entry.pkId}
                      className="flex items-center gap-2 border-t border-black/[0.04] px-2.5 py-2 text-[12px] text-black/40"
                    >
                      <span className="w-9 shrink-0 text-center text-[12px] tabular-nums text-black/35">
                        {formatClock(entry.startAt)}
                      </span>
                      <span className="truncate">
                        {formatDateTime(entry.startAt)} · {entry.participants} 人
                      </span>
                      <span className="ml-auto shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px]">
                        {entry.saved
                          ? `已发 ${money(entry.saved.payerAmount)} 元 · 每人 ${money(entry.saved.perPerson)}`
                          : "已过期"}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <p className="mt-3 text-center text-[13px] text-black/45">
          💗未抢到医药费的主播可以去「备用药」页面抽一份小礼物💗
        </p>
          </div>
          </>
        )}
      </section>

      {/* ===== 医药费排行榜（不套外层大卡，三个榜单直接作为卡片） ===== */}
      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <div className="group relative inline-flex" ref={hintRef}>
            <button
              type="button"
              onClick={() => setTipOpen((v) => !v)}
              aria-label="统计说明"
              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-black/40 transition hover:text-black/70"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 11v5.5" />
                <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <div
              className={`absolute left-1/2 top-full z-20 mt-2 w-64 max-w-[72vw] -translate-x-1/2 rounded-xl bg-[#221d24] px-3 py-2 text-[12px] leading-5 text-white/85 shadow-[0_10px_30px_-10px_rgba(34,29,36,0.8)] transition ${
                tipOpen ? "visible opacity-100" : "invisible opacity-0 group-hover:visible group-hover:opacity-100"
              }`}
            >
              只统计通过本网站收发的医药费，只供娱乐，切勿较真，如果有主播不适，可以联系排除
            </div>
          </div>
          <span className="text-[17px] font-semibold">医药费排行榜</span>
          <div className="inline-flex rounded-full border border-black/10 bg-white p-0.5">
            {PERIOD_LABELS.map((p) => (
              <button
                key={p.key}
                onClick={() => {
                  setLeaderPeriod(p.key);
                  if (!leaderboards[p.key]) void loadLeaderboards(uid ?? 0, p.key);
                }}
                className={`rounded-full px-2.5 py-0.5 text-[12px] font-medium transition ${
                  leaderPeriod === p.key ? "bg-[#221d24] text-white" : "text-black/45 hover:text-black/70"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {(Object.keys(LEADER_META) as LeaderBoardKey[]).map((key) => {
            const meta = LEADER_META[key];
            const period = leaderPeriod;
            const board = leaderboards[period];
            const rows = board?.[key] ?? [];
            const myRow = board?.me?.[key] ?? null;
            const unit = key === "leiFeng" ? "元" : key === "chiHuo" ? "元" : "元";
            return (
              <div
                key={key}
                className="rounded-2xl border border-black/[0.07] bg-white p-3 shadow-[0_20px_56px_-32px_rgba(120,80,120,0.4)] sm:px-2 sm:py-3"
              >
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className={`text-[14px] font-semibold ${meta.accent}`}>{meta.title}</span>
                  <span className="text-[13px] font-medium text-black/55">{meta.desc}</span>
                </div>
                {rows.length === 0 && !myRow ? (
                  <p className="py-4 text-center text-[12px] text-black/35">本时间段暂无记录</p>
                ) : (
                  <div className="mt-2 overflow-hidden rounded-xl border border-black/[0.05] bg-white">
                    {/* 我不在榜单时置顶显示（带我的真实排名） */}
                    {myRow && !rows.some((r) => r.uid === myRow.uid) && (
                      <div className="flex items-center gap-2 bg-[#fff7d6] px-2.5 py-1.5">
                        <span className="w-5 shrink-0 text-center text-[12px] font-semibold tabular-nums text-[#8a6d1b]">
                          {myRow.rank}
                        </span>
                        {faces[myRow.uid] ? (
                          <img src={faces[myRow.uid]} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                        ) : (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[11px] text-black/30">
                            人
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                          {myRow.uname || `UID ${myRow.uid}`}
                        </span>
                        <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${meta.accent}`}>
                          {money(myRow.value)}
                          <span className="ml-0.5 text-[11px] font-normal text-black/35">{unit}</span>
                        </span>
                      </div>
                    )}
                    {rows.map((row) => {
                      const highlight = uid ? row.uid === uid : false;
                      return (
                        <div
                          key={row.uid}
                          className={`flex items-center gap-2 px-2.5 py-1.5 ${highlight ? "bg-[#fff7d6]" : "odd:bg-black/[0.015]"}`}
                        >
                          <span
                            className={`w-5 shrink-0 text-center text-[12px] font-semibold tabular-nums ${
                              row.rank === 1
                                ? "text-[#d4a017]"
                                : row.rank === 2
                                  ? "text-[#9aa0a6]"
                                  : row.rank === 3
                                    ? "text-[#b87333]"
                                    : "text-black/35"
                            }`}
                          >
                            {row.rank}
                          </span>
                          {faces[row.uid] ? (
                            <img src={faces[row.uid]} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                          ) : (
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[11px] text-black/30">
                              人
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-[13px]">
                            {row.uname || `UID ${row.uid}`}
                          </span>
                          <span className={`shrink-0 text-[13px] font-semibold tabular-nums ${meta.accent}`}>
                            {money(row.value)}
                            <span className="ml-0.5 text-[11px] font-normal text-black/35">{unit}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== 说明（默认折叠，参考备用药「活动规则」） ===== */}
      <section className="mt-8 overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_20px_56px_-32px_rgba(120,80,120,0.35)]">
        <button
          type="button"
          onClick={() => setRulesOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-4 py-4 text-left sm:px-6"
        >
          <span className="text-[15px] font-semibold">说明</span>
          <ChevronIcon
            className={`h-4 w-4 text-black/40 transition-transform ${rulesOpen ? "rotate-90" : ""}`}
          />
        </button>
        {rulesOpen && (
          <div className="space-y-2.5 border-t border-black/[0.06] px-4 py-5 text-[13px] leading-6 text-black/55 sm:px-6">
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              「发红包的微信群方案」会用最少的微信群覆盖全部发/收主播，首次使用请先点击群登记自己所在的微信群。
            </p>
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              只展示本月的「多人接力 PK」记录，不包含分组 PK / 竞技 / 流局。有效期只有开局2个小时内，因为通常不会打到2小时，而且医药费结算都是当场。
            </p>
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              记录的是 PK 条结束时的分数，可能并不准确（例如时长超过 1 小时、中途掉线结束 PK）。如果 7 人局在 1 小时后才打满，不会被识别为抢医药费，不显示在记录中。如果分数不准确，可以手动调修改分数，指定发/收，最合适的群会自动调整。
            </p>
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              排行榜按历史 / 本月 / 本周自动统计发、吃、净吃金额。
            </p>
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              未抢到医药费的主播可以去「备用药」页面抽一份小礼物，聊胜于无。
            </p>
            <p>
              <span className="mr-1.5 text-[15px] font-bold text-[#2e9e6b]">•</span>
              免责声明：使用本网站一定要核对，任何原因导致的医药费错发/错收以及其他纠纷，本网站都不负责。
            </p>
          </div>
        )}
      </section>

      {/* ===== 页脚 ===== */}
      <SiteHomeButton />
      {/* ===== 微信群详情弹窗 ===== */}
      {modalGroup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6"
          onClick={() => {
            if (!membershipBusy) setGroupModal(null);
          }}
        >
          <div
            className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold text-white"
                style={{ backgroundColor: groupColor(modalGroup.index) }}
              >
                {modalGroup.index}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{modalGroup.name}</span>
              <span className="shrink-0 text-[11px] text-black/35">{modalGroup.memberCount} 位主播已登记</span>
            </div>

            <div className="mt-3 overflow-hidden rounded-xl border border-black/[0.08] bg-black/[0.02]">
              {modalGroup.image ? (
                <img
                  src={fixImage(modalGroup.image)}
                  alt={`${modalGroup.name} 微信群截图`}
                  className="mx-auto max-h-[55vh] w-auto object-contain"
                />
              ) : (
                <p className="py-16 text-center text-[13px] text-black/35">管理员还没有上传该群截图</p>
              )}
            </div>
            <div className="mt-4 flex items-center gap-2">
              {modalGroup.mine ? (
                <button
                  onClick={() => void toggleMembership(modalGroup.id, false)}
                  disabled={membershipBusy}
                  className="flex-1 rounded-xl border border-red-200 bg-red-50 py-2.5 text-[13px] font-medium text-red-500 transition hover:bg-red-100 disabled:opacity-50"
                >
                  {membershipBusy ? "保存中…" : "移除"}
                </button>
              ) : (
                <button
                  onClick={() => void toggleMembership(modalGroup.id, true)}
                  disabled={membershipBusy || !uid}
                  className="flex-1 rounded-xl bg-[#221d24] py-2.5 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                >
                  {membershipBusy ? "保存中…" : "添加"}
                </button>
              )}
              <button
                onClick={() => setGroupModal(null)}
                disabled={membershipBusy}
                className="flex-1 rounded-xl border border-black/10 bg-white py-2.5 text-[13px] text-black/50 transition hover:border-black/25 disabled:opacity-40"
              >
                取消
              </button>
            </div>
            {!uid && <p className="mt-2 text-center text-[12px] text-black/35">请先填写 UID 才能添加</p>}
          </div>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center px-4">
          <div className="rounded-full bg-[#221d24]/92 px-4 py-2 text-[13px] text-white shadow-lg">{toast}</div>
        </div>
      )}
    </>
  );
}

/** 单条 PK 记录（折叠标题 + 展开后的主播行） */
function RecordBlock({
  entry,
  index,
  open,
  edit,
  saving,
  groups,
  uid,
  faces,
  onToggle,
  onScore,
  onRole,
}: {
  entry: Entry;
  index: number;
  open: boolean;
  edit: EditState | undefined;
  saving: boolean;
  groups: GroupPublic[];
  uid: number | null;
  faces: Record<number, string>;
  onToggle: () => void;
  onScore: (pkId: number, anchorUid: number, value: number) => void;
  onRole: (pkId: number, anchorUid: number, role: "fa" | "shou" | "none") => void;
}) {
  const roles: FeeRoles = edit
    ? { payerUid: edit.payerUid, receiverUids: edit.receiverUids }
    : entry.saved
      ? { payerUid: entry.saved.payerUid, receiverUids: entry.saved.receiverUids }
      : defaultFeeRoles(entry.anchors);
  const scores = edit?.scores ?? entry.saved?.scores ?? null;
  const split = calcFeeSplit(
    entry.anchors.map((a) => ({ uid: a.uid, votes: scores?.[a.uid] ?? a.votes })),
    roles,
  );
  const full = (scores?.[roles.payerUid] ?? split.payerScore) >= 55000;
  const wechatGroups: WeChatGroup[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    index: g.index,
    members: g.members,
  }));
  const plan = planFeeGroups(wechatGroups, split.payerUid, split.receiverUids);
  const names = new Map(entry.anchors.map((a) => [a.uid, a.name]));

  return (
    <div className={index > 0 ? "border-t border-black/[0.06]" : ""}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-2.5 text-left transition hover:bg-black/[0.02]"
      >
        {entry.expired ? (
          <LockIcon className="h-3.5 w-3.5 shrink-0 text-black/30" />
        ) : (
          <ChevronIcon className={`h-3.5 w-3.5 shrink-0 text-black/40 transition-transform ${open ? "rotate-90" : ""}`} />
        )}
        <span className="shrink-0 text-[13px] tabular-nums text-black/55">{formatDateTime(entry.startAt)}</span>
        <span className="shrink-0 text-[11px] text-black/35">{entry.participants} 人</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ${
            full ? "bg-rose-50 text-rose-500" : "bg-black/[0.04] text-black/40"
          }`}
        >
          {full ? "已打满" : "未打满"}
        </span>
        {split.payerUid > 0 ? (
          <span className="min-w-0 truncate text-[12px] text-black/45">
            医药费 {money(split.total)} 元 · 每人 {money(split.perPerson)}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[12px] text-black/35">未指定发医药费</span>
        )}
        <span className="ml-auto shrink-0">
          {entry.expired ? (
            <span className="text-[11px] text-black/30">已过期</span>
          ) : saving ? (
            <span className="text-[11px] text-[#39b992]">保存中…</span>
          ) : entry.saved ? (
            <span className="text-[11px] text-black/35">已保存 {formatTime(entry.saved.updatedAt)}</span>
          ) : (
            <span className="text-[11px] text-black/30">10 秒后自动保存</span>
          )}
        </span>
      </button>

      {open && !entry.expired && edit && (
        <div className="border-t border-black/[0.04] bg-white/60 px-2 py-2">
          <AnchorRows
            entry={entry}
            edit={edit}
            groups={wechatGroups}
            uid={uid}
            faces={faces}
            onScore={onScore}
            onRole={onRole}
          />
          <div className="mt-2 rounded-xl border border-black/[0.06] bg-[#fbfaff] px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="font-semibold text-[#c0392b]">发</span>
              {split.payerUid > 0 ? (
                <span className="rounded-full bg-[#fdecea] px-2 py-0.5 text-[12px] text-[#c0392b]">
                  {names.get(split.payerUid) || `UID ${split.payerUid}`}
                </span>
              ) : (
                <span className="text-black/35">未指定</span>
              )}
              <span className="ml-2 font-semibold text-[#2e9e6b]">收</span>
              {split.receiverUids.length > 0 ? (
                split.receiverUids.map((u) => (
                  <span key={u} className="rounded-full bg-[#e9f7f0] px-2 py-0.5 text-[12px] text-[#2e9e6b]">
                    {names.get(u) || `UID ${u}`}
                  </span>
                ))
              ) : (
                <span className="text-black/35">未指定</span>
              )}
              {split.payerUid > 0 && split.receiverUids.length > 0 && (
                <span className="ml-auto shrink-0 tabular-nums text-black/45">
                  {money(split.total)} 元 ÷ {split.receiverUids.length} 人 = <span className="font-semibold text-[#2e9e6b]">{money(split.perPerson)}</span> 元
                </span>
              )}
            </div>
          </div>

          {/* 发红包方案 */}
          <div className="mt-2 rounded-xl border border-black/[0.06] bg-white px-2.5 py-2">
            <div className="text-[12px] font-semibold text-black/60">发红包的微信群方案</div>
            {plan.payerMissing && (
              <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[12px] text-amber-600">
                发医药费的主播还没有登记所在的微信群，请先点击上方群徽章登记。
              </p>
            )}
            {plan.missingReceiverUids.length > 0 && (
              <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[12px] text-red-500">
                未登记所在群：{plan.missingReceiverUids.map((u) => names.get(u) || `UID ${u}`).join("、")}
              </p>
            )}
            {plan.groups.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {plan.groups.map(({ group, receiverUids }) => (
                  <span
                    key={group.id}
                    className="flex items-center gap-1 rounded-full border border-black/10 bg-[#fbfaff] py-0.5 pl-1 pr-2 text-[12px]"
                  >
                    <span
                      className="flex h-4 w-4 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                      style={{ backgroundColor: groupColor(group.index) }}
                    >
                      {group.index}
                    </span>
                    <span className="max-w-[110px] truncate font-medium">{group.name}</span>
                    <span className="text-black/40">收：{receiverUids.map((u) => names.get(u) || `UID ${u}`).join("、")}</span>
                  </span>
                ))}
              </div>
            ) : (
              !plan.payerMissing &&
              split.payerUid > 0 &&
              split.receiverUids.length > 0 && (
                <p className="mt-1 text-[12px] text-black/35">没有能同时覆盖发/收主播的微信群</p>
              )
            )}
            {split.payerUid === 0 || split.receiverUids.length === 0 ? (
              <p className="mt-1 text-[12px] text-black/35">指定发/收主播后自动计算最优发群方案</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** 主播行：序号 + 徽章 + 可编辑分数 + 发/收按钮（分数变化时带 FLIP 排序动画） */
function AnchorRows({
  entry,
  edit,
  groups,
  uid,
  faces,
  onScore,
  onRole,
}: {
  entry: Entry;
  edit: EditState;
  groups: WeChatGroup[];
  uid: number | null;
  faces: Record<number, string>;
  onScore: (pkId: number, anchorUid: number, value: number) => void;
  onRole: (pkId: number, anchorUid: number, role: "fa" | "shou" | "none") => void;
}) {
  const rows = [...entry.anchors].sort(
    (a, b) => (edit.scores[b.uid] ?? b.votes) - (edit.scores[a.uid] ?? a.votes) || a.uid - b.uid,
  );
  const signature = rows.map((r) => r.uid).join(",");
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevRects = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>("[data-row-uid]"));
    const next = new Map<number, number>();
    for (const node of nodes) {
      const id = Number(node.dataset.rowUid);
      if (!id) continue;
      next.set(id, node.getBoundingClientRect().top);
      const old = prevRects.current.get(id);
      if (old === undefined) continue;
      const dy = old - node.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      node.style.transition = "none";
      node.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        node.style.transition = "transform 320ms cubic-bezier(0.22, 0.65, 0.3, 1)";
        node.style.transform = "";
      });
    }
    prevRects.current = next;
    // signature 变化即排序变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <div ref={listRef}>
      {rows.map((anchor, i) => {
        const score = edit.scores[anchor.uid] ?? anchor.votes;
        const isPayer = edit.payerUid === anchor.uid;
        const isReceiver = edit.receiverUids.includes(anchor.uid);
        const inAnyGroup = groups.some((g) => g.members.includes(anchor.uid));
        const face = faces[anchor.uid];
        return (
          <div
            key={anchor.uid}
            data-row-uid={anchor.uid}
            className="flex items-center gap-2 px-1.5 py-1 will-change-transform"
          >
            <span className="w-4 shrink-0 text-center text-[13px] tabular-nums text-black/35">{i + 1}</span>
            <div
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 ${
                isPayer
                  ? "border-red-200 bg-red-50"
                  : isReceiver
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-black/10 bg-white"
              }`}
            >
              {face ? (
                <img src={face} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.05] text-[11px] text-black/30">
                  {(anchor.name || "人").slice(0, 1)}
                </span>
              )}
              <span className="min-w-0 truncate text-[13px] font-medium">
                {anchor.name || `UID ${anchor.uid}`}
                {uid === anchor.uid && <span className="ml-1 text-[11px] text-black/35">我</span>}
              </span>
              {!inAnyGroup && (
                <span
                  title="该主播还没有登记所在微信群"
                  className="shrink-0 rounded bg-amber-50 px-1 text-[11px] text-amber-600"
                >
                  未登记群
                </span>
              )}
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={score}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^\d]/g, "");
                onScore(entry.pkId, anchor.uid, digits ? Number(digits) : 0);
              }}
              onFocus={(e) => e.currentTarget.select()}
              className="w-[70px] shrink-0 rounded-lg border border-black/10 bg-white px-1.5 py-0.5 text-right text-[13px] tabular-nums outline-none transition focus:border-[#39b992]"
            />
            <button
              type="button"
              title="设为发医药费"
              onClick={() => onRole(entry.pkId, anchor.uid, isPayer ? "none" : "fa")}
              className={`h-7 w-7 shrink-0 rounded-full border text-[12px] font-medium transition active:scale-90 ${
                isPayer
                  ? "border-red-500 bg-red-500 text-white"
                  : "border-red-200 bg-white text-red-500 hover:bg-red-50"
              }`}
            >
              发
            </button>
            <button
              type="button"
              title="设为收医药费"
              onClick={() => onRole(entry.pkId, anchor.uid, isReceiver ? "none" : "shou")}
              className={`h-7 w-7 shrink-0 rounded-full border text-[12px] font-medium transition active:scale-90 ${
                isReceiver
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : "border-emerald-200 bg-white text-emerald-600 hover:bg-emerald-50"
              }`}
            >
              收
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ===== 内联图标（避免引入图标库） =====

function UserIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c0-3.4 3.1-5.5 7-5.5s7 2.1 7 5.5" />
    </svg>
  );
}

function CheckIcon({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function LockIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="3" />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
    </svg>
  );
}

function ChevronIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
