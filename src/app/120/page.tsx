"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { getPlatform } from "@/lib/platform";

const UID_STORAGE_KEY = "bili_live_micro_light_uid";

type PrizeKind = "special" | "consolation" | "normal";

type Prize = {
  id: string;
  kind: PrizeKind;
  name: string;
  img: string;
  battery: number;
  text: string;
};

type Sponsor = { uid: number; uname: string; face: string; note?: string };

type PublicConfig = {
  enabled: boolean;
  seasonId: number;
  drawWindowHours: number;
  monthlyWinCap: number;
  voidScoreThreshold: number;
  votesPerBattery: number;
  prizes: Prize[];
  sponsors: Sponsor[];
};

type DrawStatus = "miss" | "pending" | "granted" | "void";

type DrawRecord = {
  id: string;
  pkId: number;
  uid: number;
  uname: string;
  face?: string;
  month: string;
  pkEndTime: number;
  votes: number;
  rank: number;
  participants: number;
  secondVotes: number;
  /** 旧字段（历史记录可能仍有） */
  playedFull?: boolean;
  prizeKind: PrizeKind | "none";
  prizeName: string;
  prizeText: string;
  prizeImg?: string;
  battery: number;
  drawnAt: string;
  status: DrawStatus;
};

type EntryState = "drawable" | "void" | "drawn" | "expired" | "locked" | "paused";

type Anchor = {
  name: string;
  votes: number;
  roomId: number;
  uid: number;
  isSelf: boolean;
  rank: number;
  drawn: boolean;
};

type Entry = {
  pkId: number;
  startAt: number;
  endAt: number;
  duration: number;
  participants: number;
  votes: number;
  rank: number;
  secondVotes: number;
  anchors: Anchor[];
  state: EntryState;
  reason: string;
  draw?: DrawRecord;
};

type RecordsData = {
  uid: number;
  uname: string;
  face: string;
  roomId: number;
  seasonId: number;
  month: string;
  enabled: boolean;
  monthlyWinCap: number;
  monthlyWins: number;
  entries: Entry[];
  draws: DrawRecord[];
  prizes: Array<{ id: string; kind: PrizeKind; name: string; img: string; text: string }>;
};

/** 全部抽奖记录：与 PK 记录解耦，只展示落库的抽奖信息 */
type AllDraw = {
  id: string;
  uid: number;
  uname: string;
  face: string;
  month: string;
  pkId: number;
  prizeKind: PrizeKind | "none";
  prizeName: string;
  prizeText: string;
  prizeImg: string;
  drawnAt: string;
  status: DrawStatus;
};

function fixImage(url?: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateTime(tsSeconds: number): string {
  if (!tsSeconds) return "-";
  const d = new Date(tsSeconds * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 票数简写（万） */
function formatVotes(v: number): string {
  if (v >= 10000) {
    const w = v / 10000;
    return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return String(v);
}

/** 中奖期望的票数上限：第二名票数超过 5.5 万时按 5.5 万计算（与服务端一致） */
const EXPECTATION_VOTES_CAP = 55_000;

/** 本局礼物价值期望（电池，取整数）：min(第二名票数, 5.5万) ÷ 中奖期望分母 */
function expectedBattery(secondVotes: number, votesPerBattery: number): number {
  const votes = Math.min(EXPECTATION_VOTES_CAP, Math.max(0, Number(secondVotes) || 0));
  return Math.round(votes / Math.max(1, Number(votesPerBattery) || 1));
}

/** 记录状态：未抽奖 / 未中奖 / 已中奖 / 已被抢抽 / 已过期 */
function entryStatus(entry: Entry): { text: string; cls: string } {
  switch (entry.state) {
    case "drawable":
      return { text: "未抽奖", cls: "border-black/10 bg-white text-black/45" };
    case "drawn": {
      if (entry.draw?.status === "void") {
        return { text: "已作废", cls: "border-black/10 bg-black/[0.04] text-black/40" };
      }
      const won = entry.draw && entry.draw.prizeKind !== "none" && entry.draw.status !== "miss";
      return won
        ? { text: "已中奖", cls: "border-rose-300 bg-rose-100 text-rose-700" }
        : { text: "未中奖", cls: "border-black/10 bg-black/[0.04] text-black/45" };
    }
    case "locked":
      return { text: "已被抢抽", cls: "border-black/10 bg-black/[0.04] text-black/40" };
    case "expired":
      return { text: "已过期", cls: "border-black/10 bg-black/[0.04] text-black/35" };
    case "paused":
      return { text: "活动关闭", cls: "border-amber-200 bg-amber-50 text-amber-600" };
    default:
      return { text: "不可抽", cls: "border-black/10 bg-white text-black/35" };
  }
}

/** 北京时间的自然月键：2026-11 */
function monthKeyNow(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** 北京时间的日期键：2026-11-03 */
function dayKeyNow(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const RECORDS_CACHE_PREFIX = "bili_live_micro_light_records_";
/** PK 记录缓存：历史日期数据不可变，缓存到浏览器减轻服务端压力 */
type RecordsCache = { day: string; savedAt: number; data: RecordsData };

function readRecordsCache(uid: number): RecordsCache | null {
  try {
    const raw = localStorage.getItem(`${RECORDS_CACHE_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecordsCache;
    if (!parsed?.data?.entries || parsed.data.month !== monthKeyNow()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRecordsCache(uid: number, data: RecordsData) {
  try {
    // 只保留当前 UID 的缓存，避免长期累积占用空间
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(RECORDS_CACHE_PREFIX) && key !== `${RECORDS_CACHE_PREFIX}${uid}`) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem(
      `${RECORDS_CACHE_PREFIX}${uid}`,
      JSON.stringify({ day: dayKeyNow(), savedAt: Date.now(), data } satisfies RecordsCache),
    );
  } catch {
    /* 隐私模式 / 超额等场景忽略 */
  }
}

function drawStatusLabel(status: DrawStatus): { label: string; cls: string } {
  switch (status) {
    case "pending":
      return { label: "待发放", cls: "bg-amber-50 text-amber-600 border-amber-200" };
    case "granted":
      return { label: "已发放", cls: "bg-emerald-50 text-emerald-600 border-emerald-200" };
    case "void":
      return { label: "已作废", cls: "bg-black/5 text-black/35 border-black/10" };
    default:
      return { label: "未中奖", cls: "bg-black/5 text-black/45 border-black/10" };
  }
}

/** 名次圆圈序号：①②③…（超过 20 时回退普通数字） */
function circledNumber(n: number): string {
  if (!n || n <= 0) return "?";
  if (n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  return String(n);
}

/**
 * 打开 B站用户个人主页：
 * - 移动端优先用 bilibili://space/{uid} 唤起 APP，1.2s 后回退网页版；
 * - 桌面端直接在新窗口打开 https://space.bilibili.com/{uid}；
 * - Tauri（原生客户端）走 @tauri-apps/plugin-opener。
 */
async function openBiliSpace(uid: number) {
  if (!uid) return;
  const platform = await getPlatform();
  const appScheme = `bilibili://space/${uid}`;
  const webUrl = `https://space.bilibili.com/${uid}`;
  const isMobile =
    platform.os === "android" ||
    platform.os === "ios" ||
    (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));

  if (platform.isNative) {
    let opened = false;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      if (isMobile) {
        try {
          await openUrl(appScheme);
          opened = true;
        } catch {
          /* 协议唤起失败，改用网页版 */
        }
      }
      if (!opened) {
        try {
          await openUrl(webUrl);
          opened = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* plugin-opener 不可用，降级到 window.open */
    }
    if (opened) return;
  }

  if (!isMobile) {
    window.open(webUrl, "_blank", "noopener,noreferrer");
    return;
  }

  // 移动端 Web：先尝试协议唤起 APP，失败后回退网页版
  try {
    const schemeWin = window.open(appScheme, "_blank");
    setTimeout(() => {
      try {
        if (schemeWin) schemeWin.location.href = webUrl;
      } catch {
        /* ignore cross-origin */
      }
    }, 1200);
  } catch {
    window.open(webUrl, "_blank", "noopener,noreferrer");
  }
}

/** 小图标（内联 SVG，避免引入图标库） */
function Icon({ name, className = "w-4 h-4" }: { name: "gift" | "spark" | "lock" | "clock" | "user" | "refresh" | "chevron"; className?: string }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "gift":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <path d="M20 12v9H4v-9M2 7h20v5H2zM12 7v14" />
          <path d="M12 7c-2.5 0-4.5-1-4.5-2.75S9.5 1 12 3.5C14.5 1 18.5 1.5 18.5 3.25S14.5 7 12 7z" />
        </svg>
      );
    case "spark":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <path d="M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z" />
          <path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
        </svg>
      );
    case "lock":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <rect x="4.5" y="10.5" width="15" height="10" rx="3" />
          <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
        </svg>
      );
    case "clock":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "user":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M5 20c0-3.4 3.1-5.5 7-5.5s7 2.1 7 5.5" />
        </svg>
      );
    case "refresh":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <path d="M20 12a8 8 0 10-2.5 5.8" />
          <path d="M20 4v5h-5" />
        </svg>
      );
    case "chevron":
      return (
        <svg viewBox="0 0 24 24" className={className} {...common}>
          <path d="M9 5l7 7-7 7" />
        </svg>
      );
  }
}

export default function MicroLightPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [uidInput, setUidInput] = useState("");
  const [uid, setUid] = useState<number | null>(null);
  const [data, setData] = useState<RecordsData | null>(null);
  const [loading, setLoading] = useState(false);
  /** PK 卡片内「刷新」按钮的加载动画状态 */
  const [refreshingRecords, setRefreshingRecords] = useState(false);
  const [error, setError] = useState("");
  /** 我的 PK 记录筛选：全部 / 已抽 / 已中奖 */
  const [recordFilter, setRecordFilter] = useState<"all" | "drawn" | "won">("all");
  /** 展开的记录 pkId 集合（折叠条） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  /** 已过期记录分组：默认折叠 */
  const [expiredOpen, setExpiredOpen] = useState(false);
  const [allDraws, setAllDraws] = useState<AllDraw[]>([]);
  const [allLoading, setAllLoading] = useState(false);

  const [allMonth, setAllMonth] = useState("");
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | null>(null);

  // 抽奖前的资格确认弹窗（每次抽奖都要确认）
  const [confirmEntry, setConfirmEntry] = useState<Entry | null>(null);
  /** 确认弹窗强制阅读倒计时（秒），归零后才允许点击确认 */
  const [confirmCountdown, setConfirmCountdown] = useState(10);

  // 抽奖弹窗
  const [rollOpen, setRollOpen] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rollIndex, setRollIndex] = useState(0);
  const [rollResult, setRollResult] = useState<DrawRecord | null>(null);
  const [rollError, setRollError] = useState("");
  const rollTimer = useRef<number | null>(null);

  // 确认弹窗强制等待 10 秒：每秒递减，看到 0 后才能点击确认抽奖
  useEffect(() => {
    if (!confirmEntry || confirmCountdown <= 0) return;
    const timer = window.setTimeout(() => setConfirmCountdown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [confirmEntry, confirmCountdown]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const loadRecords = useCallback(
    async (targetUid: number, force = false) => {
      setError("");
      // 先用浏览器缓存秒开：历史 PK 数据不可变，只有今天的记录会变
      const cached = readRecordsCache(targetUid);
      if (cached && !force) {
        // 缓存只负责秒开，抽奖状态必须每次都向服务端校准，避免筛选到过期数据
        setData(cached.data);
      }
      if (!cached || force) setLoading(true);
      try {
        const res = await fetch(`/api/micro-light/records?uid=${targetUid}`, { cache: "no-store" });
        const json = await res.json();
        if (json?.code !== 0) {
          if (!cached) {
            setData(null);
            setError(json?.message || "加载失败，请稍后重试");
          }
          return;
        }
        const next = json.data as RecordsData;
        setData(next);
        writeRecordsCache(targetUid, next);
      } catch {
        if (!cached) {
          setData(null);
          setError("网络异常，请稍后重试");
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /** 只刷新当前卡片中的 PK 记录，不触碰下方「全部抽奖记录」卡片 */
  const refreshPkRecords = useCallback(async () => {
    if (!uid) return;
    setRefreshingRecords(true);
    const started = performance.now();
    try {
      await loadRecords(uid, true);
      // 保证刷新动画至少可见 500ms
      const remain = 500 - (performance.now() - started);
      if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain));
    } finally {
      setRefreshingRecords(false);
    }
  }, [uid, loadRecords]);

  const loadAllDraws = useCallback(async () => {
    setAllLoading(true);
    try {
      const res = await fetch(`/api/micro-light/records/all`, { cache: "no-store" });
      const json = await res.json();
      if (json?.code === 0) setAllDraws((json.data?.list ?? []) as AllDraw[]);
    } catch {
      /* 忽略：全部记录加载失败不影响自己的记录 */
    } finally {
      setAllLoading(false);
    }
  }, []);

  // 首次进入：拉活动配置 + 恢复本地保存的 UID
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/micro-light/config`, { cache: "no-store" });
        const json = await res.json();
        if (json?.code === 0) setConfig(json.data as PublicConfig);
      } catch {
        /* ignore */
      }
    })();
    // 延后一帧执行：避免在 effect 内同步 setState 触发级联渲染告警
    const timer = window.setTimeout(() => {
      void loadAllDraws();
      let saved = "";
      try {
        saved = localStorage.getItem(UID_STORAGE_KEY) ?? "";
      } catch {
        saved = "";
      }
      const savedUid = Number(saved.replace(/[^\d]/g, ""));
      if (savedUid > 0) {
        setUid(savedUid);
        setUidInput(String(savedUid));
        void loadRecords(savedUid);
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      if (rollTimer.current) window.clearInterval(rollTimer.current);
    };
  }, [loadAllDraws, loadRecords]);

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
    setExpanded(new Set());
    setRecordFilter("all");
    void loadRecords(next, true);
  };

  const changeUid = () => {
    setUid(null);
    setData(null);
    setUidInput("");
    setError("");
    setExpanded(new Set());
    setRecordFilter("all");
    try {
      localStorage.removeItem(UID_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const startRoll = async (entry: Entry) => {
    if (!uid || !data) return;
    setRollOpen(true);
    setRolling(true);
    setRollResult(null);
    setRollError("");
    setRollIndex(0);

    // 奖池滚动动画：与请求并行，至少展示 2.4 秒，节奏放慢一些
    const prizeList = data.prizes.length ? data.prizes : config?.prizes ?? [];
    if (rollTimer.current) window.clearInterval(rollTimer.current);
    if (prizeList.length > 0) {
      rollTimer.current = window.setInterval(() => {
        setRollIndex((i) => (i + 1) % prizeList.length);
      }, 260);
    }

    try {
      const [res] = await Promise.all([
        fetch(`/api/micro-light/draw`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid, pkId: entry.pkId, roomId: data.roomId }),
        }).then((r) => r.json()),
        new Promise((r) => setTimeout(r, 2400)),
      ]);
      setRolling(false);
      if (rollTimer.current) {
        window.clearInterval(rollTimer.current);
        rollTimer.current = null;
      }
      if (res?.code !== 0) {
        setRollError(res?.message || "抽奖失败，请稍后重试");
        return;
      }
      const draw = res.data?.draw as DrawRecord;
      setRollResult(draw);
      // 抽奖后强制刷新（PK 缓存里的抽奖状态需要更新）
      void loadRecords(uid, true);
      void loadAllDraws();
    } catch {
      setRolling(false);
      if (rollTimer.current) {
        window.clearInterval(rollTimer.current);
        rollTimer.current = null;
      }
      setRollError("网络异常，请稍后重试");
    }
  };

  const closeRoll = () => {
    if (rolling) return;
    setRollOpen(false);
    setRollResult(null);
    setRollError("");
  };

  // 奖池展示用（自己记录接口不返回电池价值，统一成同一结构）；特别奖固定排最后
  const primaryPrize: Array<{ id: string; kind: PrizeKind; name: string; img: string; text: string }> = [
    ...(data?.prizes?.length ? data.prizes : config?.prizes ?? []),
  ].sort((a, b) => Number(a.kind === "special") - Number(b.kind === "special"));

  // 试玩抽奖：走服务端同一套概率算法（期望 100 电池），但不落库、不占用抽奖名额
  const startDemoRoll = () => {
    const prizeList = primaryPrize;
    if (prizeList.length === 0) {
      showToast("暂无可展示的奖品");
      return;
    }
    setRollOpen(true);
    setRolling(true);
    setRollResult(null);
    setRollError("");
    setRollIndex(0);
    if (rollTimer.current) window.clearInterval(rollTimer.current);
    rollTimer.current = window.setInterval(() => {
      setRollIndex((i) => (i + 1) % prizeList.length);
    }, 260);

    let pick = prizeList[prizeList.length - 1];
    fetch("/api/micro-light/demo", { method: "POST", cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (json?.code === 0 && json.data?.prize) pick = json.data.prize;
      })
      .catch(() => {
        /* 接口异常时退回本地奖品，保证试玩动画仍可完成 */
      });

    window.setTimeout(() => {
      if (rollTimer.current) {
        window.clearInterval(rollTimer.current);
        rollTimer.current = null;
      }
      setRolling(false);
      setRollResult({
        id: "demo",
        pkId: 0,
        uid: uid ?? 0,
        uname: "演示",
        face: "",
        month: monthKeyNow(),
        pkEndTime: 0,
        votes: 0,
        rank: 1,
        participants: 1,
        secondVotes: 0,
        prizeKind: pick.kind,
        prizeName: pick.name,
        prizeText: pick.text || "试玩模拟抽中该奖品",
        prizeImg: pick.img,
        battery: 0,
        drawnAt: new Date().toISOString(),
        status: "pending",
      });
    }, 2400);
  };

  const monthOptions = Array.from(new Set(allDraws.map((d) => d.month))).sort().reverse();
  const filteredDraws = allDraws.filter((d) => (allMonth ? d.month === allMonth : true));

  const wonEntry = (e: Entry) =>
    Boolean(e.draw && e.draw.prizeKind !== "none" && e.draw.status !== "miss" && e.draw.status !== "void");
  const entries = data?.entries ?? [];
  const drawnCount = entries.filter((e) => e.state === "drawn").length;
  const filteredEntries = entries.filter((e) => {
    if (recordFilter === "drawn") return e.state === "drawn";
    if (recordFilter === "won") return e.state === "drawn" && wonEntry(e);
    return true;
  });
  // 已过期记录统一放到列表最下方；已抽奖的过期记录已在上方展示，不再放进过期分组
  const activeEntries = filteredEntries.filter((e) => e.state !== "expired");
  const expiredEntries = filteredEntries.filter((e) => e.state === "expired" && !e.draw);
  const orderedEntries = [...activeEntries, ...expiredEntries];
  const expiredCount = expiredEntries.length;
  const firstExpiredIndex = expiredCount > 0 ? activeEntries.length : -1;
  const toggleEntry = (pkId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pkId)) next.delete(pkId);
      else next.add(pkId);
      return next;
    });
  };

  return (
    <main
      className="min-h-screen text-[#221d24]"
      style={{
        background:
          "radial-gradient(1100px 600px at 10% -10%, rgba(255,170,150,0.34), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(150,190,255,0.3), transparent 55%), #ece4e8",
      }}
    >
      <div className="mx-auto w-full max-w-3xl px-4 pb-20 pt-10 sm:px-6 sm:pt-14">
        {/* ===== 页头 ===== */}
        <header className="text-center">
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            <h1 className="bg-gradient-to-br from-[#ffc477] via-[#ff9c3f] to-[#ef6f1f] bg-clip-text text-[34px] font-semibold leading-tight tracking-tight text-transparent sm:text-[44px]">
              备用药
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium ${
                config?.enabled
                  ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                  : "border-black/10 bg-white text-black/45"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${config?.enabled ? "bg-emerald-500" : "bg-black/30"}`} />
              {config ? (config.enabled ? "进行中" : "已暂停") : "加载中…"}
            </span>
          </div>
          <p className="mt-3 text-[14px] leading-6 text-[#6d6470] sm:text-[15px]">
            多人接力 PK，拼到最后却没吃到医药费的主播，可以在这里抽一份小安慰
          </p>
        </header>

        {/* ===== 本月药神 + 本月奖池（同一张卡片） ===== */}
        <section className="mt-10 rounded-2xl border border-black/[0.07] bg-white px-5 py-4 shadow-[0_18px_50px_-32px_rgba(120,80,120,0.45)] sm:px-6">
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:gap-x-8">
            <div className="flex h-9 items-center gap-2.5">
              <span className="text-[15px] font-medium tabular-nums tracking-[0.08em] text-[#8b5a72]">
                {monthKeyNow().replace("-", ".")}
              </span>
              <span className="text-[17px] font-semibold">本月药神</span>
            </div>
            {(config?.sponsors?.length ?? 0) === 0 ? (
              <span className="flex h-9 items-center text-[12px] text-black/35">虚位以待，欢迎赞助</span>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {config!.sponsors.map((s) => (
                  <button
                    key={`${s.uid}-${s.uname}`}
                    type="button"
                    onClick={() => void openBiliSpace(s.uid)}
                    title={`打开 ${s.uname} 的 B站个人主页`}
                    className="flex h-9 max-w-[190px] items-center gap-2 rounded-full border border-amber-200 bg-amber-50 pl-1 pr-3 text-left transition hover:border-amber-300 hover:bg-amber-100 active:scale-95"
                  >
                    {s.face ? (
                      <img
                        src={fixImage(s.face)}
                        alt={s.uname}
                        className="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-white"
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-400">
                        <Icon name="user" className="h-4 w-4" />
                      </span>
                    )}
                    <span className="truncate text-[13px] font-medium text-amber-800">{s.uname}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {(config?.sponsors ?? []).some((s) => s.note) && (
            <div className="mt-1.5 text-center text-[12px] font-medium text-[#4a4a4a]">
              {(config?.sponsors ?? []).map((s) => s.note).filter(Boolean).join(" · ")}
            </div>
          )}

          {primaryPrize.length > 0 && (
            <>
              <div className="my-3 h-px bg-black/[0.06]" />
              <div className="flex flex-wrap justify-between gap-1.5">
                {primaryPrize.map((p) => (
                  <span
                    key={p.id}
                    className="flex items-center gap-1 rounded-full border border-black/[0.06] bg-[#fbfaff] py-1 pl-1 pr-2.5"
                  >
                    {p.img ? (
                      <img src={fixImage(p.img)} alt="" className="h-5 w-5 shrink-0 rounded object-contain" />
                    ) : (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#fff0f5] text-[#c05880]">
                        <Icon name="gift" className="h-3 w-3" />
                      </span>
                    )}
                    <span className="truncate text-[11px] text-black/65">{p.name}</span>
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={startDemoRoll}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#ffe0ea] to-[#ffe7c8] py-2 text-[12px] font-medium text-[#8b4a68] transition hover:brightness-105 active:scale-[0.99]"
              >
                <Icon name="gift" className="h-4 w-4" />
                试玩抽奖（真实抽奖通过下方PK记录）
              </button>
            </>
          )}
        </section>

        {/* ===== UID 输入 / 我的身份 ===== */}
        <section className="mt-5 rounded-2xl border border-black/[0.07] bg-white p-5 shadow-[0_20px_56px_-32px_rgba(120,80,120,0.4)] sm:p-7">
          {!uid ? (
            <>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/[0.04] text-black/60">
                  <Icon name="user" className="h-4 w-4" />
                </span>
                输入你的 UID，查看 PK 记录
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
                  className="min-w-0 flex-1 rounded-2xl border border-black/10 bg-white px-4 py-3 text-[14px] outline-none transition focus:border-[#f18fb1] focus:ring-4 focus:ring-[#f18fb1]/15"
                />
                <button
                  type="submit"
                  className="rounded-2xl bg-[#221d24] px-6 py-3 text-[13px] font-medium text-white transition hover:opacity-90"
                >
                  查看记录
                </button>
              </form>
              <p className="mt-3 text-[11px] leading-5 text-black/40">
                无需登录。UID 也会记住，短期只需输入一次。
              </p>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              {data?.face ? (
                <img src={fixImage(data.face)} alt={data.uname} className="h-14 w-14 rounded-full object-cover shadow-sm" />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/5 text-black/30">
                  <Icon name="user" className="h-6 w-6" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[17px] font-semibold">{data?.uname || (loading ? "加载中…" : `UID ${uid}`)}</div>
                <div className="mt-1 text-[11px] text-black/40">{uid}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void refreshPkRecords()}
                  disabled={refreshingRecords}
                  className="group flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-[11px] text-black/60 transition hover:border-black/25 active:scale-90 disabled:opacity-60"
                >
                  <Icon
                    name="refresh"
                    className={`h-3.5 w-3.5 transition-transform duration-500 group-active:rotate-180 ${
                      refreshingRecords ? "animate-spin" : ""
                    }`}
                  />
                  {refreshingRecords ? "刷新中" : "刷新"}
                </button>
                <button
                  onClick={changeUid}
                  className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-[11px] text-black/60 transition hover:border-black/25"
                >
                  更换 UID
                </button>
              </div>
              {data && (
                <div className="w-full border-t border-black/[0.06] pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-black/70">PK记录</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {(
                        [
                          { key: "all", label: "本月全部" },
                          {
                            key: "drawn",
                            label: `本月已抽${drawnCount}次`,
                          },
                          {
                            key: "won",
                            label: `本月已中奖(${data.monthlyWins}/${data.monthlyWinCap})`,
                          },
                        ] as const
                      ).map((f) => (
                        <button
                          key={f.key}
                          onClick={() => setRecordFilter(f.key)}
                          className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                            recordFilter === f.key
                              ? "bg-[#221d24] text-white"
                              : "border border-black/10 bg-white text-black/50 hover:border-black/25"
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {loading && !data ? (
                    <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-white/40 px-4 py-6 text-center text-[12px] text-black/40">
                      正在读取 PK 记录…
                    </p>
                  ) : filteredEntries.length === 0 ? (
                    <p className="mt-3 rounded-xl border border-dashed border-black/10 bg-white/40 px-4 py-6 text-center text-[12px] text-black/40">
                      {recordFilter === "all"
                        ? "本月还没有可抽奖的多人 PK 记录（流局场次已自动隐藏）。"
                        : recordFilter === "drawn"
                          ? "本月还没有抽奖记录。"
                          : "本月还没有中奖记录。"}
                    </p>
                  ) : (
                    <div className="mt-3 overflow-hidden rounded-2xl border border-black/[0.07] bg-[#fbfaff]">
                      {orderedEntries.map((entry, idx) => {
                        const open = expanded.has(entry.pkId);
                        const status = entryStatus(entry);
                        const isExpired = entry.state === "expired";
                        const isFirstExpired = idx === firstExpiredIndex;
                        const expiredToggle = (
                          <button
                            key="expired-toggle"
                            onClick={() => setExpiredOpen((v) => !v)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-black/45 transition hover:bg-black/[0.02] ${
                              idx > 0 ? "border-t border-black/[0.06]" : ""
                            }`}
                          >
                            <Icon name="lock" className="h-3.5 w-3.5" />
                            <span>已过期记录（{expiredCount}）</span>
                            <span className="ml-auto">{expiredOpen ? "收起" : "展开"}</span>
                            <Icon
                              name="chevron"
                              className={`h-3.5 w-3.5 shrink-0 transition-transform ${expiredOpen ? "rotate-90" : ""}`}
                            />
                          </button>
                        );
                        if (isExpired && !expiredOpen) {
                          return isFirstExpired ? expiredToggle : null;
                        }
                        return (
                          <Fragment key={entry.pkId}>
                            {isExpired && isFirstExpired && expiredToggle}
                          <div className={idx > 0 ? "border-t border-black/[0.06]" : ""}>
                            <button
                              onClick={() => toggleEntry(entry.pkId)}
                              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition ${
                                entry.state === "expired" ? "bg-black/[0.02] opacity-60 grayscale" : "hover:bg-black/[0.02]"
                              }`}
                            >
                              <span className="shrink-0 text-[13px] tabular-nums text-black/55">
                                {formatDateTime(entry.startAt)}
                              </span>
                              <span className="shrink-0 text-[13px] text-black/60">票数 {formatVotes(entry.votes)}</span>
                              <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-black/50">
                                {entry.rank}/{entry.participants}名
                              </span>
                              <span className={`ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${status.cls}`}>
                                {status.text}
                              </span>
                              <Icon
                                name="chevron"
                                className={`h-4 w-4 shrink-0 text-black/30 transition-transform ${open ? "rotate-90" : ""}`}
                              />
                            </button>
                            {open && (
                              <div className="px-3 pb-3">
                                <div className="flex flex-wrap gap-1.5">
                                  {entry.anchors.map((a) => (
                                    <span
                                      key={`${a.uid}-${a.rank}`}
                                      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] ${
                                        a.drawn
                                          ? "bg-rose-500 text-white"
                                          : a.isSelf
                                            ? "border border-pink-400 bg-pink-200 text-pink-950"
                                            : "bg-pink-100 text-pink-800"
                                      }`}
                                    >
                                      <span className={`text-[12px] ${a.drawn ? "opacity-70" : "text-pink-500"}`}>
                                        {circledNumber(a.rank)}
                                      </span>
                                      <span className="max-w-[140px] truncate">
                                        {a.name || (a.uid ? `UID ${a.uid}` : "未知主播")}
                                      </span>
                                      <span className="opacity-60">{formatVotes(a.votes)}</span>
                                    </span>
                                  ))}
                                </div>

                                {entry.state === "drawable" && (
                                  <>
                                    <div className="mt-2.5 flex items-center justify-between rounded-xl bg-[#fff7fa] px-3 py-1.5 text-[11px]">
                                      <span className="text-black/45">本局礼物价值期望</span>
                                      <span className="font-semibold text-[#8b4a68]">
                                        约 {expectedBattery(entry.secondVotes, config?.votesPerBattery ?? 50)} 电池
                                      </span>
                                    </div>
                                    <button
                                      onClick={() => {
                                        setConfirmCountdown(10);
                                        setConfirmEntry(entry);
                                      }}
                                      className="mt-2 flex w-full items-center justify-between rounded-2xl bg-gradient-to-r from-[#ffdbe7] to-[#dbeaff] px-3 py-2 text-[12px] font-semibold text-[#7c5170]"
                                    >
                                      去抽奖（一定要确认这局你没有吃到医药费）
                                      <Icon name="chevron" className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}

                                {entry.state === "drawn" && entry.draw && (
                                  <div className="mt-2.5 flex items-center gap-2 rounded-2xl border border-[#f2d8e2] bg-[#fff8fb] px-3 py-2">
                                    {entry.draw.prizeKind !== "none" &&
                                    entry.draw.status !== "miss" &&
                                    entry.draw.status !== "void" ? (
                                      <>
                                        {entry.draw.prizeImg ? (
                                          <img
                                            src={fixImage(entry.draw.prizeImg)}
                                            alt=""
                                            className="h-6 w-6 rounded object-contain"
                                          />
                                        ) : (
                                          <Icon name="gift" className="h-4 w-4 text-[#c05880]" />
                                        )}
                                        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[#8b4a68]">
                                          {entry.draw.prizeName}
                                        </span>
                                        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${drawStatusLabel(entry.draw.status).cls}`}>
                                          {drawStatusLabel(entry.draw.status).label}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="text-[11px] text-black/45">
                                        {entry.draw.status === "void" ? "本局抽奖已作废" : "本局未中奖，下次好运"}
                                      </span>
                                    )}
                                    <span className="shrink-0 text-[10px] text-black/30">
                                      {formatIso(entry.draw.drawnAt)}
                                    </span>
                                  </div>
                                )}

                                {(entry.state === "locked" ||
                                  entry.state === "expired" ||
                                  entry.state === "paused") && (
                                  <div className="mt-2.5 flex items-center gap-1.5 rounded-2xl bg-black/[0.03] px-3 py-2 text-[11px] text-black/40">
                                    <Icon name="lock" className="h-3.5 w-3.5" />
                                    {entry.reason || "不可抽奖"}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-500">{error}</p>}
        </section>

        {/* ===== 全部抽奖记录（与 PK 记录解耦，独立模块） ===== */}
        <section className="mt-5 overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_20px_56px_-32px_rgba(120,80,120,0.4)]">
          <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-5 py-4 sm:px-7">
            <h2 className="text-sm font-semibold">全部主播抽奖记录</h2>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <select
                value={allMonth}
                onChange={(e) => setAllMonth(e.target.value)}
                className="rounded-full border border-black/10 bg-white px-3 py-1 text-[11px] text-black/60 outline-none"
              >
                <option value="">全部月份</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <span className="text-[10px] text-black/35">
                共 {filteredDraws.length} 条{allLoading ? " · 刷新中…" : ""}
              </span>
            </div>
          </div>

          {filteredDraws.length === 0 ? (
            <div className="px-5 py-10 text-center text-[12px] text-black/40 sm:px-7">
              暂无抽奖记录。
            </div>
          ) : (
            <div>
              {filteredDraws.map((d, i) => (
                <div
                  key={d.id}
                  className={`flex items-center gap-3 px-4 py-3 sm:px-5 ${i > 0 ? "border-t border-black/[0.05]" : ""}`}
                >
                  {d.face ? (
                    <img src={fixImage(d.face)} alt={d.uname} className="h-8 w-8 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/5 text-black/30">
                      <Icon name="user" className="h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{d.uname || `UID ${d.uid}`}</div>
                    <div className="mt-0.5 text-[11px] text-black/35">
                      {formatIso(d.drawnAt)} · PK {d.pkId}
                    </div>
                  </div>
                  {d.prizeKind === "none" || d.status === "miss" ? (
                    <span className="shrink-0 text-[12px] text-black/35">未中奖</span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      {d.prizeImg ? (
                        <img src={fixImage(d.prizeImg)} alt="" className="h-6 w-6 rounded object-contain" />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-[#fff0f5] text-[#c05880]">
                          <Icon name="gift" className="h-3.5 w-3.5" />
                        </span>
                      )}
                      <span className="max-w-[120px] truncate text-[12px] font-medium text-[#8b4a68]">{d.prizeName}</span>
                      <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${drawStatusLabel(d.status).cls}`}>
                        {drawStatusLabel(d.status).label}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ===== 规则 ===== */}
        <Rules config={config} />

        {/* ===== 页脚 ===== */}
        <footer className="mt-10 flex justify-center">
          <a
            href="https://bili-bili.icu"
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2.5 rounded-full bg-[#221d24] px-6 py-3 text-[12px] font-medium text-white shadow-[0_14px_30px_-14px_rgba(34,29,36,0.75)] transition hover:-translate-y-0.5 hover:bg-[#2f2831] hover:shadow-[0_18px_36px_-14px_rgba(34,29,36,0.8)] active:translate-y-0 active:scale-95"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[#ffd0a8]">
              <Icon name="spark" className="h-3.5 w-3.5" />
            </span>
            返回网站首页
            <span className="text-[11px] text-white/60">bili-bili.icu</span>
            <span className="text-[13px] text-white/70 transition-transform group-hover:translate-x-0.5">→</span>
          </a>
        </footer>
      </div>

      {/* ===== 抽奖资格确认弹窗（每次抽奖都需要确认） ===== */}
      {confirmEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
          onClick={() => setConfirmEntry(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#8b4a68]">
              <Icon name="lock" className="h-4 w-4" />
              抽奖前请确认
            </div>
            <p className="mt-3 rounded-2xl bg-amber-50 px-3 py-3 text-[12px] leading-6 text-amber-800">
              请确保你自己在这一局有抽奖资格：本局有医药费，你没有吃到，并且其他主播没有给你补偿。
              <br />
              提醒：每一局只有一人可以抽奖，如果你参与了不该属于你的抽奖，本该抽奖的主播会看到你的抽奖记录🥲
            </p>
            <div className="mt-3 flex items-center justify-between rounded-2xl bg-[#faf7fa] px-3 py-2 text-[12px]">
              <span className="text-black/50">本局礼物价值期望</span>
              <span className="font-semibold text-[#8b4a68]">
                约 {expectedBattery(confirmEntry.secondVotes, config?.votesPerBattery ?? 50)} 电池
              </span>
            </div>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirmEntry(null)}
                className="flex-1 rounded-2xl border border-black/10 py-2.5 text-[12px] text-black/55 transition hover:border-black/25"
              >
                取消
              </button>
              <button
                disabled={confirmCountdown > 0}
                onClick={() => {
                  const target = confirmEntry;
                  setConfirmEntry(null);
                  void startRoll(target);
                }}
                className={`flex-1 rounded-2xl py-2.5 text-[12px] font-medium transition ${
                  confirmCountdown > 0
                    ? "cursor-not-allowed bg-black/[0.06] text-black/35"
                    : "bg-[#221d24] text-white hover:opacity-90"
                }`}
              >
                {confirmCountdown > 0 ? `请阅读说明（${confirmCountdown}s）` : "我确认，去抽奖"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 抽奖弹窗 ===== */}
      {rollOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" onClick={closeRoll}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {rolling ? (
              <>
                <div className="mx-auto flex h-28 w-28 items-center justify-center">
                  {primaryPrize[rollIndex]?.img ? (
                    <img
                      key={`img-${rollIndex}`}
                      src={fixImage(primaryPrize[rollIndex].img)}
                      alt=""
                      className="h-28 w-28 object-contain"
                    />
                  ) : (
                    <Icon key={`icon-${rollIndex}`} name="gift" className="h-12 w-12 text-[#8b4a68]" />
                  )}
                </div>
                <h2
                  key={`name-${rollIndex}`}
                  className="mt-4 flex h-7 items-center justify-center truncate px-2 text-[20px] font-semibold text-[#8b4a68]"
                >
                  {primaryPrize[rollIndex]?.name ?? "…"}
                </h2>
                <p className="mt-2 flex min-h-[40px] items-center justify-center text-[12px] leading-5 text-black/50">
                  正在为你抽取本月奖品…
                </p>
                <div className="mt-4 rounded-2xl bg-[#fafafa] px-3 py-2 text-[11px] text-black/40">
                  月末会统一发放，耐心等待即可
                </div>
                <button
                  disabled
                  className="mt-5 w-full rounded-2xl bg-[#221d24] py-2.5 text-[12px] font-medium text-white opacity-60"
                >
                  抽奖中…
                </button>
              </>
            ) : rollError ? (
              <>
                <div className="mx-auto flex h-28 w-28 items-center justify-center">
                  <Icon name="lock" className="h-12 w-12 text-red-400" />
                </div>
                <h2 className="mt-4 flex h-7 items-center justify-center text-[20px] font-semibold text-black/60">
                  抽奖未成功
                </h2>
                <p className="mt-2 flex min-h-[40px] items-center justify-center text-[12px] leading-5 text-black/50">
                  {rollError}
                </p>
                <div className="mt-4 rounded-2xl bg-[#fafafa] px-3 py-2 text-[11px] text-black/40">
                  可以稍后再试，或检查网络后重试
                </div>
                <button
                  onClick={closeRoll}
                  className="mt-5 w-full rounded-2xl bg-[#221d24] py-2.5 text-[12px] font-medium text-white"
                >
                  知道了
                </button>
              </>
            ) : rollResult ? (
              <>
                <div className="mx-auto flex h-28 w-28 items-center justify-center">
                  {rollResult.prizeKind !== "none" && rollResult.prizeImg ? (
                    <img
                      src={fixImage(rollResult.prizeImg)}
                      alt=""
                      className="h-28 w-28 object-contain"
                    />
                  ) : rollResult.prizeKind === "none" ? (
                    <Icon name="clock" className="h-12 w-12 text-black/30" />
                  ) : (
                    <Icon name="gift" className="h-12 w-12 text-[#8b4a68]" />
                  )}
                </div>
                <h2
                  className={`mt-4 flex h-7 items-center justify-center truncate px-2 text-[20px] font-semibold ${
                    rollResult.prizeKind === "none" ? "text-black/45" : "text-[#8b4a68]"
                  }`}
                >
                  {rollResult.prizeKind === "none" ? "本次未中奖" : rollResult.prizeName}
                </h2>
                <p className="mt-2 flex min-h-[40px] items-center justify-center text-[12px] leading-5 text-black/50">
                  {rollResult.prizeKind === "none" ? "别灰心，下局再战。" : rollResult.prizeText}
                </p>
                <div className="mt-4 rounded-2xl bg-[#fafafa] px-3 py-2 text-[11px] text-black/40">
                  {rollResult.prizeKind === "none"
                    ? "下局继续加油，好运很快就来"
                    : rollResult.id === "demo"
                      ? "试玩结果，不会发放奖品"
                      : "月末会统一发放，耐心等待即可"}
                </div>
                <button
                  onClick={closeRoll}
                  className="mt-5 w-full rounded-2xl bg-[#221d24] py-2.5 text-[12px] font-medium text-white transition hover:opacity-90"
                >
                  {rollResult.prizeKind === "none" ? "继续加油" : "收下这份小惊喜"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* ===== Toast ===== */}
      {toast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center px-4">
          <div className="rounded-full bg-[#221d24]/92 px-4 py-2 text-[12px] text-white shadow-lg">{toast}</div>
        </div>
      )}
    </main>
  );
}

function Rules({ config }: { config: PublicConfig | null }) {
  const [open, setOpen] = useState(false);
  const cap = config?.monthlyWinCap ?? 3;
  const hours = config?.drawWindowHours ?? 24;
  const voidScore = config?.voidScoreThreshold ?? 1000;

  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-black/[0.07] bg-white shadow-[0_20px_56px_-32px_rgba(120,80,120,0.35)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-5 py-4 text-left sm:px-7"
      >
        <span className="text-sm font-semibold">活动规则</span>
        <Icon name="chevron" className={`h-4 w-4 text-black/40 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-black/[0.06] px-5 py-5 text-[12px] leading-6 text-black/55 sm:px-7">
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>只展示本月的「多人接力 PK」记录，不包含分组PK/竞技/流局。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>记录的是PK条结束时的分数，所以并不准确，比如时长超过1个小时，中途掉线结束PK。如果7人局在1小时以后才打满，不会被识别为抢医药费，不显示在记录中。之后如果使用者增多，会用更严谨的方法来判断本局中错失医药费的主播。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>只有真正没抢到医药费的主播才可以抽奖，第一第二名好心额外给了医药费的也不要抽。虽然没有做限制，请自觉遵守，不要乱抽，因为本该抽奖的主播会看到你占用了她的抽奖资格，会非常尴尬，严重的还会被挂在网站上。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>同一局无论有几位错失医药费，只有一个人可以抽奖，先到先得。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>每一局的抽奖有效期为 PK 开始后 {hours} 小时，过期不可抽。因为如果当时不抽，通常就会被遗忘。另外，这个抽奖旨在安抚错失医药费那一会儿的心情失落。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>每位主播每个自然月最多抽中 {cap} 次非安慰奖；安慰奖（粉丝牌）不占用次数。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>每次抽奖的概率和本局医药费有关，大体上是平均值等于医药费的1/10，当然由于随机，会抽中更大或者更小的礼物。抽奖肯定是要远低于医药费的，否则对抢医药费的不公平，另外就是资助能力有限。总之得承认这是一个聊胜于无的抽奖，但好在不用你复杂的操作。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>奖品每月底发放，耐心等待即可。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>免责声明：这是一个公益小项目，主要是见过好多次主播由于没抢到医药费破防痛哭下播的。如果有人恶意抽奖，是不会兑现的。甚至如果一个月有好几位主播抽中了大奖，导致资助无法覆盖，可能也会和中奖者协商，当然会尽量避免这种情况。总之一句常见的流氓话，所有解释权归网站所有。</p>
          <p><span className="mr-1.5 text-[15px] font-bold text-[#c05880]">•</span>急切寻找资助者，开发者本人是没有钱资助维持这个活动的。每月一次资助，资助的大哥/大姐会展示在首页，也可以展示自己的爱播，所有月份的资助者都会长期记录。每月资助金暂时还不确定，但预计会在1000块左右，可以是多位资助者分担。如有兴趣，微信联系 MRI_QA，感恩！</p>
        </div>
      )}
    </section>
  );
}
