"use client";

import { useState, useEffect, useRef, memo, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { toPng } from "html-to-image";
import { isMobileDevice } from "@/lib/device";
import { serverApiUrl } from "@/lib/server-api";
import { dataFetch } from "@/lib/client-fetch";
import { BLIND_BOX_CONFIG } from "@/lib/config";
import { getBlindBoxCardBg } from "@/lib/layout";
import { ensureGiftCatalogLoaded } from "@/lib/gift-catalog-client";
import { getPlatform, isWindowsDisplaySupported } from "@/lib/platform";
import AvatarBubbleChart, { type BubbleItem } from "@/components/AvatarBubbleChart";
import GiftScreenshotPanel from "@/components/GiftScreenshotPanel";
import GiftReplayPanel from "@/components/GiftReplayPanel";
import PieTooltip from "@/components/PieTooltip";
import DisplayPanel from "@/components/display/DisplayPanel";
import { showToast } from "@/lib/toast";
import { saveMobileOrDownload } from "@/lib/save-image";
import Dropdown from "@/components/Dropdown";
import InfoHint from "@/components/InfoHint";

type AnchorGiftRecord = {
  uid: number;
  uname: string;
  time: string;
  goods_id: number;
  gift_id: number;
  name: string;
  num: number;
  hamster: number;
  receive_title: string;
  room_id: number;
};

type AnchorStats = {
  totalHamster: number;
  totalCount: number;
  giftTypes: number;
  fanCount: number;
  dateRange: { start: string; end: string } | null;
  monthlyData: Array<{ month: string; hamster: number; count: number }>;
  fanDistribution: Array<{ uid: number; uname: string; hamster: number }>;
  giftSummary: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }>;
  records: AnchorGiftRecord[];
  yesterdayAvailable?: boolean;
  blindBoxProfit?: {
    gift_id: number;
    name: string;
    drawCount: number;
    totalHamster: number;
    cost: number;
    profit: number;
    gifts: Array<{ gift_id: number; name: string; num: number; hamster: number }>;
    img: string;
  };
  blindBoxProfits?: Array<{
    gift_id: number;
    name: string;
    drawCount: number;
    totalHamster: number;
    cost: number;
    profit: number;
    gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }>;
    img: string;
    blindPrice: number;
    anchors: Array<{ ruid: number; rname: string; count: number }>;
    dateRange: { start: string; end: string } | null;
  }>;
  otherStats?: {
    dayStats: { totalDays: number; maxConsecutiveDays: number };
    fanStats: Array<{
      uid: number;
      uname: string;
      totalDays: number;
      maxConsecutiveDays: number;
      consecutiveStart: string;
      consecutiveEnd: string;
    }>;
  };
};

function fixImageUrl(url: string): string {
  if (!url) return "";
  return url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
}

function formatCoinsShort(coins: number): string {
  if (coins === 0) return "0";
  if (coins >= 10000) return `${(coins / 10000).toFixed(1)}万`;
  // 小于1万显示完整数位，去掉小数位（如 321.5 -> 321）
  return String(Math.floor(coins));
}

function formatBattery(hamster: number): string {
  // 换算关系：1电池 = 100 Hamster；超过1万以"万"为单位显示1位小数
  const battery = Math.round(hamster / 100);
  if (battery >= 10000) return `${(battery / 10000).toFixed(1)}万`;
  return String(battery);
}

function monthLabel(ym: string) {
  if (!ym || ym.length < 6) return ym;
  return ym.slice(0, 4) + "." + ym.slice(4, 6);
}

function GiftSaveModal({
  gifts,
  onClose,
  totalTypes,
  totalCount,
  totalHamster,
  dateRangeStr,
  fanName,
}: {
  gifts: Array<{ gift_id: number; name: string; num: number; hamster: number; img: string }>;
  onClose: () => void;
  totalTypes: number;
  totalCount: number;
  totalHamster: number;
  dateRangeStr: string;
  fanName: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    generateImage();
  }, []);

  async function generateImage() {
    setLoading(true);
    if (!cardRef.current) {
      setLoading(false);
      return;
    }
    try {
      const dataUrl = await toPng(cardRef.current, { backgroundColor: "#fff", pixelRatio: 2, cacheBust: true });
      setGeneratedImage(dataUrl);
    } catch (err) {
      console.error("生成图片失败:", err);
    } finally {
      setLoading(false);
    }
  }

  async function downloadImage() {
    if (!generatedImage) return;
    const res = await saveMobileOrDownload(generatedImage, `gift_list_${Date.now()}.png`);
    if (res === "fallback") {
      showToast("未保存到相册，请长按上方图片保存");
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      {/* 隐藏的卡片用于生成图片 - 使用绝对定位移出视口而非display:none */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        <div ref={cardRef} className="inline-flex flex-col rounded-lg overflow-hidden shadow-2xl">
          {/* w-0 min-w-full: width=0 让标题不撑开卡片宽度；min-w-full 让它拉伸到由礼物网格决定的卡片宽度 */}
          <div className="w-0 min-w-full bg-gradient-to-br from-[#1f1c17] via-[#2d2a24] to-[#3d3a34] px-6 pt-8 pb-6 text-white">
            <div className="text-sm leading-relaxed text-white/80 break-words">
              {dateRangeStr && <>{dateRangeStr} </>}
              收到{fanName ? <> <span className="font-bold text-white">{fanName}</span> 的</> : ""}{" "}
              <span className="font-bold text-white">{totalTypes}</span> 种共{" "}
              <span className="font-bold text-white">{totalCount}</span> 个礼物，收益{" "}
              <span className="font-bold text-white">{formatBattery(totalHamster)}</span> 电池
            </div>
          </div>
          <div className="bg-white px-6 py-5">
            <div className="grid grid-cols-3 gap-x-4 gap-y-2">
              {gifts.slice(0, 59).map((g) => (
                <div key={g.gift_id} className="flex items-center gap-1.5 text-sm py-1">
                  {g.img && <img src={fixImageUrl(g.img)} alt="" className="w-5 h-5 rounded flex-shrink-0" crossOrigin="anonymous" />}
                  <span className="truncate text-black/70 text-xs">{g.name} ×{g.num}</span>
                </div>
              ))}
              {gifts.length > 59 && (
                <div className="flex items-center gap-1.5 text-sm py-1">
                  <span className="truncate text-black/40 text-xs">...</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="relative mx-auto w-full max-w-sm flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {/* 加载状态 */}
        {loading && (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            <p className="text-white text-sm">生成图片中...</p>
          </div>
        )}

        {/* 图片内容 */}
        {!loading && generatedImage && (
          <>
            <img src={generatedImage} alt="礼物清单" className="max-w-full max-h-[70vh] rounded-lg shadow-2xl mx-auto" />

            {/* 下方按钮区域 */}
            <div className="flex gap-2.5 mt-3 w-full justify-center">
              <button onClick={downloadImage} className="modal-action-btn modal-action-primary">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                {isMobileDevice() ? "保存到相册" : "下载图片"}
              </button>
              <button onClick={onClose} className="modal-action-btn modal-action-light">
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

const AnchorDataModule = memo(function AnchorDataModule({
  anchorName = "",
  anchorFace = "",
  mid = 0,
  uname = "",
  isServerAccount = false,
  /** 页面统一刷新信号：true=全局正在同步（粉丝+主播一起刷），按钮显示三点动画 */
  syncing = false,
  /** 组件自身首次加载遮罩（true=显示"加载中..."全屏 spinner），与 syncing 解耦 */
  syncLoading = false,
  /** 页面级最后一次刷新时间（父组件维护，所有模块共享），按钮空闲时显示 */
  lastRefreshTime = "",
  /** 本机是否持有该账号的 B站 登录凭证；无凭证时按钮禁用 */
  isLocalAccount = true,
  onFetchRequest = null,
  /** 点击顶部绿色刷新按钮时触发（由父组件提供的统一刷新入口，含粉丝+主播+统计） */
  onRefresh,
  /** 轻量 toast 提示 */
  showToast,
  /** 收益拉取进度上报（透传给父级全屏遮罩：首次初始化时遮罩全程显示"获取主播收益"进度） */
  onFetchProgress = undefined,
  /** 无收益判定回调（响应 noRevenue=true 时触发，父级据此立即隐藏"主播"选项卡） */
  onNoRevenue,
}: {
  anchorName?: string;
  anchorFace?: string;
  mid?: number;
  uname?: string;
  /** 是否为服务器收集账号：本机无登录凭证，仅可查看；顶部显示提示横幅 */
  isServerAccount?: boolean;
  /** 页面统一刷新信号：true=全局正在同步（粉丝+主播一起刷），按钮显示三点动画 */
  syncing?: boolean;
  /** 组件自身首次加载遮罩（与 syncing 解耦，互不影响） */
  syncLoading?: boolean;
  /** 页面级最后一次刷新时间（父组件维护，所有模块共享） */
  lastRefreshTime?: string;
  /** 本机是否持有该账号的 B站 登录凭证；无凭证时按钮禁用 */
  isLocalAccount?: boolean;
  /** 父级 ref：页面统一刷新时调用本组件 fetchData，使收益数据随页面一起更新 */
  onFetchRequest?: MutableRefObject<(() => Promise<void>) | null> | null;
  /** 点击顶部绿色刷新按钮时触发（由父组件提供的统一刷新入口） */
  onRefresh?: () => void;
  /** toast 提示 */
  showToast?: (msg: string) => void;
  /** 收益拉取进度上报（透传给父级全屏遮罩） */
  onFetchProgress?: (p: { text: string; ratio?: number } | null) => void;
  /** 无收益判定回调（响应 noRevenue=true 时触发，父级据此立即隐藏"主播"选项卡） */
  onNoRevenue?: () => void;
}) {
  const [stats, setStats] = useState<AnchorStats | null>(null);
  const [loading, setLoading] = useState(true);
  // 收益记录按月获取进度（首次拉取时展示进度条）
  const [fetchProgress, setFetchProgress] = useState<{ text: string; ratio?: number } | null>(null);
  const [activeTab, setActiveTab] = useState<"revenue" | "blindbox" | "display" | "gift_screenshot" | "other">("revenue");
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedFan, setSelectedFan] = useState<string>("");
  const [showGiftSaveModal, setShowGiftSaveModal] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [blindBoxDateFilter, setBlindBoxDateFilter] = useState<string>("all");
  const [blindBoxFanFilter, setBlindBoxFanFilter] = useState<string>("");
  // 保存完整粉丝列表（不受筛选影响），用于下拉框始终显示全部粉丝
  const [fullBlindBoxAnchors, setFullBlindBoxAnchors] = useState<Record<number, Array<{ ruid: number; rname: string; count: number }>>>({});
  // 盲盒盈亏独立数据（与收入统计解耦，互不影响）
  const [blindBoxProfits, setBlindBoxProfits] = useState<AnchorStats["blindBoxProfits"]>(undefined);
  const [yesterdayAvailable, setYesterdayAvailable] = useState(true); // 默认 true，避免初始闪烁
  const [fanBubbleData, setFanBubbleData] = useState<{ items: BubbleItem[]; title: string; loading?: boolean; loadingText?: string } | null>(null);
  const [fanFaces, setFanFaces] = useState<Record<number, string>>({});
  // 饼图选中状态（移动端）：记录选中的扇形(chart+index)与点击位置，只有选中时才显示提示框（与粉丝/消费页一致）
  const [pieActive, setPieActive] = useState<{ chart: "all" | "period"; index: number } | null>(null);
  const [pieTipPos, setPieTipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // 挂载标记：避免在渲染分支中直接使用 isMobileDevice() 造成 SSR/客户端不一致（Hydration 报错）
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const pieIsMobile = mounted && isMobileDevice();

  // 展示（投屏）仅 Windows 桌面 Tauri 可用；非 Windows（Web/Android/iOS 等）不显示"展示"tab 与面板
  const [displaySupported, setDisplaySupported] = useState(false);
  useEffect(() => {
    let alive = true;
    getPlatform()
      .then((p) => {
        if (alive) setDisplaySupported(isWindowsDisplaySupported(p));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 防重入锁：避免 StrictMode 双调用 / 父组件刷新导致 fetchData 并发重复拉取
  const fetchingRef = useRef(false);
  // 缓存快显只执行一次（挂载/账号 key 变更），避免重复读取本地
  const cacheShownRef = useRef(false);

  // 每次渲染把最新 fetchData 注册到父级 ref，供页面统一刷新时调用（收益随页面一起更新）
  // 加载时机完全由父组件掌控：初始化 loadAllData → finishRefresh、绿色刷新按钮 → refreshData → finishRefresh、
  // 以及切换到 anchor 标签时兜底触发。组件自身不做自加载，避免与父组件触发重复请求。
  useEffect(() => {
    if (onFetchRequest) {
      onFetchRequest.current = fetchData;
    }
  });

  // 挂载即用本地缓存快速填充主播页统计（fast 路径只读本地、不拉 B站、无遮罩）。
  // 关键：若等父级完整启动序列（首次 fetchData accounts+pay-record 约1-2s）结束才由 finishRefresh
  // 触发缓存填充，首次显示会出现 ~2s 空白。此处提前到组件一挂载就填充，空白即可消除。
  useEffect(() => {
    if (!cacheShownRef.current) {
      cacheShownRef.current = true;
      loadCachedStats();
    }
    // 仅在挂载/账号 key 变更时执行一次，避免重复填充
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 仅从本地缓存立即展示主播统计（不拉 B站、不涉网络等待）；常规拉取完成后会静默覆盖为最新。 */
  async function loadCachedStats() {
    try {
      const cachedRes = await dataFetch("/api/anchor/gifts?fast=1", { cache: "no-store" });
      const cachedData = await cachedRes.json();
      if (cachedData.code === 0 && cachedData.data) {
        setStats(cachedData.data);
        setYesterdayAvailable(cachedData.data.yesterdayAvailable ?? true);
        setBlindBoxProfits(cachedData.data.blindBoxProfits);
        if (cachedData.data.blindBoxProfits) {
          const anchors: Record<number, Array<{ ruid: number; rname: string; count: number }>> = {};
          for (const bb of cachedData.data.blindBoxProfits) {
            anchors[bb.gift_id] = bb.anchors;
          }
          setFullBlindBoxAnchors(anchors);
        }
      }
    } catch {
      // 快速读取本地缓存失败则忽略，走常规拉取
    }
  }

  async function fetchData() {
    if (fetchingRef.current) {
      console.log("[AnchorGifts] 已有拉取进行中，跳过重复请求");
      return;
    }
    fetchingRef.current = true;
    setLoading(true);
    setAuthError(null);
    setFetchProgress(null);
    // 统一起始提示：模块内部遮罩与父级全屏遮罩都立即显示"正在获取主播收益..."
    // （dataFetch 只在实际拉取月份时有进度回调，前置一个起始提示避免只显示"加载中"）
    const startHint = { text: "正在获取主播收益...", ratio: undefined } as const;
    setFetchProgress(startHint);
    onFetchProgress?.(startHint);
    // 重置盲盒筛选条件
    setBlindBoxDateFilter("all");
    setBlindBoxFanFilter("");
    try {
      // 先确保本地礼物目录已加载（给 GiftScreenshotPanel、giftSummary 图标读取用）
      try {
        const platform = await getPlatform();
        await ensureGiftCatalogLoaded(platform);
      } catch {
        // Web 模式下 getPlatform 可能抛错，忽略，走 stats.giftSummary 已带图标即可
      }
      // 首次/尚未有缓存统计时，先快速读取本地缓存立即展示（不拉 B站、无遮罩），
      // 主播页避免空白；随后常规拉取完成后再静默覆盖为最新数据。
      if (!stats) {
        await loadCachedStats();
      }
      // 登录触发的全量探测标记：扫码登录跳转主页时由 /login 页写入，仅消费一次。
      // 置位时向收益接口传 probe=true，仅在该账号 roomStatus=1 时做一次有容错的全量探测；
      // 冷启动/绿色刷新（无此标记）不做全量探测，避免对无收益账号反复试探。
      const probe = typeof window !== "undefined" && localStorage.getItem("bili_live_anchor_probe") === "1";
      if (probe) localStorage.removeItem("bili_live_anchor_probe");
      const res = await dataFetch(probe ? "/api/anchor/gifts?probe=true" : "/api/anchor/gifts", { cache: "no-store" }, (p) => {
        // 模块内进度条 + 透传给父级全屏遮罩（首次初始化时遮罩同步显示"获取主播收益"进度）
        setFetchProgress({ text: p.text, ratio: p.ratio });
        onFetchProgress?.({ text: p.text, ratio: p.ratio });
      });
      const data = await res.json();
      if (data.message === "needs-relogin") {
        setAuthError("B站登录已失效，请重新扫码登录。");
        window.location.href = "/login";
        return;
      }
      if (data.code === 0 && data.data) {
        setStats(data.data);
        setYesterdayAvailable(data.data.yesterdayAvailable ?? true);
        // 无收益判定（仅扫码登录探测会置位）：立即通知父级隐藏"主播"选项卡，
        // 不必等下次账号刷新/重载
        if (data.data.noRevenue) onNoRevenue?.();
        // 盲盒盈亏数据独立存储，与收入统计解耦
        setBlindBoxProfits(data.data.blindBoxProfits);
        // 首次加载时保存完整粉丝列表，供筛选下拉框使用
        if (data.data.blindBoxProfits) {
          const anchors: Record<number, Array<{ ruid: number; rname: string; count: number }>> = {};
          for (const bb of data.data.blindBoxProfits) {
            anchors[bb.gift_id] = bb.anchors;
          }
          setFullBlindBoxAnchors(anchors);
        }
      } else if (data.message === "already fetching") {
        // 另一个并发请求正在进行，静默跳过（锁等待模式下基本不会走到此分支）
        console.log("[AnchorGifts] another fetch in progress, skipping this call");
      } else {
        setAuthError(data.message || "获取数据失败");
      }
    } catch (error) {
      console.error("Failed to fetch anchor data:", error);
      setAuthError("网络请求失败，请检查网络连接后重试。");
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }

  async function openFanBubbleChart() {
    if (!stats) return;
    const fans = stats.fanDistribution;
    if (fans.length === 0) return;

    // 按送礼金额排序，只取 top 300 用于显示和头像获取
    const sortedFans = [...fans].sort((a, b) => b.hamster - a.hamster);
    const topFans = sortedFans.slice(0, 300);

    // 立即打开模态框，显示加载状态
    const initialItems: BubbleItem[] = topFans.map(f => ({
      id: f.uid,
      name: f.uname,
      value: Math.round(f.hamster / 100),
      face: fanFaces[f.uid] || "",
    }));
    setFanBubbleData({ items: initialItems, title: "送礼粉丝分布", loading: true, loadingText: "正在获取粉丝头像...<br /> 首次加载较慢，请耐心等待" });

    // 找出还没有头像的uid（只针对top300）
    const missingUids = topFans.filter(f => !fanFaces[f.uid]).map(f => f.uid);
    let faces = { ...fanFaces };

    if (missingUids.length > 0) {
      try {
        const batchSize = 50;
        let successCount = 0;
        let failCount = 0;
        // 按批次并行请求（服务器端每个批次内部也有界并发），避免串行等待
        const batches: number[][] = [];
        for (let i = 0; i < missingUids.length; i += batchSize) {
          batches.push(missingUids.slice(i, i + batchSize));
        }
        await Promise.all(batches.map(async (batch) => {
          try {
            const res = await dataFetch(`/api/tools/user-info?uids=${batch.join(",")}&mid=${mid}&uname=${encodeURIComponent(uname)}`, { cache: "no-store" });
            const data = await res.json();
            if (data.code === 0 && data.data) {
              for (const [uidStr, info] of Object.entries(data.data)) {
                const face = (info as any).face || "";
                faces[Number(uidStr)] = face;
                if (face) successCount++; else failCount++;
              }
            } else {
              failCount += batch.length;
            }
          } catch {
            failCount += batch.length;
          }
        }));
        console.log("[FanBubble] 头像获取完成: 成功=" + successCount, "失败=" + failCount, "总计=" + missingUids.length);
        setFanFaces(faces);
      } catch (err) {
        console.error("获取粉丝头像失败:", err);
      }
    }

    const items: BubbleItem[] = topFans.map(f => ({
      id: f.uid,
      name: f.uname,
      value: Math.round(f.hamster / 100),
      face: faces[f.uid] || "",
    }));

    setFanBubbleData({ items, title: "送礼粉丝分布", loading: false });
  }

  const filteredRecords = stats ? (selectedFan
    ? stats.records.filter((r) => r.uid === Number(selectedFan))
    : stats.records) : [];

  const monthlyData = stats ? (() => {
    const map = new Map<string, { hamster: number; count: number }>();
    for (const r of filteredRecords) {
      const d = new Date(r.time);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const existing = map.get(key) || { hamster: 0, count: 0 };
      existing.hamster += r.hamster;
      existing.count += 1;
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(([month, v]) => ({ month, hamster: v.hamster, count: v.count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  })() : [];

  const monthRecords = selectedMonth && stats
    ? filteredRecords.filter((r) => {
        const d = new Date(r.time);
        const m = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        return m === selectedMonth;
      })
    : [];

  const dayRecords = selectedDay !== null
    ? monthRecords.filter((r) => {
        const d = new Date(r.time);
        return d.getDate() === selectedDay;
      })
    : [];

  const dailyData: Map<number, number> = (() => {
    const map = new Map<number, number>();
    for (const r of monthRecords) {
      const d = new Date(r.time);
      const day = d.getDate();
      map.set(day, (map.get(day) ?? 0) + r.hamster);
    }
    return map;
  })();

  const maxDayHamster = dailyData.size > 0 ? Math.max(...dailyData.values()) : 1;

  const calendarData = selectedMonth ? (() => {
    const year = parseInt(selectedMonth.slice(0, 4));
    const month = parseInt(selectedMonth.slice(4, 6)) - 1;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = firstDay.getDay();
    const daysInMonth = lastDay.getDate();
    const startOffset = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;
    const weeks: Array<Array<{ day: number | null; hamster: number }>> = [];
    let currentWeek: Array<{ day: number | null; hamster: number }> = [];
    for (let i = 0; i < startOffset; i++) {
      currentWeek.push({ day: null, hamster: 0 });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      currentWeek.push({ day: d, hamster: dailyData.get(d) ?? 0 });
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ day: null, hamster: 0 });
      }
      weeks.push(currentWeek);
    }
    return { year, month: month + 1, weeks };
  })() : null;

  const periodFans: Array<{ uid: number; uname: string; hamster: number }> = stats ? (() => {
    let records = stats.records;
    if (selectedMonth) {
      records = records.filter((r) => {
        const d = new Date(r.time);
        const m = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        return m === selectedMonth;
      });
    }
    if (selectedDay !== null) {
      records = records.filter((r) => {
        const d = new Date(r.time);
        return d.getDate() === selectedDay;
      });
    }
    const map = new Map<number, { uname: string; hamster: number }>();
    for (const r of records) {
      const existing = map.get(r.uid) ?? { uname: r.uname, hamster: 0 };
      existing.hamster += r.hamster;
      map.set(r.uid, existing);
    }
    return Array.from(map.entries())
      .map(([uid, v]) => ({ uid, uname: v.uname, hamster: v.hamster }))
      .sort((a, b) => b.hamster - a.hamster);
  })() : [];

  const giftSummaryFiltered = (() => {
    if (!stats) return [];
    const rawRecords = selectedDay !== null ? dayRecords : (selectedMonth ? monthRecords : filteredRecords);
    const map = new Map<number, { gift_id: number; name: string; num: number; hamster: number; img: string }>();
    // stats.giftSummary 中的 img 已从本地 gift-list.json 获取（getGiftImg()），直接作为主数据源
    const imgMap = new Map(stats.giftSummary.map(g => [g.gift_id, g.img]));
    for (const r of rawRecords) {
      const img = imgMap.get(r.gift_id) || "";
      const existing = map.get(r.gift_id) ?? { gift_id: r.gift_id, name: r.name, num: 0, hamster: 0, img };
      existing.num += r.num;
      existing.hamster += r.hamster;
      map.set(r.gift_id, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.hamster - a.hamster);
  })();

  const allFans = stats?.fanDistribution ?? [];

  // 礼物清单对应的日期范围字符串（基于实际记录）
  const giftListDateStr = (() => {
    if (!stats) return "";
    const rawRecords = selectedDay !== null ? dayRecords : (selectedMonth ? monthRecords : filteredRecords);
    if (rawRecords.length === 0) return "";
    const dates = rawRecords.map(r => r.time.slice(0, 10));
    const min = dates.reduce((a, b) => a < b ? a : b);
    const max = dates.reduce((a, b) => a > b ? a : b);
    const fmt = (d: string) => d.replace(/-/g, ".");
    return min === max ? fmt(min) : `${fmt(min)}-${fmt(max)}`;
  })();

  // 礼物清单对应的粉丝名
  const giftListFanName = selectedFan
    ? (allFans.find((f) => f.uid === Number(selectedFan))?.uname ?? "")
    : "";

  const pieColors = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#c026d3", "#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#e11d48", "#0284c7", "#b91c1c", "#047857", "#b45309", "#6d28d9"];

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Auth error banner */}
      {authError && (
        <div className="content-wrapper px-2 py-2 bg-amber-50 rounded-lg">
          <p className="text-sm text-amber-800">{authError}</p>
        </div>
      )}

      {/* Loading state：仅父组件 syncLoading（首次/重建全屏遮罩）驱动加载遮罩；
          正常重开时的后台同步（syncLoading=false）不展示遮罩，属于静默加载 */}
      {/* fetchData() 开头已设置统一起始提示（"正在获取主播收益..."），后续由月份进度回调更新，
          因此这里不再重复写死的"加载中..."文字，全部统一走 fetchProgress 提示 */}
      {syncLoading && !stats && (
        <div className="flex-1 flex items-center justify-center px-8 min-h-[55vh]">
          <div className="flex flex-col items-center gap-3 w-full max-w-[300px]">
            <div className="w-8 h-8 border-2 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            {fetchProgress ? (
              <div className="w-full">
                <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
                  <div
                    className={`h-full rounded-full bg-[#1f1c17] transition-all duration-300 ${fetchProgress.ratio === undefined ? "w-1/3 progress-indeterminate" : ""}`}
                    style={fetchProgress.ratio !== undefined ? { width: `${Math.max(4, Math.round(fetchProgress.ratio * 100))}%` } : undefined}
                  ></div>
                </div>
                <p className="mt-2 text-xs text-black/55 text-center">{fetchProgress.text}</p>
              </div>
            ) : (
              <p className="text-sm text-black/45">加载中...</p>
            )}
          </div>
        </div>
      )}

      {/* Content - scrollable */}
      {stats && (
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-3">
          <div className="content-wrapper px-2 min-w-0">
            {/* 服务器账号顶部提示：本机无登录凭证，仅可查看；刷新从服务器重载（与主页同一位置/样式） */}
            {isServerAccount && (
              <div className="mb-2 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-800 text-xs leading-relaxed">
                服务器账号，无登录凭证，仅可查看，刷新重载
              </div>
            )}
            {/* Tab bar - segmented control, sticky at top, 整体居中 */}
            <div className="flex items-center justify-center gap-2.5 px-4 py-2 mb-2 sticky top-0 bg-[#f5f5f5]/95 backdrop-blur z-10">
              {/* 分段按钮组（宽度覆盖页面 80%，更扁；按钮均分） */}
              <div className="flex items-center rounded-full border border-black/10 bg-white/85 p-1 shadow-sm shrink-0 w-[80%] max-w-[800px]">
                {(["revenue", "blindbox", "display", "gift_screenshot", "other"] as const)
                  .filter((tab) => tab !== "display" || displaySupported) // 展示仅 Windows 桌面显示
                  .map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 rounded-full px-2 py-1 text-sm font-medium transition-all ${
                      activeTab === tab
                        ? "bg-[#1f1c17] text-white shadow-sm"
                        : "text-black/65 hover:bg-black/5"
                    }`}
                  >
                    {tab === "revenue" ? "收入" : tab === "blindbox" ? "盲盒" : tab === "display" ? "展示" : tab === "gift_screenshot" ? "大礼物" : "其他"}
                  </button>
                ))}
              </div>
              {/* 刷新按钮（右侧）：缺口弧形边框，按钮状态/行为与粉丝页完全一致
                  - syncing=true → 三点动画（全局同步信号，粉丝/主播同时出现）
                  - lastRefreshTime 存在 → 显示时间（父组件统一维护，粉丝/主播同值）
                  - 否则 → "刷新" 字样
                  - 非本机账号 + 非服务器账号 → 禁用并半透明（和粉丝页对称） */}
              <div className="shrink-0">
                <button
                  onClick={() => {
                    if (isServerAccount) {
                      onRefresh?.();
                      return;
                    }
                    if (!isLocalAccount) {
                      showToast?.("非本机登录账号，没有登录凭证，无法更新数据");
                      return;
                    }
                    onRefresh?.();
                  }}
                  disabled={syncing || loading || (!isLocalAccount && !isServerAccount)}
                  className={`refresh-btn-arc relative flex items-center justify-center h-[34px] w-[34px] ${!isLocalAccount && !isServerAccount ? "opacity-40" : ""}`}
                >
                  {syncing ? (
                    <span className="relative z-10 flex items-center gap-[2px] text-[#22c55e] select-none">
                      <span className="dot-anim w-[3px] h-[3px] rounded-full bg-current" style={{ animationDelay: "0ms" }} />
                      <span className="dot-anim w-[3px] h-[3px] rounded-full bg-current" style={{ animationDelay: "150ms" }} />
                      <span className="dot-anim w-[3px] h-[3px] rounded-full bg-current" style={{ animationDelay: "300ms" }} />
                    </span>
                  ) : lastRefreshTime ? (
                    <span className="relative z-10 text-[10px] leading-none font-medium text-[#22c55e] select-none">{lastRefreshTime}</span>
                  ) : (
                    <span className="relative z-10 text-[10px] leading-none font-medium text-[#22c55e] select-none">刷新</span>
                  )}
                </button>
              </div>
            </div>

            <section className="grid grid-cols-1 gap-6 w-full min-w-0">
              {/* 收入统计 tab */}
              {activeTab === "revenue" && (
                <article className="rounded-xl border border-black/10 bg-white/80 p-3 shadow-[0_20px_80px_rgba(31,28,23,0.08)] overflow-visible">
                  {stats.dateRange && (
                    <div className="text-xs text-black/40 mb-3 flex items-center gap-1">
                      统计范围<InfoHint text="最长只有最近3年记录" />: {stats.dateRange.start.replace(/-/g, ".")} - {stats.dateRange.end.replace(/-/g, ".")}
                    </div>
                  )}

                  <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 mb-3">
                    <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3">
                      <div className="text-xs text-black/45">总收益（已扣除一半）</div>
                      <div className="mt-1 text-xl font-semibold">{formatBattery(stats.totalHamster)} <span className="text-xs font-normal text-black/45">电池</span></div>
                    </div>
                    <div className="rounded-lg border border-black/10 bg-[#fff7ef] p-3">
                      <div className="text-xs text-black/45">收礼次数</div>
                      <div className="mt-1 text-xl font-semibold">{stats.totalCount}</div>
                    </div>
                    <div className="rounded-lg border border-black/10 bg-[#f0f7ee] p-3">
                      <div className="text-xs text-black/45">礼物种类</div>
                      <div className="mt-1 text-xl font-semibold">{stats.giftTypes}</div>
                    </div>
                    <div
                      className="rounded-lg border border-black/10 bg-[#f5f0f7] p-3 cursor-pointer hover:shadow-md transition-shadow"
                      onClick={openFanBubbleChart}
                    >
                      <div className="text-xs text-black/45">
                        送礼粉丝
                      </div>
                      <div className="mt-1 text-xl font-semibold">{stats.fanCount}</div>
                    </div>
                  </div>

                  {/* 最新记录 */}
                  {stats.records.length > 0 && (() => {
                    const latest = stats.records[0];
                    return (
                      <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3 mb-3">
                        <span className="text-sm font-medium text-black/65">最新记录（验证是否最新）</span>
                        <div className="flex items-center justify-between text-sm mt-1">
                          <span className="font-medium">{latest.name}×{latest.num}</span>
                          <span className="text-black">{latest.uname}</span>
                          <span className="text-black/55">{latest.time}</span>
                        </div>
                      </div>
                    );
                  })()}

                  <hr className="border-t border-black/10 my-2" />

                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0">
                    <div className="min-w-0 pr-2 border-r border-black/10">
                      <h3 className="text-sm font-semibold tracking-tight text-center mb-1">日期统计</h3>
                      {monthlyData.length > 0 && (() => {
                        const barWidth = 10;
                        const minWidth = Math.max(monthlyData.length * (barWidth + 4) + 20, 100);
                        const shouldSkipLabels = monthlyData.length > 8;

                        function formatHamsterForTooltip(value: number) {
                          const battery = value / 100;
                          if (battery >= 10000) return `${(battery / 10000).toFixed(1)}万 电池`;
                          return `${battery % 1 === 0 ? battery : battery.toFixed(1)} 电池`;
                        }

                        return (
                          <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none">
                            <div className="text-[10px] text-black/45">月度统计</div>
                            <div className="overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
                              <div style={{ width: "100%", minWidth: `${minWidth}px` }}>
                                <ResponsiveContainer width="100%" height={170} minWidth={0}>
                                  <BarChart data={monthlyData} margin={{ top: 16, right: 2, left: 2, bottom: 2 }}>
                                    <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 10, fill: "#888" }} axisLine={{ stroke: "#e5e0d8" }} tickLine={false} />
                                    <Tooltip
                                      content={({ active, label, payload }: any) => {
                                        if (active && payload && payload.length) {
                                          return (
                                            <div style={{ borderRadius: "12px", border: "1px solid #e5e0d8", background: "#fff", padding: "8px 12px", fontSize: "12px" }}>
                                              <p style={{ margin: 0, fontWeight: 500 }}>{monthLabel(String(label))}</p>
                                              <p style={{ margin: "4px 0 0 0", color: "#1f1c17" }}>{formatHamsterForTooltip(Number(payload[0].value))}</p>
                                            </div>
                                          );
                                        }
                                        return null;
                                      }}
                                    />
                                    <Bar dataKey="hamster" radius={[3, 3, 0, 0]} barSize={barWidth} cursor="pointer" isAnimationActive={false}
                                      onClick={(data: any) => { if (data?.month) { setSelectedMonth(data.month === selectedMonth ? null : data.month); setSelectedDay(null); } }}
                                      label={(props: any) => {
                                        const { x, y, width, value, index } = props;
                                        if (!value) return null;
                                        if (shouldSkipLabels && index % 3 !== 0) return null;
                                        const rmb = value / 100;
                                        const text = rmb >= 10000 ? `${(rmb / 10000).toFixed(1)}万` : (rmb % 1 === 0 ? rmb : rmb.toFixed(1));
                                        return <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fill="#888">{text}</text>;
                                      }}
                                    >
                                      {monthlyData.map((entry) => (
                                        <Cell key={entry.month} fill={entry.month === selectedMonth ? "#2563eb" : "#1f1c17"} />
                                      ))}
                                    </Bar>
                                  </BarChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {selectedMonth && calendarData && (
                        <div className="mt-2 border-t border-black/10 pt-2">
                          <div className="text-xs font-medium text-black/70 mb-1">
                            {calendarData.year}年{calendarData.month}月
                          </div>
                          <div className="grid grid-cols-7 mb-0.5">
                            {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
                              <div key={d} className="text-center text-[9px] text-black/35 py-0.5">{d}</div>
                            ))}
                          </div>
                          {calendarData.weeks.map((week, wi) => (
                            <div key={wi} className="grid grid-cols-7 gap-0.5">
                              {week.map((cell, ci) => {
                                const intensity = cell.day !== null && cell.hamster > 0
                                  ? Math.min(cell.hamster / maxDayHamster, 1)
                                  : 0;
                                const isSelected = cell.day === selectedDay;
                                return (
                                  <button
                                    key={ci}
                                    disabled={cell.day === null}
                                    onClick={() => {
                                      if (cell.day !== null) setSelectedDay(cell.day === selectedDay ? null : cell.day);
                                    }}
                                    className={`flex flex-col items-center justify-center rounded text-[10px] py-0.5 transition ${
                                      cell.day === null ? "" : isSelected ? "bg-[#2563eb] text-white font-semibold" : ""
                                    }`}
                                    style={
                                      cell.day !== null && !isSelected
                                        ? { backgroundColor: intensity > 0 ? `rgba(31,28,23,${0.08 + intensity * 0.25})` : undefined, color: intensity > 0.6 ? "white" : undefined }
                                        : undefined
                                    }
                                    title={cell.day !== null ? `${cell.day}日: ${formatBattery(cell.hamster)}电池` : ""}
                                  >
                                    {cell.day !== null && (
                                      <>
                                        <span>{cell.day}</span>
                                        {cell.hamster > 0 && (
                                          <span className="text-[8px] opacity-70 leading-none">{formatCoinsShort(cell.hamster / 100)}</span>
                                        )}
                                      </>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="pl-2">
                      <h3 className="text-sm font-semibold tracking-tight text-center mb-1">粉丝分布</h3>
                      <div className="flex flex-col">
                        {allFans.length > 0 && (() => {
                          const TOP_N = 20;
                          const buildPieData = (fans: Array<{ uid: number; uname: string; hamster: number }>) => {
                            const result: Array<{ uname: string; hamster: number; uid: number | null; fill: string; battery: number }> = [];
                            let otherHamster = 0;
                            for (let i = 0; i < fans.length; i++) {
                              if (i < TOP_N) {
                                result.push({ uname: fans[i].uname, hamster: fans[i].hamster, uid: fans[i].uid, fill: pieColors[i % pieColors.length], battery: fans[i].hamster / 100 });
                              } else {
                                otherHamster += fans[i].hamster;
                              }
                            }
                            if (otherHamster > 0) {
                              result.push({ uname: "其他", hamster: otherHamster, uid: null, fill: "#94a3b8", battery: otherHamster / 100 });
                            }
                            return result;
                          };
                          const allTimePieData = buildPieData(allFans);
                          return (
                            <>
                              <div className="text-[10px] text-black/45">全部时期</div>
                              <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none -mx-1" style={{ height: 170 }}>
                                <ResponsiveContainer width="100%" height={170}>
                                  <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                    <Pie
                                      data={allTimePieData}
                                      dataKey="hamster"
                                      nameKey="uname"
                                      cx="50%"
                                      cy="50%"
                                      outerRadius="95%"
                                      paddingAngle={0}
                                      isAnimationActive={false}
                                      onClick={(data: any, index: number, e: any) => {
                                        if (data?.uid !== null && data?.uid !== undefined) {
                                          const uidStr = String(data.uid);
                                          setSelectedFan(uidStr === selectedFan ? "" : uidStr);
                                          setSelectedDay(null);
                                        }
                                        // 点击扇形：选中/取消选中。移动端只有选中才显示提示框
                                        setPieActive(pieActive?.chart === "all" && pieActive?.index === index ? null : { chart: "all", index });
                                        if (typeof (e as any)?.clientX === "number") {
                                          setPieTipPos({ x: (e as any).clientX, y: (e as any).clientY });
                                        }
                                      }}
                                      cursor="pointer"
                                    >
                                      {allTimePieData.map((entry, index) => (
                                        <Cell
                                          key={`cell-all-${index}`}
                                          fill={entry.fill}
                                          stroke={selectedFan && entry.uid !== null && String(entry.uid) === selectedFan ? "#1f1c17" : "none"}
                                          strokeWidth={selectedFan && entry.uid !== null && String(entry.uid) === selectedFan ? 2 : 0}
                                        />
                                      ))}
                                    </Pie>
                                    {/* 桌面端用 hover 显示提示框 */}
                                    {!pieIsMobile && (
                                      <Tooltip content={<PieTooltip />} />
                                    )}
                                    {/* 移动端：仅选中时显示提示框 */}
                                    {pieIsMobile && pieActive?.chart === "all" && allTimePieData[pieActive.index] && (
                                      <PieTooltip
                                        active
                                        coordinate={pieTipPos}
                                        payload={[{
                                          name: allTimePieData[pieActive.index].uname,
                                          value: allTimePieData[pieActive.index].hamster,
                                          payload: { fill: allTimePieData[pieActive.index].fill, battery: allTimePieData[pieActive.index].battery },
                                        }]}
                                      />
                                    )}
                                  </PieChart>
                                </ResponsiveContainer>
                              </div>
                            </>
                          );
                        })()}

                        {selectedMonth && periodFans.length > 0 && (() => {
                          const TOP_N = 20;
                          const buildPieData = (fans: Array<{ uid: number; uname: string; hamster: number }>) => {
                            const result: Array<{ uname: string; hamster: number; uid: number | null; fill: string; battery: number }> = [];
                            let otherHamster = 0;
                            for (let i = 0; i < fans.length; i++) {
                              if (i < TOP_N) {
                                result.push({ uname: fans[i].uname, hamster: fans[i].hamster, uid: fans[i].uid, fill: pieColors[i % pieColors.length], battery: fans[i].hamster / 100 });
                              } else {
                                otherHamster += fans[i].hamster;
                              }
                            }
                            if (otherHamster > 0) {
                              result.push({ uname: "其他", hamster: otherHamster, uid: null, fill: "#94a3b8", battery: otherHamster / 100 });
                            }
                            return result;
                          };
                          const periodPieData = buildPieData(periodFans);
                          const title = selectedDay !== null
                            ? `${selectedMonth.slice(0, 4)}年${parseInt(selectedMonth.slice(4, 6))}月${selectedDay}日粉丝分布`
                            : `${selectedMonth.slice(0, 4)}年${parseInt(selectedMonth.slice(4, 6))}月粉丝分布`;
                          return (
                            <div className="mt-2 border-t border-black/10 pt-2">
                              <div className="text-[10px] text-black/45">{title}</div>
                              <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none -mx-1" style={{ height: 170 }}>
                                <ResponsiveContainer width="100%" height={170}>
                                  <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                    <Pie
                                      data={periodPieData}
                                      dataKey="hamster"
                                      nameKey="uname"
                                      cx="50%"
                                      cy="50%"
                                      outerRadius="95%"
                                      paddingAngle={0}
                                      isAnimationActive={false}
                                      onClick={(data: any, index: number, e: any) => {
                                        if (data?.uid !== null && data?.uid !== undefined) {
                                          const uidStr = String(data.uid);
                                          setSelectedFan(uidStr === selectedFan ? "" : uidStr);
                                          setSelectedDay(null);
                                        }
                                        // 点击扇形：选中/取消选中。移动端只有选中才显示提示框
                                        setPieActive(pieActive?.chart === "period" && pieActive?.index === index ? null : { chart: "period", index });
                                        if (typeof (e as any)?.clientX === "number") {
                                          setPieTipPos({ x: (e as any).clientX, y: (e as any).clientY });
                                        }
                                      }}
                                      cursor="pointer"
                                    >
                                      {periodPieData.map((entry, index) => (
                                        <Cell
                                          key={`cell-period-${index}`}
                                          fill={entry.fill}
                                          stroke={selectedFan && entry.uid !== null && String(entry.uid) === selectedFan ? "#1f1c17" : "none"}
                                          strokeWidth={selectedFan && entry.uid !== null && String(entry.uid) === selectedFan ? 2 : 0}
                                        />
                                      ))}
                                    </Pie>
                                    {/* 桌面端用 hover 显示提示框 */}
                                    {!pieIsMobile && (
                                      <Tooltip content={<PieTooltip />} />
                                    )}
                                    {/* 移动端：仅选中时显示提示框 */}
                                    {pieIsMobile && pieActive?.chart === "period" && periodPieData[pieActive.index] && (
                                      <PieTooltip
                                        active
                                        coordinate={pieTipPos}
                                        payload={[{
                                          name: periodPieData[pieActive.index].uname,
                                          value: periodPieData[pieActive.index].hamster,
                                          payload: { fill: periodPieData[pieActive.index].fill, battery: periodPieData[pieActive.index].battery },
                                        }]}
                                      />
                                    )}
                                  </PieChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          );
                        })()}

                        <div className="mt-1">
                          <Dropdown
                            value={selectedFan}
                            onChange={(v) => { setSelectedFan(v); setSelectedDay(null); }}
                            placeholder="全部粉丝（电池）"
                            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-xs text-black/80 outline-none"
                            options={[
                              { value: "", label: "全部粉丝（电池）" },
                              ...(selectedMonth ? periodFans : allFans).map((fan) => ({
                                value: String(fan.uid),
                                label: `${fan.uname} (${formatBattery(fan.hamster)})`,
                              })),
                            ]}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <hr className="border-t border-black/10 my-2" />

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold tracking-tight flex items-center gap-1">
                        礼物清单
                        <span className="ml-2 text-xs font-normal text-black/45">
                          {selectedFan ? (allFans.find((f) => f.uid === Number(selectedFan))?.uname ?? "") : "全部粉丝"}
                        </span>
                        <span className="ml-2 text-xs font-normal text-black/45">
                          {selectedMonth
                            ? `${monthLabel(selectedMonth)}${selectedDay !== null ? `.${selectedDay}日` : ""}`
                            : stats.dateRange ? `${stats.dateRange.start.replace(/-/g, ".")} - ${stats.dateRange.end.replace(/-/g, ".")}` : "全部时间"}
                        </span>
                        <span className="ml-2 text-xs font-semibold text-black/65">
                          {formatBattery(giftSummaryFiltered.reduce((s, g) => s + g.hamster, 0))}电池
                        </span>
                      </h3>
                      {giftSummaryFiltered.length > 0 && (
                        <button
                          onClick={() => setShowGiftSaveModal(true)}
                          className="rounded-full bg-[#1f1c17] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
                        >
                          保存为图片
                        </button>
                      )}
                    </div>

                    {giftSummaryFiltered.length > 0 ? (
                      <div className="mt-2 overflow-hidden rounded-xl border border-black/10">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead className="bg-black/5 text-black/60">
                            <tr>
                              <th className="px-3 py-1.5 font-medium text-xs">礼物</th>
                              <th className="px-3 py-1.5 font-medium text-xs text-right whitespace-nowrap">单价(电池)</th>
                              <th className="px-3 py-1.5 font-medium text-xs text-right">数量</th>
                              <th className="px-3 py-1.5 font-medium text-xs text-right whitespace-nowrap">小计(电池)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {giftSummaryFiltered.map((gift) => (
                              <tr key={gift.gift_id} className="border-t border-black/10 bg-white">
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-1.5">
                                    {gift.img ? <img src={gift.img} alt="" className="w-5 h-5 rounded flex-shrink-0" /> : null}
                                    <span className="font-medium text-xs">{gift.name}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-1.5 text-right text-xs">{formatBattery(gift.hamster / gift.num)}</td>
                                <td className="px-3 py-1.5 text-right text-xs">{gift.num}</td>
                                <td className="px-3 py-1.5 text-right text-xs">{formatBattery(gift.hamster)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-black/45">暂无礼物记录</p>
                    )}
                  </div>
                </article>
              )}

              {/* 盲盒盈亏 tab */}
              {activeTab === "blindbox" && (
                <>
                  {blindBoxProfits && blindBoxProfits.length > 0 ? (
                    <div className="space-y-4">
                      {blindBoxProfits.map((bb, idx) => {
                        const isXindong = bb.gift_id === 32251;
                        const blindPrice = bb.blindPrice; // 单位：电池
                        const totalSpent = bb.cost / 100; // hamster → 电池
                        const totalEarned = bb.totalHamster / 100; // hamster → 电池
                        const profit = bb.profit / 100; // hamster → 电池
                        return (
                          <div key={bb.gift_id} className={`rounded-lg border border-black/10 p-2 ${getBlindBoxCardBg(idx)}`}>
                            {/* Row 1: 盲盒图标+名称 + 统计时间 */}
                            <div className="flex items-center gap-2 mb-2">
                              {(bb.img || BLIND_BOX_CONFIG.icons[bb.gift_id]) && (
                                <img src={bb.img || BLIND_BOX_CONFIG.icons[bb.gift_id]} alt="" className="w-6 h-6 rounded" />
                              )}
                              <span className="font-semibold text-sm truncate max-w-[80px]">{bb.name.slice(0, 6)}{bb.name.length > 6 ? "..." : ""}</span>
                              <span className="ml-auto text-xs text-black/65 inline-flex items-center gap-1">
                                {bb.dateRange
                                  ? `${bb.dateRange.start.replace(/-/g, ".")} - ${bb.dateRange.end.replace(/-/g, ".")}`
                                  : "无数据"}
                                <InfoHint align="right" text="最长只有最近3年记录" />
                              </span>
                            </div>

                            {/* Row 2: 时间筛选 + 粉丝筛选 */}
                            <div className="grid grid-cols-2 gap-2 mb-2">
                              <div className="flex border border-black/10 rounded-lg overflow-hidden">
                                {(["all", "thisMonth", "thisWeek", "yesterday"] as const).map((key) => {
                                    const isYesterday = key === "yesterday";
                                    const disabled = isYesterday && !yesterdayAvailable;
                                    return (
                                    <button
                                      key={key}
                                      disabled={disabled}
                                      title={disabled ? "昨日数据官方尚未更新，预计12点前更新" : undefined}
                                      onClick={() => {
                                        setBlindBoxDateFilter(key);
                                        const fanParam = blindBoxFanFilter ? `&fan=${blindBoxFanFilter}` : "";
                                        const url = `/api/anchor/gifts${key !== "all" ? `?dateRange=${key}${fanParam}` : (fanParam ? `?${fanParam.slice(1)}` : "")}`;
                                        dataFetch(url, { cache: "no-store" }).then(r => r.json()).then(data => {
                                          if (data.code === 0 && data.data) setBlindBoxProfits(data.data.blindBoxProfits);
                                        });
                                      }}
                                      className={`flex-1 px-1 py-1 text-[10px] whitespace-nowrap transition ${
                                        blindBoxDateFilter === key
                                          ? "bg-[#1f1c17] text-white"
                                          : disabled
                                            ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                                            : "bg-white text-black/65 hover:bg-black/5"
                                      }`}
                                    >
                                      {key === "all" ? "全部" : key === "thisMonth" ? "本月" : key === "thisWeek" ? "本周" : "昨日"}
                                    </button>
                                    );
                                  })}
                              </div>
                              <Dropdown
                                value={blindBoxFanFilter}
                                onChange={(fanUid) => {
                                  setBlindBoxFanFilter(fanUid);
                                  const dateParam = blindBoxDateFilter !== "all" ? `dateRange=${blindBoxDateFilter}` : "";
                                  const fanParam = fanUid ? `fan=${fanUid}` : "";
                                  const params = [dateParam, fanParam].filter(Boolean).join("&");
                                  const url = `/api/anchor/gifts${params ? `?${params}` : ""}`;
                                  dataFetch(url, { cache: "no-store" }).then(r => r.json()).then(data => {
                                    if (data.code === 0 && data.data) setBlindBoxProfits(data.data.blindBoxProfits);
                                  });
                                }}
                                className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/65 outline-none"
                                options={[
                                  { value: "", label: "全部粉丝" },
                                  // 选择了具体时间段时用 bb.anchors（服务器已按该时间段过滤列表与数量），
                                  // 选择"全部"时用完整粉丝列表（保留切换粉丝的能力）
                                  ...(blindBoxDateFilter !== "all" ? bb.anchors : (fullBlindBoxAnchors[bb.gift_id] ?? bb.anchors)).map((a) => ({
                                    value: String(a.ruid),
                                    label: `${a.rname} (${a.count})`,
                                  })),
                                ]}
                              />
                            </div>

                            {/* Row 3: 统计数据 */}
                            <div className="flex items-center justify-between gap-3 rounded-lg bg-black/5 px-3 py-2 text-xs">
                              <span className="text-black/50">单价 <b className="text-black/80">{blindPrice}</b></span>
                              <span className="text-black/50">共 <b className="text-black/80">{bb.drawCount}</b> 次</span>
                              <span className="text-black/50">花费 <b className="text-black/80">{totalSpent}</b></span>
                              <span className="text-black/50">爆出 <b className="text-black/80">{totalEarned}</b></span>
                              <span className={`font-bold text-sm ${profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                                {profit >= 0 ? "+" : ""}{profit}
                              </span>
                            </div>

                            {/* 礼品明细 */}
                            {bb.gifts.length > 0 && (
                              <div className="mt-2 overflow-hidden rounded-lg border border-black/10">
                                <table className="w-full border-collapse text-left text-sm">
                                  <thead className="bg-black/5 text-black/60">
                                    <tr>
                                      <th className="pl-3 pr-2 py-2 font-medium w-[45%]">爆出礼物</th>
                                      <th className="px-2 py-2 font-medium text-right w-[15%]">单价</th>
                                      <th className="px-2 py-2 font-medium text-right w-[15%]">数量</th>
                                      <th className="px-2 py-2 font-medium text-right w-[25%]">小计</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {bb.gifts
                                      .filter(g => g.num > 0)
                                      .sort((a, b) => b.hamster - a.hamster)
                                      .map((gift) => (
                                        <tr key={`${gift.gift_id}_${gift.name}`} className="border-t border-black/10 bg-white">
                                          <td className="pl-3 pr-2 py-2">
                                            <div className="flex items-center gap-2">
                                              {gift.img && <img src={fixImageUrl(gift.img)} alt="" className="w-5 h-5 rounded flex-shrink-0" />}
                                              <span className="font-medium text-xs">{gift.name}</span>
                                            </div>
                                          </td>
                                          <td className="px-2 py-2 text-right text-xs">{gift.hamster / (gift.num || 1) / 100}</td>
                                          <td className="px-2 py-2 text-right text-xs">{gift.num}</td>
                                          <td className="px-2 py-2 text-right text-xs">{gift.hamster / 100}</td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4">
                      <div className="text-sm text-black/35">暂无盲盒记录</div>
                    </div>
                  )}
                </>
              )}

              {/* 展示 tab（直播展示画布：入场/礼物/高级动画）—— 仅 Windows 桌面可用 */}
              {displaySupported && activeTab === "display" && (
                <DisplayPanel mid={mid} isLocalAccount={isLocalAccount} showToast={showToast} />
              )}

              {/* 礼物截图 tab */}
              {activeTab === "gift_screenshot" && (
                <div className="space-y-6">
                  {/* 礼物录屏（新功能，置于截图上方） */}
                  <GiftReplayPanel
                    anchorName={anchorName}
                    anchorFace={anchorFace}
                    anchorUid={mid}
                  />
                  {/* 分割线：区分录屏与截图两个功能模块 */}
                  <div className="border-t-2 border-dashed border-black/15" />
                  <GiftScreenshotPanel
                    records={stats.records}
                    anchorName={anchorName}
                    anchorFace={anchorFace}
                    fanFaces={fanFaces}
                    yesterdayAvailable={yesterdayAvailable}
                    mid={mid}
                    uname={uname}
                  />
                </div>
              )}

              {/* 其他数据 tab */}
              {activeTab === "other" && stats.otherStats && (
                <div className="space-y-4">
                  {/* 活跃天数统计 */}
                  <article className="rounded-xl border border-black/10 bg-white/80 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
                    <h3 className="text-base font-bold tracking-tight mb-3 inline-flex items-center gap-1">活跃天数<InfoHint text="最长只有最近3年记录" /></h3>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3">
                        <div className="text-xs text-black/70">收礼总天数</div>
                        <div className="mt-1 text-2xl font-semibold">{stats.otherStats.dayStats.totalDays} <span className="text-sm font-normal text-black/45">天</span></div>
                      </div>
                      <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3">
                        <div className="text-xs text-black/70">连续收礼最长</div>
                        <div className="mt-1 text-2xl font-semibold">{stats.otherStats.dayStats.maxConsecutiveDays} <span className="text-sm font-normal text-black/45">天</span></div>
                      </div>
                    </div>
                  </article>

                  {/* 粉丝送礼详情 */}
                  <article className="rounded-xl border border-black/10 bg-white/80 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
                    <h3 className="text-base font-bold tracking-tight mb-3">粉丝送礼详情</h3>
                    {stats.otherStats.fanStats.length > 0 ? (
                      <div className="space-y-2">
                        {stats.otherStats.fanStats.slice(0, 20).map((fan) => (
                          <div key={fan.uid} className="rounded-lg border border-black/10 bg-white p-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">{fan.uname}</span>
                            </div>
                            <div className="mt-1 space-y-1 text-xs text-black/55">
                              <div>共 {fan.totalDays} 天来给你送礼物</div>
                              {fan.maxConsecutiveDays > 0 && (
                                <div>
                                  连续 {fan.maxConsecutiveDays} 天来给你送礼物
                                  {fan.consecutiveStart && fan.consecutiveEnd && (
                                    <span className="text-black/35 ml-1">
                                      ({fan.consecutiveStart.replace(/-/g, ".")} - {fan.consecutiveEnd.replace(/-/g, ".")})
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3">
                        <div className="text-xs text-black/35">暂无粉丝记录</div>
                      </div>
                    )}
                  </article>
                </div>
              )}

              {activeTab === "other" && !stats.otherStats && (
                <article className="rounded-xl border border-black/10 bg-white/80 p-6 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-center">
                  <div className="text-sm text-black/45">正在加载其他数据...</div>
                </article>
              )}
            </section>
          </div>
        </div>
      )}

      {/* 礼物清单保存图片弹窗 */}
      {showGiftSaveModal && giftSummaryFiltered.length > 0 && (
        <GiftSaveModal
          gifts={giftSummaryFiltered}
          totalTypes={giftSummaryFiltered.length}
          totalCount={giftSummaryFiltered.reduce((s, g) => s + g.num, 0)}
          totalHamster={giftSummaryFiltered.reduce((s, g) => s + g.hamster, 0)}
          dateRangeStr={giftListDateStr}
          fanName={giftListFanName}
          onClose={() => setShowGiftSaveModal(false)}
        />
      )}

      {/* 粉丝头像气泡分布图 */}
      {fanBubbleData && (
        <AvatarBubbleChart
          items={fanBubbleData.items}
          title={fanBubbleData.title}
          loading={fanBubbleData.loading}
          loadingText={fanBubbleData.loadingText}
          onClose={() => setFanBubbleData(null)}
        />
      )}
    </div>
  );
});

export default AnchorDataModule;