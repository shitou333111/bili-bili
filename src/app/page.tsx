"use client";

import { useState, useEffect, useRef, useMemo, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { toPng } from "html-to-image";
import { isMobileDevice } from "@/lib/device";
import { serverApiUrl } from "@/lib/server-api";
import { dataFetch } from "@/lib/client-fetch";
import { uploadAllUserData } from "@/lib/stats-client";
import { useOnlineStatus } from "@/lib/use-online";
import { BLIND_BOX_CONFIG } from "@/lib/config";
import { getBlindBoxCardBg, HISTORICAL_PNL_BG, PAGE_MAX_WIDTH_NUM } from "@/lib/layout";
import { getPlatform } from "@/lib/platform";
import SynthesisActivityCard from "@/components/SynthesisActivityCard";
import AnchorDataModule from "@/components/AnchorDataModule";
import AvatarBubbleChart, { type BubbleItem } from "@/components/AvatarBubbleChart";
import BottomDock, { type DockTabKey } from "@/components/BottomDock";
import PieTooltip from "@/components/PieTooltip";
import { showToast } from "@/lib/toast";
import { saveMobileOrDownload } from "@/lib/save-image";
import { downloadJsonFile } from "@/lib/download-json";
import Dropdown from "@/components/Dropdown";
import { RevenueModuleContent } from "@/components/RevenueModuleContent";

// Android/Tauri：关闭应用窗口（栈空时第二次按返回才调用）。非 Tauri 环境忽略。
async function closeApp() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    // 非 Tauri（浏览器调试等）下忽略，交由浏览器默认行为处理
  }
}

function formatTimestamp(ts: number) {
  const date = new Date(ts * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  const secs = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

type Account = {
  sid: string;
  uname: string;
  mid: number;
  face?: string;
  source: "qr" | "dev" | "server";
  updatedAt: string;
};

type Snapshot = {
  source: "real";
  month: string;
  nextId: number;
  totalRecords: number;
  totalCoins: number;
  giftCatalog: Array<{
    giftName: string;
    giftImg: string;
    giftId: number;
    latestTimestamp: number;
  }>;
  records: Array<{
    id: number;
    gift_num: number;
    gift_name: string;
    gift_id: number;
    gift_img: string;
    ruid: number;
    r_uname: string;
    timestamp: number;
    totalCoins: number;
    giftNameKey: string;
    bag_desc: string;
    status_msg?: string;
  }>;
};

type CastleStat = {
  ruid: number;
  rname: string;
  totalCount: number;
  dates: Array<{ date: string; count: number }>;
};

type BlindBoxProfitResult = {
  blindBoxId: number;
  blindBoxName: string;
  blindBoxImg: string;
  blindPrice: number;
  totalSpent: number;
  totalEarned: number;
  profit: number;
  drawCount: number;
  recordCount: number;
  dateRange: { start: string; end: string } | null;
  anchors: Array<{ ruid: number; rname: string; count: number }>;
  filter: { ruid: number | null; dateRange: string };
  gifts: Array<{
    gift_id: number;
    gift_name: string;
    gift_img: string;
    unitPrice: number;
    count: number;
    totalValue: number;
  }>;
  castleStats: CastleStat[];
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
};

type BlindBoxStats = BlindBoxProfitResult[];

type Certification = {
  date: string;
  type: "lucky" | "unlucky" | "rich";
  drawCount: number;
  castleCount: number;
  profit: number;
  spent: number;
  earned: number;
  userName: string;
  blindBoxName: string;
  blindBoxImg: string;
  castleName: string;
  castleImg: string;
};

type SynthesisGiftInfo = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  gift_price: number;
  count: number;
};

type SynthesisActivityStats = {
  id: string;
  type: string;
  name: string;
  icon?: string;
  profit: {
    totalSpent: number;
    totalEarned: number;
    profit: number;
    drawCount: number;
    replaceCount: number;
    synthesisCount: number;
    successCount: number;
    giftList: SynthesisGiftInfo[];
    anchors: Array<{ ruid: number; rname: string; totalSpent: number; totalEarned: number }>;
    detailedRecords: Array<{
      ruid: number;
      rname: string;
      gift_name: string;
      gift_price: number;
      gift_img: string;
      spent: number;
      profit: number;
      synthetic_result: number;
      date: string;
      synthetic_time: number;
    }>;
  };
  certifications: Array<{
    type: "lucky" | "unlucky" | "rich";
    ruid: number;
    rname: string;
    gift_name: string;
    gift_price: number;
    gift_img: string;
    spent: number;
    profit: number;
    date: string;
    count?: number;
  }>;
};

type SynthesisStats = {
  historical: { totalSpent: number; totalEarned: number; profit: number; drawCount: number; replaceCount: number; synthesisCount: number; successCount: number; detailedRecords?: any[]; giftList?: any[]; anchorStats?: Array<{ ruid: number; rname: string; count: number; value: number; spent: number; profit: number }> };
  activities: SynthesisActivityStats[];
  tianxuanGifts?: { id: number; name: string }[];
  redPocketGifts?: { id: number; name: string }[];
};

type OtherGiftEntry = {
  gift_id: number;
  gift_name: string;
  gift_img: string;
  totalNum: number;
  totalValue: number;
  unitPrice: number;
};

type OtherStats = {
  giftStats: {
    gifts: OtherGiftEntry[];
    totalCount: number;
    totalValue: number;
    hasLuckyTitle: boolean;
  };
  dayStats: {
    totalDays: number;
    maxConsecutiveDays: number;
    maxConsecutiveStart: string;
    maxConsecutiveEnd: string;
    maxDaysInYear: number;
    maxDaysInYearRange: { start: string; end: string };
  };
  roomStats: Array<{
    ruid: number;
    rname: string;
    totalDays: number;
    maxConsecutiveDays: number;
    maxConsecutiveStart: string;
    maxConsecutiveEnd: string;
    maxDaysInYear: number;
    maxDaysInYearRange: { start: string; end: string };
  }>;
  dateRange: { start: string; end: string } | null;
};

type MonthlyData = {
  month: string;
  coins: number;
  count: number;
};

function formatProfit(coins: number) {
  const sign = coins >= 0 ? "+" : "";
  return `${sign}${coins}`;
}

function formatNum(n: number): string {
  return String(n);
}

function fixImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

function formatCoinsShort(coins: number): string {
  if (coins === 0) return "0";
  if (coins >= 10000) return `${(coins / 10000).toFixed(1)}万`;
  return String(coins);
}

function formatDateShort(dateStr: string): string {
  // "2026-05-21 12:00:00" -> "2026.05.21"
  const d = dateStr.split(" ")[0];
  return d.replace(/-/g, ".");
}

function monthLabel(ym: string) {
  if (!ym || ym.length < 6) return ym;
  return ym.slice(0, 4) + "." + ym.slice(4, 6);
}

function GiftSaveModal({
  gifts,
  userName,
  dateRange,
  anchorName,
  anchorCount,
  onClose,
  selectedMonth,
  selectedDay,
  actualDateRange,
}: {
  gifts: Array<{ uid: string; gift_id: number; gift_name: string; gift_img: string; count: number; coins: number; displayCoins: number }>;
  userName: string;
  dateRange: string;
  anchorName: string;
  anchorCount: number;
  onClose: () => void;
  selectedMonth: string | null;
  selectedDay: number | null;
  actualDateRange: { start: string; end: string } | null;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const totalCount = gifts.reduce((s, g) => s + g.count, 0);
  const totalCoins = gifts.reduce((s, g) => s + g.displayCoins, 0);

  const datePartStr = selectedMonth
    ? `${selectedMonth.slice(0, 4)}.${selectedMonth.slice(4, 6)}${selectedDay !== null ? `.${String(selectedDay).padStart(2, "0")}` : ""}`
    : actualDateRange ? `${actualDateRange.start} ~ ${actualDateRange.end}` : dateRange;
  const anchorPartStr = anchorName !== "全部主播" ? ` ${anchorName}` : ` ${anchorCount} 位主播`;

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
    if (res === "fallback") showToast("未保存到相册，请长按上方图片保存");
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      {/* 隐藏的卡片用于生成图片 - 使用绝对定位移出视口而非display:none */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        <div ref={cardRef} className="w-[320px] rounded-lg overflow-hidden shadow-2xl">
          {/* 海报头部 */}
          <div className="bg-gradient-to-br from-[#1f1c17] via-[#2d2a24] to-[#3d3a34] px-5 pt-6 pb-5 text-white">
            <div className="text-sm leading-relaxed text-white/80">
              {datePartStr}，<span className="font-bold text-white">{userName}</span> 给 <span className="font-bold text-white">{anchorPartStr}</span> 送出 <span className="font-bold text-white">{gifts.length}</span> 种共 <span className="font-bold text-white">{totalCount}</span> 个礼物，花费 <span className="font-bold text-white">{totalCoins}</span> 电池
            </div>
          </div>
          {/* 礼物网格 */}
          <div className="bg-white px-4 py-4">
            <div className="grid grid-cols-3 gap-x-2 gap-y-2">
              {gifts.slice(0, 59).map((g) => (
                <div key={g.uid} className="flex items-center justify-center gap-1 text-sm py-0.5">
                  {g.gift_img ? <img src={fixImageUrl(g.gift_img)} alt="" className="w-7 h-7 rounded flex-shrink-0" crossOrigin="anonymous" /> : <span className="text-[12px] text-black/50 truncate max-w-[55px] flex-shrink-0">{g.gift_name}</span>}
                  <span className="truncate text-black/70 text-sm">×{g.count}</span>
                </div>
              ))}
              {gifts.length > 59 && (
                <div className="flex items-center justify-center gap-1 text-sm py-0.5">
                  <span className="truncate text-black/40 text-sm">...</span>
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
    </div>
  );
}

function CertificationModal({
  certifications,
  currentIndex,
  onIndexChange,
  onClose,
}: {
  certifications: Certification[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cert = certifications[currentIndex];
  const isLucky = cert.type === "lucky";
  const total = certifications.length;

  function formatDateCN(dateStr: string) {
    const parts = dateStr.split("-");
    return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
  }

  useEffect(() => {
    generateImage();
  }, [currentIndex]);

  async function generateImage() {
    setLoading(true);
    if (!cardRef.current) {
      setLoading(false);
      return;
    }
    try {
      const dataUrl = await toPng(cardRef.current, {
        backgroundColor: "#fff",
        pixelRatio: 2,
        filter: (node: HTMLElement) => !node.classList?.contains("save-exclude"),
      });
      setGeneratedImage(dataUrl);
    } catch (err) {
      console.error("生成图片失败:", err);
    } finally {
      setLoading(false);
    }
  }

  async function downloadImage() {
    if (!generatedImage) return;
    const res = await saveMobileOrDownload(generatedImage, `cert_${cert.type}_${cert.date.replace(/[^0-9]/g, "")}.png`);
    if (res === "fallback") showToast("未保存到相册，请长按上方图片保存");
  }

  function goPrev() {
    if (currentIndex > 0) onIndexChange(currentIndex - 1);
  }

  function goNext() {
    if (currentIndex < total - 1) onIndexChange(currentIndex + 1);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      {/* 隐藏的卡片用于生成图片 - 使用绝对定位移出视口而非display:none */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        <div
          ref={cardRef}
          className="w-[80vw] max-w-md rounded-lg bg-white p-6 shadow-2xl"
        >
          <div className="flex items-center gap-2 mb-4">
            <span className="text-2xl">
              {cert.type === "lucky" ? "👑" : cert.type === "rich" ? "💰" : "👻"}
            </span>
            <span className={`text-lg font-bold ${
              cert.type === "lucky" ? "text-yellow-600" :
              cert.type === "rich" ? "text-purple-600" : "text-gray-600"
            }`}>
              {cert.type === "lucky" ? "欧皇认证" :
               cert.type === "rich" ? "神豪认证" : "非酋认证"}
            </span>
            {total > 1 && (
              <span className="ml-auto text-xs text-black/35">{currentIndex + 1}/{total}</span>
            )}
          </div>

          <div className="space-y-2.5 text-sm text-black/80">
            <div className="flex items-center gap-1">
              <span className="text-black/45 w-10 flex-shrink-0">日期</span>
              <span className="font-medium">{formatDateCN(cert.date)}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-black/45 w-10 flex-shrink-0">用户</span>
              <span className="font-medium text-[#1f1c17]">{cert.userName}</span>
            </div>
            {cert.type !== "rich" && (
              <>
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-10 flex-shrink-0">开启</span>
                  <span className="font-medium">{cert.drawCount}</span>
                  <span>个心动盲盒</span>
                  {cert.blindBoxImg && (
                    <img src={fixImageUrl(cert.blindBoxImg)} alt="" className="w-5 h-5 rounded" />
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-10 flex-shrink-0">爆出</span>
                  {cert.type === "lucky" ? (
                    <>
                      <span className="font-medium text-yellow-600">{cert.castleCount}</span>
                      <span>个浪漫城堡</span>
                      {cert.castleImg && (
                        <img src={fixImageUrl(cert.castleImg)} alt="" className="w-5 h-5 rounded" />
                      )}
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-gray-500">0</span>
                      <span>个浪漫城堡</span>
                      {cert.castleImg && (
                        <img src={fixImageUrl(cert.castleImg)} alt="" className="w-5 h-5 rounded opacity-40" />
                      )}
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-10 flex-shrink-0">花费</span>
                  <span className="font-medium">{cert.spent} 电池</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-10 flex-shrink-0">爆出</span>
                  <span className="font-medium">{cert.earned} 电池</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-10 flex-shrink-0">盈亏</span>
                  <span className={`font-bold ${cert.profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {cert.profit >= 0 ? "+" : ""}{cert.profit} 电池
                  </span>
                </div>
              </>
            )}
            {cert.type === "rich" && (
              <div className="flex items-center gap-1">
                <span className="text-black/45 w-10 flex-shrink-0">爆出</span>
                <span className="font-bold text-purple-600">{cert.castleCount}</span>
                <span>个浪漫城堡</span>
                {cert.castleImg && (
                  <img src={fixImageUrl(cert.castleImg)} alt="" className="w-5 h-5 rounded" />
                )}
                <span className="ml-auto text-black/60">壕无人性！</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className="relative mx-4"
        onClick={(e) => e.stopPropagation()}
      >
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
            {/* 上方提示 */}
            {isMobileDevice() && (
              <span className="text-center text-white/80 text-base font-medium mb-2 block">长按图片保存到相册</span>
            )}

            <div className="flex flex-col items-center gap-2">
              {/* 上箭头 */}
              {total > 1 && (
                <button
                  onClick={goPrev}
                  disabled={currentIndex === 0}
                  className="w-8 h-8 rounded-full bg-white/90 text-black/60 flex items-center justify-center disabled:opacity-30 hover:bg-white transition"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 15l-7-7-7 7" />
                  </svg>
                </button>
              )}

              {/* 图片 */}
              <img src={generatedImage} alt="认证卡片" className="max-w-full max-h-[70vh] rounded-lg shadow-2xl" />

              {/* 下箭头 */}
              {total > 1 && (
                <button
                  onClick={goNext}
                  disabled={currentIndex === total - 1}
                  className="w-8 h-8 rounded-full bg-white/90 text-black/60 flex items-center justify-center disabled:opacity-30 hover:bg-white transition"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 9l7 7 7-7" />
                  </svg>
                </button>
              )}
            </div>

            {/* 下方按钮区域 */}
            <div className="flex gap-2.5 mt-3 justify-center">
              {!isMobileDevice() && (
                <button onClick={downloadImage} className="modal-action-btn modal-action-primary">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载图片
                </button>
              )}
              <button onClick={onClose} className="modal-action-btn modal-action-light">
                关闭
              </button>
            </div>

            {/* 底部指示器 */}
            {total > 1 && (
              <div className="flex justify-center gap-1.5 mt-3">
                {certifications.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => onIndexChange(i)}
                    className={`w-2 h-2 rounded-full transition ${
                      i === currentIndex ? "bg-white" : "bg-white/40"
                    }`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CastleStatModal({
  castleStat,
  castleGift,
  onClose,
}: {
  castleStat: CastleStat;
  castleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const totalDays = castleStat.dates.length;
  const totalCastles = castleStat.totalCount;

  const displayDates = (() => {
    if (totalDays <= 10) {
      return castleStat.dates;
    }
    const first = castleStat.dates[castleStat.dates.length - 1];
    const last = castleStat.dates[0];
    const middle = [...castleStat.dates.slice(1, -1)]
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
      .sort((a, b) => a.date.localeCompare(b.date));
    return [first, ...middle, last];
  })();

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
      const dataUrl = await toPng(cardRef.current, {
        backgroundColor: "#fff",
        pixelRatio: 2,
        filter: (node: HTMLElement) => !node.classList?.contains("save-exclude"),
      });
      setGeneratedImage(dataUrl);
    } catch (err) {
      console.error("生成图片失败:", err);
    } finally {
      setLoading(false);
    }
  }

  async function downloadImage() {
    if (!generatedImage) return;
    const res = await saveMobileOrDownload(generatedImage, `castle_stat_${castleStat.rname}_${Date.now()}.png`);
    if (res === "fallback") showToast("未保存到相册，请长按上方图片保存");
  }

  const maxDayCount = Math.max(...castleStat.dates.map((d) => d.count));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      {/* 隐藏的卡片用于生成图片 - 使用绝对定位移出视口而非display:none */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        <div ref={cardRef} className="rounded-xl overflow-hidden shadow-2xl">
          <div className="bg-gradient-to-br from-[#2d2a24] via-[#3d3a34] to-[#4d4a44] px-6 pt-8 pb-6 text-white">
            <div className="flex items-center justify-center gap-14 mb-2">
              <span className="text-xl font-bold text-yellow-400">{castleStat.rname}</span>
              <div className="flex items-center gap-1.5">
                {castleGift?.gift_img && (
                  <img src={fixImageUrl(castleGift.gift_img)} alt="" className="w-6 h-6 rounded" />
                )}
                <span className="text-xl font-bold">×{totalCastles}</span>
              </div>
            </div>
            {totalDays > 10 && (
              <div className="text-center text-sm text-white/60">共 {totalDays} 个日子送出城堡，最高记录单日 {maxDayCount} 堡</div>
            )}
          </div>
          <div className="bg-white px-6 py-5">
            <div className="space-y-2">
              {displayDates.map((item, index) => (
                <div key={index} className="flex items-center justify-center gap-24 py-2 border-b border-black/5 last:border-0">
                  <div className="flex items-center gap-2">
                    {castleGift?.gift_img && (
                      <img src={fixImageUrl(castleGift.gift_img)} alt="" className="w-5 h-5 rounded" />
                    )}
                    <span className="text-base font-medium text-black/80">×{item.count}</span>
                  </div>
                  <span className="text-sm text-black/60">{item.date.replace(/-/g, ".")}</span>
                </div>
              ))}
              {totalDays > 10 && (
                <div className="text-center text-xs text-black/30 py-1">......</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="relative mx-4 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
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
            {/* 上方提示 */}
            {isMobileDevice() && (
              <span className="text-center text-white/80 text-base font-medium mb-2 block">长按图片保存到相册</span>
            )}

            <img src={generatedImage} alt="城堡统计" className="max-w-full max-h-[70vh] rounded-lg shadow-2xl" />

            {/* 下方按钮区域 */}
            <div className="flex gap-2.5 mt-3 justify-center">
              {!isMobileDevice() && (
                <button onClick={downloadImage} className="modal-action-btn modal-action-primary">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载图片
                </button>
              )}
              <button onClick={onClose} className="modal-action-btn modal-action-light">
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function HomePage() {
  const [currentAccount, setCurrentAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // 当前账号是否"本机登录"（仅本机登录账号持有 B站凭证，可更新数据）
  const [isLocalAccount, setIsLocalAccount] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshTime, setLastRefreshTime] = useState<string>("");
  const [blindBoxStats, setBlindBoxStats] = useState<BlindBoxStats | null>(null);
  const [synthesisStats, setSynthesisStats] = useState<SynthesisStats | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "blindbox" | "synthesis" | "other">("overview");
  const [otherStats, setOtherStats] = useState<OtherStats | null>(null);
  const [showStatsRules, setShowStatsRules] = useState(false);
  const [showGiftListRules, setShowGiftListRules] = useState(false);
  const [blindBoxFilters, setBlindBoxFilters] = useState<Record<number, { ruid: string; dateRange: string }>>({});
  const [certifications, setCertifications] = useState<Certification[]>([]);
  const [showCertModal, setShowCertModal] = useState(false);
  const [certModalIndex, setCertModalIndex] = useState(0);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [overviewAnchor, setOverviewAnchor] = useState<string>("");
  const [showGiftSaveModal, setShowGiftSaveModal] = useState(false);
  // 首次获取消费/收益记录时的进度提示（text: 说明文字, ratio: 0~1 可选）
  const [fetchProgress, setFetchProgress] = useState<{ text: string; ratio?: number } | null>(null);
  const [bubbleChartData, setBubbleChartData] = useState<{ items: BubbleItem[]; title: string; loading?: boolean; loadingText?: string } | null>(null);
  const [anchorFaces, setAnchorFaces] = useState<Record<number, string>>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<"revenue" | "anchor" | "screenshot" | "pending">("revenue");
  const [toolsPage, setToolsPage] = useState<"home" | "fans" | "medal" | "screenshot">("home");
  // 饼图选中状态（移动端）：记录选中的扇形(chart+index)与点击位置，只有选中时才显示提示框
  const [pieActive, setPieActive] = useState<{ chart: "all" | "period"; index: number } | null>(null);
  const [pieTipPos, setPieTipPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // 挂载标记：避免在渲染分支中直接使用 isMobileDevice() 造成 SSR/客户端不一致（Hydration 报错）。
  // 服务端与客户端首次渲染都按桌面处理，挂载后再按真实设备切换。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const pieIsMobile = mounted && isMobileDevice();

  // ===== 应用内返回栈（History API）：解决 系统返回键 不起效 =====
  // 本应用是"标签页式"SPA，模块切换只改 React 状态、不产生真实浏览器历史。
  // Tauri Android WebView 的返回键默认调用 history.back()（触发 popstate）、
  // iOS 无原生导航控制器（无左滑返回）。这里在每次切换模块/工具子页时 pushState
  // 记录一个应用内视图栈，系统返回键触发 popstate 时恢复上一个视图，栈空时回到根视图。
  const activeModuleRef = useRef(activeModule);
  const toolsPageRef = useRef(toolsPage);
  useEffect(() => { activeModuleRef.current = activeModule; }, [activeModule]);
  useEffect(() => { toolsPageRef.current = toolsPage; }, [toolsPage]);
  const navStackRef = useRef<Array<{ module: string; toolsPage: string }>>([]);

  // 导航前调用：把当前视图压栈并 pushState，使系统返回键可触发 popstate 回退
  const pushView = useCallback((nextModule: string, nextToolsPage: string) => {
    navStackRef.current.push({ module: activeModuleRef.current, toolsPage: toolsPageRef.current });
    window.history.pushState({ __inApp: true }, "");
    // 直接更新状态（不重新触发 setActiveModule 里的 push）
    setActiveModule(nextModule as any);
    setToolsPage(nextToolsPage as any);
  }, []);

  // 栈空时拦截一次并提示"再按一次退出"（防止误触直接退出）
  const exitToastTimer = useRef<number | null>(null);

  useEffect(() => {
    const onPopState = () => {
      if (navStackRef.current.length > 0) {
        const prev = navStackRef.current.pop()!;
        setActiveModule(prev.module as any);
        setToolsPage(prev.toolsPage as any);
        return;
      }
      // 栈空：已回到根视图。拦截一次并提示，2 秒内再次按返回才真正退出
      if (exitToastTimer.current !== null) {
        window.clearTimeout(exitToastTimer.current);
        exitToastTimer.current = null;
        closeApp();
        return;
      }
      showToast("再按一次退出应用");
      // 重新压入一条历史记录，使下一次系统返回键仍触发 popstate（而非浏览器直接退出），
      // 以便我们能控制"第二次返回才退出"的时机。
      window.history.pushState({ __inApp: true }, "");
      exitToastTimer.current = window.setTimeout(() => {
        exitToastTimer.current = null;
      }, 2000);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // 登录页"取消登录"返回：跳回主页后恢复"帮助"模块
  useEffect(() => {
    const ret = sessionStorage.getItem("bili_live_return");
    if (ret) {
      sessionStorage.removeItem("bili_live_return");
      if (ret === "help") {
        setActiveModule("screenshot");
        setToolsPage("home");
      }
    }
  }, []);
  type FanItem = { mid: number; uname: string; face: string; attribute: number; mtime: number };
  const [fansList, setFansList] = useState<FanItem[]>([]);
  const [fansTotal, setFansTotal] = useState(0);
  const [fansLoading, setFansLoading] = useState(false);
  const [fansPn, setFansPn] = useState(1);
  const [fansHasMore, setFansHasMore] = useState(false);
  const [fansSelectMode, setFansSelectMode] = useState(false);
  const [fansSelected, setFansSelected] = useState<Set<number>>(new Set());
  const [fansRemoving, setFansRemoving] = useState(false);
  const [fansMsg, setFansMsg] = useState("");
  // 离线功能轻提示（短时间内自动消失）
  const [offlineToast, setOfflineToast] = useState("");
  const offlineToastTimer = useRef<number | null>(null);
  function showOfflineToast(msg: string) {
    setOfflineToast(msg);
    if (offlineToastTimer.current) window.clearTimeout(offlineToastTimer.current);
    offlineToastTimer.current = window.setTimeout(() => setOfflineToast(""), 2000);
  }
  // 版本号卡片连续点击 → admin 入口（点击3次），已使用过 admin 后再其他工具页显示入口卡片
  const [versionClickCount, setVersionClickCount] = useState(0);
  const [showAdminPwd, setShowAdminPwd] = useState(false);
  const [adminPwd, setAdminPwd] = useState("");
  const [adminPwdError, setAdminPwdError] = useState(false);
  const [adminUsed, setAdminUsed] = useState(false);

  // 避免 SSR/客户端不一致：localStorage 只在客户端 useEffect 中读取，
  // 否则服务端渲染(false)与客户端首次渲染(true)不一致会触发 Hydration 报错，
  // 进而导致 React 重建组件树、iOS 上部分按钮失去响应。
  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem("bili_live_admin_used")) {
      setAdminUsed(true);
    }
  }, []);

  // 恢复上次成功的刷新时间（本地优先原则：静默后台同步完成后也会写入时间）
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("bili_live_last_refresh");
      if (saved) setLastRefreshTime(saved);
    }
  }, []);

  /** 记录刷新成功时间并持久化，供本次与下次打开显示 */
  function noteRefreshTime() {
    const t = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    setLastRefreshTime(t);
    try { localStorage.setItem("bili_live_last_refresh", t); } catch { /* ignore */ }
  }

  // 后台静默登录 admin：有已保存的密码则直接向服务器验证，无需弹窗；失败才弹窗
  function attemptAdminLogin() {
    const cred = localStorage.getItem("bili_live_admin_cred");
    if (cred) {
      const password = (() => {
        try {
          return atob(cred);
        } catch {
          return "";
        }
      })();
      fetch(serverApiUrl("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        // Tauri 下前端与服务器跨源，必须携带凭证，admin 会话 cookie 才能被持久化供 /admin 复用
        credentials: "include",
      })
        .then(async (res) => {
          if (res.ok) {
            // 静默登录成功，直接进入 admin，不显示登录框
            // 用本地路径 /admin（而非 serverApiUrl("/admin")）加载同源的 admin 页面，
            // 保证与首页共享 localStorage（跨源会导致密码/设备令牌/sid 读取失败，引发二次弹窗等连锁问题）。
            window.location.href = "/admin";
          } else {
            // 密码已变更等原因导致自动登录失败，弹出模态框重新输入
            localStorage.removeItem("bili_live_admin_cred");
            setShowAdminPwd(true);
            setAdminPwdError(true);
          }
        })
        .catch(() => {
          setShowAdminPwd(true);
          setAdminPwdError(true);
        });
    } else {
      // 首次使用，无已保存密码，弹出模态框输入
      setShowAdminPwd(true);
      setAdminPwdError(false);
    }
  }

  async function handleAdminLogin() {
    const res = await fetch(serverApiUrl("/api/admin/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPwd }),
      credentials: "include",
    });
    if (res.ok) {
      // 记住密码，下次自动静默登录
      localStorage.setItem("bili_live_admin_cred", btoa(adminPwd));
      localStorage.setItem("bili_live_admin_used", "1");
      setAdminUsed(true);
      setShowAdminPwd(false);
      setAdminPwd("");
      // 进入同源本地 /admin（与首页共享 localStorage），避免跨源导致二次登录/无法识别当前账号
      window.location.href = "/admin";
    } else {
      setAdminPwdError(true);
    }
  }

  type MedalItem = {
    medal: { uid: number; target_id: number; medal_id: number; level: number; medal_name: string; intimacy: number; next_intimacy: number; today_feed: number; day_limit: number; is_lighted: number; guard_level: number; wearing_status: number; can_delete: boolean; medal_color_start: number; medal_color_end: number; medal_color_border: number };
    anchor_info: { nick_name: string; avatar: string };
    room_info: { room_id: number; living_status: number };
    uinfo_medal?: { score: number; guard_level: number };
    superscript?: { type: number; content: string } | null;
  };
  const [medalsList, setMedalsList] = useState<MedalItem[]>([]);
  const [medalsPage, setMedalsPage] = useState(1);
  const [medalsHasMore, setMedalsHasMore] = useState(false);
  const [medalsTotal, setMedalsTotal] = useState(0);
  const [medalsLoading, setMedalsLoading] = useState(false);
  const [medalsMsg, setMedalsMsg] = useState("");
  const [medalsRemoving, setMedalsRemoving] = useState(false);
  const [medalsSelectMode, setMedalsSelectMode] = useState(false);
  const [medalsSelected, setMedalsSelected] = useState<Set<number>>(new Set());

  const [showCastleModal, setShowCastleModal] = useState(false);
  const [selectedCastleStat, setSelectedCastleStat] = useState<CastleStat | null>(null);
  const [selectedCastleGift, setSelectedCastleGift] = useState<{ gift_id: number; gift_name: string; gift_img: string; price: number } | null>(null);
  const [showHistoricalDebug, setShowHistoricalDebug] = useState(false);
  const [apiLoggedIn, setApiLoggedIn] = useState(false);
  // 后台同步中（刷新按钮显示三点动画）；首次使用无本地会话（直接扫码登录）
  const [syncing, setSyncing] = useState(false);
  const [isFirstTime, setIsFirstTime] = useState(false);
  // 在线状态（离线时使用本地缓存数据，并禁用需要联网的功能）
  const isOnline = useOnlineStatus();

  // 注入页面最大宽度 CSS 变量（layout.ts 的 PAGE_MAX_WIDTH_NUM 是单一源头）
  useEffect(() => {
    document.documentElement.style.setProperty("--page-max-width", `${PAGE_MAX_WIDTH_NUM}px`);
  }, []);

  // 本地优先：返回用户先快速显示本地缓存，再后台同步 B站；首次使用直接扫码登录
  useEffect(() => {
    initLocalFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initLocalFirst() {
    const hasSession = typeof window !== "undefined" && !!localStorage.getItem("bili_live_sid");
    if (!hasSession) {
      // 首次使用：无本地会话 → 直接跳转扫码登录页，不显示任何数据/模拟数据
      setIsFirstTime(true);
      setLoading(false);
      setApiLoggedIn(false);
      window.location.href = "/login";
      return;
    }
    // 返回用户：先快速显示本地数据（不发 B站），再后台静默同步（不阻塞界面）
    setSyncing(true);
    setLoading(false);
    try {
      await loadCachedQuick();
      await fetchData(true); // background：仅刷新按钮动画，无阻塞遮罩
    } finally {
      setSyncing(false);
    }
  }

  /** 快速加载本地缓存（不发 B站），用于本地优先的即时显示 */
  async function loadCachedQuick() {
    try {
      const [accountsRes, snapshotRes, statusRes] = await Promise.all([
        dataFetch("/api/auth/accounts", { cache: "no-store" }),
        dataFetch("/api/revenue/pay-record?fast=1", { cache: "no-store" }),
        dataFetch("/api/auth/status", { cache: "no-store" }),
      ]);
      const accountsData = await accountsRes.json();
      const snapshotData = await snapshotRes.json();
      const statusData = await statusRes.json();
      setAccounts(accountsData.data?.accounts || []);
      if (snapshotData.data) {
        setSnapshot(snapshotData.data);
        // 无本地缓存：显示首次初始化提示
        setIsFirstTime(snapshotData.message === "empty cached");
      }
      if (statusData.data?.loggedIn && statusData.data?.sid) {
        localStorage.setItem("bili_live_sid", statusData.data.sid);
        const matched = accountsData.data?.accounts?.find((a: Account) => a.sid === statusData.data.sid) || null;
        setCurrentAccount({
          sid: statusData.data.sid,
          uname: statusData.data.uname,
          mid: statusData.data.mid,
          face: statusData.data.face || matched?.face || "",
          source: matched?.source || "qr",
          updatedAt: matched?.updatedAt || "",
        });
        // 是否本机登录：accounts 仅返回本机登录账号（/api/auth/accounts 已按设备令牌过滤）
        setIsLocalAccount(!!matched);
        setApiLoggedIn(true);
      } else if (statusData.data?.expired) {
        setApiLoggedIn(false);
      }
    } catch {
      // 忽略，fetchData 会处理
    }
  }

  // 点击空白区域关闭统计规则弹窗
  const statsRulesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (statsRulesRef.current && !statsRulesRef.current.contains(e.target as Node)) {
        setShowStatsRules(false);
      }
    }
    if (showStatsRules) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showStatsRules]);

  // 点击空白区域关闭礼物清单规则弹窗
  const giftListRulesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (giftListRulesRef.current && !giftListRulesRef.current.contains(e.target as Node)) {
        setShowGiftListRules(false);
      }
    }
    if (showGiftListRules) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showGiftListRules]);

  // 窄屏自适应缩放
  useEffect(() => {
    const MIN_WIDTH = 380;
    function applyZoom() {
      const vw = window.innerWidth;
      document.documentElement.style.zoom = vw < MIN_WIDTH ? String(vw / MIN_WIDTH) : "";
    }
    applyZoom();
    window.addEventListener("resize", applyZoom);
    return () => window.removeEventListener("resize", applyZoom);
  }, []);

  // 收益模块（AnchorDataModule）的 fetchData 注册引用，供页面统一刷新时调用（收益随页面一起更新）
  const anchorRefreshRef = useRef<(() => Promise<void>) | null>(null);

  /** 刷新收尾：先让收益模块重新拉取，再统一上传本账号所有变化的数据（哈希判断，未变则跳过） */
  const finishRefresh = async () => {
    try {
      if (anchorRefreshRef.current) await anchorRefreshRef.current();
    } catch {
      // 收益拉取失败不阻塞其余流程
    }
    try {
      const platform = await getPlatform();
      await uploadAllUserData(platform);
    } catch {
      // 上传失败不影响本地展示
    }
  };

  async function fetchData(background = false) {
    // 后台同步（返回用户本地优先、或手动刷新）时不弹阻塞遮罩，仅走 syncing（刷新按钮三点动画）
    if (!background) setLoading(true);
    try {
      const [accountsRes, snapshotRes] = await Promise.all([
        dataFetch("/api/auth/accounts", { cache: "no-store" }),
        dataFetch("/api/revenue/pay-record", { cache: "no-store" }, (p) => setFetchProgress({ text: p.text, ratio: p.ratio })),
      ]);

      const accountsData = await accountsRes.json();
      const snapshotData = await snapshotRes.json();

      setAccounts(accountsData.data?.accounts || []);

      const statusRes = await dataFetch("/api/auth/status", { cache: "no-store" });
      const statusData = await statusRes.json();
      if (statusData.data?.loggedIn && statusData.data?.sid) {
        setApiLoggedIn(true);
        // 同步 localStorage，确保 admin 页据此标记当前激活用户
        localStorage.setItem("bili_live_sid", statusData.data.sid);
        // 当前账号优先用 status 返回的完整信息（即使该账号是服务器上的其他用户，也能正确显示昵称/头像）
        const matched = accountsData.data?.accounts?.find((a: Account) => a.sid === statusData.data?.sid) || null;
        setCurrentAccount({
          sid: statusData.data.sid,
          uname: statusData.data.uname,
          mid: statusData.data.mid,
          face: statusData.data.face || matched?.face || "",
          source: matched?.source || "qr",
          updatedAt: matched?.updatedAt || "",
        });
      } else if (statusData.data?.expired) {
        setApiLoggedIn(false);
        // B站凭证失效且刷新失败 → 需要重新登录
        await handleAuthExpired();
        setLoading(false);
        return;
      }

      if (snapshotData.data) {
        setSnapshot(snapshotData.data);
        // 根据 message 判断数据来源
        if (snapshotData.message === "needs-relogin") {
          await handleAuthExpired();
          setLoading(false);
          return;
        } else {
          setAuthError(null);
        }
      }

      // 有真实数据时获取统计
      if (snapshotData.data?.source === "real") {
        await Promise.all([
          fetchStats(),
          fetchCertifications(),
          fetchOtherStats(),
        ]);
        // 收益随页面一起拉取 + 统一上传本账号所有变化的数据
        await finishRefresh();
        // 后台静默同步成功也记录刷新时间（本地优先：打开即显示）
        noteRefreshTime();
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
      setFetchProgress(null);
    }
  }

  async function fetchStats(filters?: Record<number, { ruid: string; dateRange: string }>) {
    try {
      // 构建盲盒统计请求URL（按盲盒ID分别传递筛选参数：ruid_32251=xxx, dateRange_32251=thisMonth）
      let blindBoxUrl = "/api/stats/blind-box";
      if (filters) {
        const params = new URLSearchParams();
        for (const [blindBoxId, f] of Object.entries(filters)) {
          if (f.ruid) params.append(`ruid_${blindBoxId}`, f.ruid);
          if (f.dateRange && f.dateRange !== "all") params.append(`dateRange_${blindBoxId}`, f.dateRange);
        }
        const qs = params.toString();
        if (qs) blindBoxUrl += `?${qs}`;
      }

      // 筛选（主播/日期）变化时只重新拉取盲盒统计，不触发合成/其他统计的重新拉取，
      // 避免不必要的自动更新与网络请求。
      if (filters) {
        const blindBoxRes = await dataFetch(blindBoxUrl, { cache: "no-store" });
        const blindBoxData = await blindBoxRes.json();
        if (blindBoxData.message === "needs-relogin") {
          await handleAuthExpired();
          return;
        }
        if (blindBoxData.code === 0) setBlindBoxStats(blindBoxData.data);
        return;
      }

      const [blindBoxRes, synthesisRes] = await Promise.all([
        dataFetch(blindBoxUrl, { cache: "no-store" }),
        dataFetch("/api/stats/synthesis", { cache: "no-store" }),
      ]);
      const [blindBoxData, synthesisData] = await Promise.all([
        blindBoxRes.json(),
        synthesisRes.json(),
      ]);
      // 检查是否需要重新登录
      if (blindBoxData.message === "needs-relogin" || synthesisData.message === "needs-relogin") {
        await handleAuthExpired();
        return;
      }
      if (blindBoxData.code === 0) setBlindBoxStats(blindBoxData.data);
      if (synthesisData.code === 0) setSynthesisStats(synthesisData.data);
    } catch {
      // stats may not be available yet
    }
  }

  const handleAnchorFilter = useCallback((blindBoxId: number, ruid: string) => {
    const newFilters = {
      ...blindBoxFilters,
      [blindBoxId]: { ruid, dateRange: blindBoxFilters[blindBoxId]?.dateRange ?? "all" },
    };
    setBlindBoxFilters(newFilters);
    fetchStats(newFilters);
  }, [blindBoxFilters]);

  const handleDateFilter = useCallback((blindBoxId: number, dateRange: string) => {
    const newFilters = {
      ...blindBoxFilters,
      [blindBoxId]: { ruid: blindBoxFilters[blindBoxId]?.ruid ?? "", dateRange },
    };
    setBlindBoxFilters(newFilters);
    fetchStats(newFilters);
  }, [blindBoxFilters]);

  async function fetchCertifications() {
    try {
      const res = await dataFetch("/api/stats/certification", { cache: "no-store" });
      const data = await res.json();
      if (data.message === "needs-relogin") {
        await handleAuthExpired();
        return;
      }
      if (data.code === 0 && data.data) {
        setCertifications(data.data.certifications);
      }
    } catch {
      // certifications may not be available
    }
  }

  async function fetchOtherStats() {
    try {
      const res = await dataFetch("/api/stats/other", { cache: "no-store" });
      const data = await res.json();
      if (data.message === "needs-relogin") {
        await handleAuthExpired();
        return;
      }
      if (data.code === 0 && data.data) {
        setOtherStats(data.data);
      }
    } catch {
      // other stats may not be available
    }
  }

  async function openAnchorBubbleChart() {
    if (!snapshot) return;
    const anchors = overviewAnchors;
    if (anchors.length === 0) return;

    // 只取 top 300 用于显示和头像获取
    const topAnchors = anchors.slice(0, 300);

    // 立即打开模态框，显示加载状态
    // 天选礼物（显示当前登录用户名）用登录头像，其余用已缓存头像
    const isSelfAnchor = (a: { ruid: number; rname: string }) =>
      a.ruid === (currentAccount?.mid ?? -1);
    const selfFace = currentAccount?.face || "";
    const initialItems: BubbleItem[] = topAnchors.map(a => ({
      id: a.ruid,
      name: a.rname,
      value: a.coins,
      face: isSelfAnchor(a) ? selfFace : (anchorFaces[a.ruid] || ""),
    }));
    setBubbleChartData({ items: initialItems, title: "消费主播分布", loading: true, loadingText: "正在获取主播头像...\n首次加载需要等待几分钟，请耐心等待" });

    // 找出还没有头像的uid（只针对top300）
    const missingUids = topAnchors.filter(a => !anchorFaces[a.ruid]).map(a => a.ruid);
    let faces = { ...anchorFaces };

    if (missingUids.length > 0) {
      try {
        const batchSize = 50;
        let successCount = 0;
        let failCount = 0;
        // 串行处理批次，避免并发限流
        for (let i = 0; i < missingUids.length; i += batchSize) {
          const batch = missingUids.slice(i, i + batchSize);
          try {
            const res = await dataFetch(`/api/tools/user-info?uids=${batch.join(",")}`, { cache: "no-store" });
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
        }
        console.log("[AnchorBubble] 头像获取完成: 成功=" + successCount, "失败=" + failCount, "总计=" + missingUids.length);
        setAnchorFaces(faces);
      } catch (err) {
        console.error("获取主播头像失败:", err);
      }
    }

    const items: BubbleItem[] = topAnchors.map(a => ({
      id: a.ruid,
      name: a.rname,
      value: a.coins,
      face: isSelfAnchor(a) ? selfFace : (faces[a.ruid] || ""),
    }));

    setBubbleChartData({ items, title: "消费主播分布", loading: false });

    // 写入 received-anchors-list.json（主播数据页面使用）
    const anchorData: Record<string, { name: string; face: string }> = {};
    for (const a of topAnchors) {
      anchorData[a.ruid] = { name: a.rname, face: faces[a.ruid] || "" };
    }
    if (Object.keys(anchorData).length > 0) {
      dataFetch("/api/user-data/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "received-anchors-list", data: anchorData }),
      }).catch(() => {});
    }
  }

  // Stable ref-based callback for openAnchorBubbleChart to avoid React.memo re-renders
  const openAnchorBubbleChartRef = useRef(openAnchorBubbleChart);
  openAnchorBubbleChartRef.current = openAnchorBubbleChart;
  const openAnchorBubbleChartStable = useCallback(() => openAnchorBubbleChartRef.current(), []);

  async function loadFans(pn: number, append = false) {
    setFansLoading(true);
    setFansMsg("");
    try {
      const res = await dataFetch(`/api/tools/fans?pn=${pn}&ps=50`, { cache: "no-store" });
      const data = await res.json();
      if (data.code === -101) {
        setFansMsg(data.message);
        return;
      }
      if (data.code === 0 && data.data) {
        const list: FanItem[] = data.data.list;
        setFansList((prev) => (append ? [...prev, ...list] : list));
        setFansTotal(data.data.total);
        setFansPn(pn);
        setFansHasMore(list.length === 50);
      } else {
        setFansMsg(data.message || "加载失败");
      }
    } catch {
      setFansMsg("网络错误");
    } finally {
      setFansLoading(false);
    }
  }

  function toggleFanSelect(mid: number) {
    setFansSelected((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  }

  function toggleSelectAll() {
    if (fansSelected.size === fansList.length) {
      setFansSelected(new Set());
    } else {
      setFansSelected(new Set(fansList.map((f) => f.mid)));
    }
  }

  async function removeFans(fids: number[]) {
    if (fids.length === 0) return;
    setFansRemoving(true);
    setFansMsg("");
    try {
      const res = await dataFetch("/api/tools/remove-fan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fids }),
      });
      const data = await res.json();
      if (data.code === 0 && Array.isArray(data.data)) {
        const successFids = new Set<number>();
        const errors: string[] = [];
        for (const r of data.data) {
          if (r.success) {
            successFids.add(r.fid);
          } else {
            const name = fansList.find((f) => f.mid === r.fid)?.uname || String(r.fid);
            errors.push(`${name}: ${r.message}`);
          }
        }
        setFansList((prev) => prev.filter((f) => !successFids.has(f.mid)));
         setFansTotal((prev) => prev - successFids.size);
        setFansSelected(new Set());
        if (errors.length > 0) {
          setFansMsg(`已移除 ${successFids.size}/${fids.length}，失败: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? `等${errors.length}个` : ""}`);
        } else {
          setFansMsg(`已移除 ${successFids.size} 个粉丝`);
        }
      } else {
        setFansMsg(data.message || "操作失败");
      }
    } catch {
      setFansMsg("网络错误");
    } finally {
      setFansRemoving(false);
    }
  }

  async function loadMedals(page: number, append = false) {
    setMedalsLoading(true);
    setMedalsMsg("");
    try {
      const res = await dataFetch(`/api/tools/medals?page=${page}`, { cache: "no-store" });
      const data = await res.json();
      if (data.code === 0 && data.data) {
        const allItems = [...(data.data.list || []), ...(data.data.special_list || [])];
        setMedalsList(append ? (prev) => [...prev, ...allItems] : allItems);
        setMedalsPage(page);
        setMedalsHasMore(data.data.page_info?.has_more || false);
        setMedalsTotal(data.data.total_number || 0);
      } else {
        setMedalsMsg(data.message || "加载失败");
      }
    } catch {
      setMedalsMsg("网络错误");
    } finally {
      setMedalsLoading(false);
    }
  }

  async function deleteMedal(medalId: number) {
    setMedalsRemoving(true);
    setMedalsMsg("");
    try {
      const res = await dataFetch("/api/tools/delete-medal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medal_id: medalId }),
      });
      const data = await res.json();
      if (data.code === 0) {
        setMedalsList((prev) => prev.filter((m) => m.medal.medal_id !== medalId));
        setMedalsTotal((prev) => prev - 1);
      } else {
        setMedalsMsg(`删除失败: ${data.message}`);
      }
    } catch {
      setMedalsMsg("网络错误");
    } finally {
      setMedalsRemoving(false);
    }
  }

  function toggleMedalSelect(medalId: number) {
    setMedalsSelected((prev) => {
      const next = new Set(prev);
      if (next.has(medalId)) next.delete(medalId);
      else next.add(medalId);
      return next;
    });
  }

  async function removeSelectedMedals() {
    if (medalsSelected.size === 0) return;
    setMedalsRemoving(true);
    setMedalsMsg("");
    let success = 0;
    let failed = 0;
    for (const medalId of medalsSelected) {
      try {
        const res = await dataFetch("/api/tools/delete-medal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ medal_id: medalId }),
        });
        const data = await res.json();
        if (data.code === 0) {
          setMedalsList((prev) => prev.filter((m) => m.medal.medal_id !== medalId));
          setMedalsTotal((prev) => prev - 1);
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    setMedalsMsg(`已删除 ${success}/${medalsSelected.size}${failed > 0 ? `，失败 ${failed}` : ""}`);
    setMedalsSelected(new Set());
    setMedalsSelectMode(false);
    setMedalsRemoving(false);
  }

  const refreshData = useCallback(async () => {
    setSyncing(true);
    setAuthError(null);
    try {
      const snapshotRes = await dataFetch("/api/revenue/pay-record?refresh=true", { cache: "no-store" });
      const snapshotData = await snapshotRes.json();
      if (snapshotData.data) {
        setSnapshot(snapshotData.data);
        // 根据 message 判断数据来源
        if (snapshotData.message === "needs-relogin") {
          await handleAuthExpired();
          return;
        } else if (snapshotData.message === "cached snapshot") {
          setAuthError("B站请求失败，当前显示的是历史缓存数据。");
        }
      }
      if (snapshotData.data?.source === "real") {
        await Promise.all([
          fetchStats(),
          fetchCertifications(),
          fetchOtherStats(),
        ]);
        // 收益随页面一起拉取 + 统一上传本账号所有变化的数据
        await finishRefresh();
      }
    } catch (error) {
      console.error("Failed to refresh data:", error);
      setAuthError("网络请求失败，请检查网络连接后重试。");
    } finally {
      setSyncing(false);
      noteRefreshTime();
    }
  }, []);

  /**
   * 服务器账号（source=server）刷新：从自建服务器重新拉取该账号数据，覆盖本机 uid_<mid> 本地缓存。
   * 服务器账号本机无 B站 登录凭证，无法增量更新，只能整体从服务器重载。
   */
  const reloadServerData = useCallback(async () => {
    if (!currentAccount?.mid) return;
    setSyncing(true);
    setAuthError(null);
    try {
      const platform = await getPlatform();
      const res = await fetch(`${serverApiUrl("/api/server-data")}?mid=${currentAccount.mid}`, { cache: "no-store" });
      const data = await res.json();
      if (data.code !== 0) {
        setAuthError("从服务器重新加载失败: " + (data.message || "未知错误"));
        return;
      }
      const files = data.data?.files ?? {};
      const fileNames = Object.keys(files);
      if (fileNames.length === 0) {
        setAuthError("服务器暂无该账号数据，无法重新加载。");
        return;
      }
      // 覆盖本机 uid_<mid> 数据文件
      const dir = `${await platform.getDataDir()}/uid_${currentAccount.mid}`;
      await platform.mkdir(dir);
      for (const name of fileNames) {
        await platform.writeFile(`${dir}/${name}`, files[name]);
      }
      // 一并覆盖全局盲盒信息（名称/单价/爆出礼物对照表）
      if (data.data?.blindboxInfo && typeof data.data.blindboxInfo === "object") {
        const bbDir = `${await platform.getDataDir()}/blindbox_info`;
        await platform.mkdir(bbDir);
        for (const [id, info] of Object.entries(data.data.blindboxInfo as Record<string, unknown>)) {
          if (!/^\d+$/.test(id)) continue;
          await platform.writeFile(`${bbDir}/${id}.json`, JSON.stringify(info, null, 2));
        }
      }
      showToast("已从服务器重新加载数据");
      // 覆盖本地缓存后重新读取本地快照与统计
      await loadCachedQuick();
      await fetchData(true);
      noteRefreshTime();
    } catch (err) {
      console.error("reloadServerData error:", err);
      setAuthError("从服务器重新加载失败，请检查网络连接。");
    } finally {
      setSyncing(false);
    }
  }, [currentAccount, loadCachedQuick, fetchData]);

  /** 刷新入口：服务器账号从服务器重载，本机账号走 B站 增量刷新 */
  const handleRefresh = useCallback(async () => {
    if (currentAccount?.source === "server") {
      await reloadServerData();
    } else {
      await refreshData();
    }
  }, [currentAccount, reloadServerData, refreshData]);

  async function switchAccount(sid: string) {
    try {
      const res = await dataFetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid }),
      });
      const data = await res.json();
      if (data.code === 0) {
        // 同步 localStorage，确保 admin 页依据最新 sid 标记当前激活用户
        localStorage.setItem("bili_live_sid", sid);
        // 本地优先：切换到本机其他账号时先展示其本地缓存，再后台静默同步（不弹阻塞遮罩）
        setSyncing(true);
        try {
          await loadCachedQuick();
          await fetchData(true);
        } finally {
          setSyncing(false);
        }
      }
    } catch (error) {
      console.error("Failed to switch account:", error);
    }
  }

  async function logout() {
    try {
      await dataFetch("/api/auth/logout", { method: "POST" });
    } catch (error) {
      console.error("Failed to logout:", error);
    }
    // 清除本地会话并回到登录页
    localStorage.removeItem("bili_live_sid");
    setCurrentAccount(null);
    setApiLoggedIn(false);
    setSnapshot(null);
    setBlindBoxStats(null);
    setSynthesisStats(null);
    window.location.href = "/login";
  }

  /** 登录凭证失效时：清除会话并跳转登录页重新登录 */
  async function handleAuthExpired() {
    try {
      await dataFetch("/api/auth/logout", { method: "POST" });
    } catch { /* ignore */ }
    localStorage.removeItem("bili_live_sid");
    setCurrentAccount(null);
    setApiLoggedIn(false);
    setSnapshot(null);
    setBlindBoxStats(null);
    setSynthesisStats(null);
    setAuthError("B站登录已失效，请重新登录");
    window.location.href = "/login";
  }

  const isLoggedIn = Boolean(currentAccount) || apiLoggedIn;
  const isRealSnapshot = snapshot?.source === "real";

  // 礼物天选特殊处理：主播给自己发天选，昵称为空、ruid=0，归到当前登录账号
  // 实际花费需扣除未领取退还的电池（refund_price）
  const isTianxuanRecord = (r: any) => r.ruid === 0 && !r.r_uname;
  const tianxuanCoins = (r: any) => r.totalCoins - (Number(r.refund_price) || 0);
  const tianxuanUid = currentAccount?.mid ?? 0;
  // 每条记录的实际消费电池数 = totalCoins - refund_price（退款的电池不算实际花费）
  const recordActualCoins = (r: any) => r.totalCoins - (Number(r.refund_price) || 0);

  // ===== 派生数据聚合：useMemo 缓存 =====
  // 这是"iOS 卡顿/点击没反应"的系统性根因修复。
  // 此前这些聚合(按主播过滤、按月/日、按礼物 name 去重、排序等)在组件【每次渲染】都会
  // 重新对全部 records(可上万条)执行 filter/sort/reduce。而 page.tsx 是单一巨型组件，
  // 任何状态变化(点击托盘切换、粉丝/粉丝牌按钮、返回首页等无关操作)都会触发整页重渲染，
  // 全部重算一遍。安卓 WebView 用 V8(JIT 快)几乎无感，iOS 用 JavaScriptCore 明显慢，
  // 于是每次点击都卡顿数百毫秒，表现为"点了没反应"。
  // 修复：用 useMemo 缓存，仅当真正影响结果的输入变化时才重算，其余渲染直接复用缓存。
  const {
    filteredOverviewRecords, monthlyData, recentRecords, giftImgMap,
    overviewAnchors, periodAnchors, monthRecords, dayRecords, dailyData,
    maxDayCoins, calendarData, monthGiftSummary, giftTypeCount,
    consumptionCoins, consumptionCount, earnedGiftRecords, earnedGiftCount, earnedGiftTypes,
    monthGiftSummaryNew, actualDateRange, giftListSpendingTotal,
  } = useMemo(() => {
  const filteredOverviewRecords = snapshot ? (overviewAnchor
    ? snapshot.records.filter((r) => {
        if (r.status_msg === "已退回") return false;
        const uid = isTianxuanRecord(r) ? tianxuanUid : r.ruid;
        return uid === Number(overviewAnchor);
      })
    : snapshot.records.filter(r => r.status_msg !== "已退回")) : [];

  // 账户维度记录（不按主播筛选）：用于顶部统计、月度柱状图、日历图、主播饼图。
  // 这些"总数"只随日期变化，不随主播选择变化。
  const accountOverviewRecords = snapshot ? snapshot.records.filter(r => r.status_msg !== "已退回") : [];
  // 账户维度真实消费记录：排除包裹道具（合成产出、天选、红包都不是实际消费）
  const accountConsumptionRecords = accountOverviewRecords.filter(r => r.bag_desc !== "包裹道具");

  // 按月份聚合数据（跟随主播筛选；排除包裹道具，扣减退款）
  const monthlyData: MonthlyData[] = snapshot ? (() => {
    const map = new Map<string, { coins: number; count: number }>();
    for (const r of filteredOverviewRecords) {
      if (r.bag_desc === "包裹道具") continue;
      const d = new Date(r.timestamp * 1000);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const existing = map.get(key) || { coins: 0, count: 0 };
      existing.coins += recordActualCoins(r);
      existing.count += 1;
      map.set(key, existing);
    }
    return Array.from(map.entries())
      .map(([month, v]) => ({ month, coins: v.coins, count: v.count }))
      .sort((a, b) => a.month.localeCompare(b.month));
  })() : [];

  // 最近1条记录（用于验证数据是否最新）
  const recentRecords = snapshot ? [...snapshot.records]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 1) : [];

  // 礼物图标映射表（从records直接构建，覆盖所有gift_id）
  const giftImgMap = new Map<string, string>();
  if (snapshot) {
    for (const r of snapshot.records) {
      const key = `${r.gift_id}_${r.gift_name}`;
      if (r.gift_img && !giftImgMap.has(key)) {
        giftImgMap.set(key, fixImageUrl(r.gift_img));
      }
    }
  }

  // 主播列表（按电池数降序）
  const overviewAnchors: Array<{ ruid: number; rname: string; coins: number }> = snapshot ? (() => {
    // 礼物天选：昵称为空、ruid=0，归到当前登录账号，显示登录用户名，花费扣除退还。
    // 以 Map<ruid> 做 UID 整合：天选与本账号其他"给自己消费"（ruid===当前uid）自动合并到同一项，
    // 不会把天选单独当作该账号的全部消费。
    const map = new Map<number, { rname: string; coins: number }>();
    for (const r of accountConsumptionRecords) {
      const isTianxuan = isTianxuanRecord(r);
      const ruid = isTianxuan ? tianxuanUid : r.ruid;
      const existing = map.get(ruid) ?? { rname: isTianxuan ? (currentAccount?.uname || "自己") : r.r_uname, coins: 0 };
      existing.coins += recordActualCoins(r);
      map.set(ruid, existing);
    }
    return Array.from(map.entries())
      .map(([ruid, v]) => ({ ruid, rname: v.rname, coins: v.coins }))
      .sort((a, b) => b.coins - a.coins);
  })() : [];

  // 按选定日期范围计算的主播分布（不受 anchor 筛选影响，用于右侧饼图+下拉）
  const periodAnchors: Array<{ ruid: number; rname: string; coins: number }> = snapshot ? (() => {
    let records = accountConsumptionRecords;
    if (selectedMonth) {
      records = records.filter((r) => {
        const d = new Date(r.timestamp * 1000);
        const m = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        return m === selectedMonth;
      });
    }
    if (selectedDay !== null) {
      records = records.filter((r) => {
        const d = new Date(r.timestamp * 1000);
        return d.getDate() === selectedDay;
      });
    }
    // 礼物天选：归到当前登录账号，显示登录用户名，花费扣除退还
    const map = new Map<number, { rname: string; coins: number }>();
    for (const r of records) {
      const isTianxuan = isTianxuanRecord(r);
      const ruid = isTianxuan ? tianxuanUid : r.ruid;
      const existing = map.get(ruid) ?? { rname: isTianxuan ? (currentAccount?.uname || "自己") : r.r_uname, coins: 0 };
      existing.coins += recordActualCoins(r);
      map.set(ruid, existing);
    }
    return Array.from(map.entries())
      .map(([ruid, v]) => ({ ruid, rname: v.rname, coins: v.coins }))
      .sort((a, b) => b.coins - a.coins);
  })() : [];

  // 当月记录（按 selectedMonth 筛选）
  const monthRecords = selectedMonth && snapshot
    ? filteredOverviewRecords.filter((r) => {
        const d = new Date(r.timestamp * 1000);
        const m = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
        return m === selectedMonth;
      })
    : [];

  // 当日记录（按 selectedDay 筛选，按主播筛选，用于礼物清单）
  const dayRecords = selectedDay !== null
    ? monthRecords.filter((r) => {
        const d = new Date(r.timestamp * 1000);
        return d.getDate() === selectedDay;
      })
    : [];

  // 每日聚合数据（用于日历；跟随主播筛选，排除包裹道具，扣减退款）
  const dailyData: Map<number, number> = (() => {
    const map = new Map<number, number>();
    for (const r of monthRecords) {
      if (r.bag_desc === "包裹道具") continue;
      const d = new Date(r.timestamp * 1000);
      const day = d.getDate();
      map.set(day, (map.get(day) ?? 0) + recordActualCoins(r));
    }
    return map;
  })();

  // 当月最大日消费（用于颜色强度）
  const maxDayCoins = dailyData.size > 0 ? Math.max(...dailyData.values()) : 1;

  // 日历数据
  const calendarData = selectedMonth ? (() => {
    const year = parseInt(selectedMonth.slice(0, 4));
    const month = parseInt(selectedMonth.slice(4, 6)) - 1;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDayOfWeek = firstDay.getDay(); // 0=Sun
    const daysInMonth = lastDay.getDate();
    // 调整为周一为起始
    const startOffset = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;
    const weeks: Array<Array<{ day: number | null; coins: number }>> = [];
    let currentWeek: Array<{ day: number | null; coins: number }> = [];
    for (let i = 0; i < startOffset; i++) {
      currentWeek.push({ day: null, coins: 0 });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      currentWeek.push({ day: d, coins: dailyData.get(d) ?? 0 });
      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ day: null, coins: 0 });
      }
      weeks.push(currentWeek);
    }
    return { year, month: month + 1, weeks };
  })() : null;

  // 礼物清单汇总（按gift_name聚合，解决同名不同gift_id的重复问题）
  const monthGiftSummary = (() => {
    // 没有选中月份时显示全部记录，选中月份但没选日期时显示当月，选中日期时显示当天
    const rawRecords = dayRecords.length > 0 ? dayRecords : (selectedMonth ? monthRecords : filteredOverviewRecords);
    // 过滤合成材料（gift_id=1不是最终送出礼物）
    const summaryRecords = rawRecords.filter(r => r.gift_id !== 1);
    const map = new Map<string, { gift_id: number; gift_name: string; gift_img: string; count: number; coins: number }>();
    for (const r of summaryRecords) {
      const key = r.gift_name;
      const existing = map.get(key) ?? {
        gift_id: r.gift_id,
        gift_name: r.gift_name,
        gift_img: giftImgMap.get(`${r.gift_id}_${r.gift_name}`) ?? fixImageUrl(r.gift_img) ?? "",
        count: 0,
        coins: 0,
      };
      existing.count += r.gift_num;
      existing.coins += r.totalCoins;
      // 优先使用有图标的gift_id
      if (!existing.gift_img && r.gift_img) {
        existing.gift_img = fixImageUrl(r.gift_img);
        existing.gift_id = r.gift_id;
      }
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.coins - a.coins);
  })();

  // Compute unique gift types (by gift_id + gift_name to handle same gift_id with different names)
  const giftTypeCount = snapshot ? new Set(snapshot.records.map(r => `${r.gift_id}_${r.gift_name}`)).size : 0;

  // 消费电池数（账户汇总，不随主播筛选变化）：所有消费记录 - 包裹道具，每条记录扣减退款
  const consumptionCoins = accountConsumptionRecords.reduce((sum, r) => sum + recordActualCoins(r), 0);
  // 消费次数（账户汇总）：真实消费记录条数（排除包裹道具）
  const consumptionCount = accountConsumptionRecords.length;

  // 赚取礼物统计（包裹道具，排除合成消费gift_id=1）
  const earnedGiftRecords = filteredOverviewRecords.filter(r => r.bag_desc === "包裹道具" && r.gift_id !== 1);
  const earnedGiftCount = earnedGiftRecords.reduce((sum, r) => sum + r.gift_num, 0);
  const earnedGiftTypes = new Set(earnedGiftRecords.map(r => r.gift_name)).size;

  // 礼物清单汇总
  // 显示逻辑：列出所有实际送出的礼物（含包裹道具），排除合成材料
  // 合成材料判断：gift_id=1 且不在天选礼物/红包礼物列表，且 gift_name 不是"礼物天选"
  // displayCoins：用于清单展示的礼物价值（包裹道具=礼物本身价值，其他=实际花费）
  // coins：用于标题栏动态花费汇总的实际消费（包裹道具=0，其他=实际花费）
  // 验证：全部时间全部主播时，coins 汇总 = 顶部"消费电池"总数
  const rawRecords = dayRecords.length > 0 ? dayRecords : (selectedMonth ? monthRecords : filteredOverviewRecords);
  // 标题栏动态花费汇总（全部实际消费，不含包裹道具，不受清单显示过滤影响）
  const giftListSpendingTotal = rawRecords
    .filter(r => r.bag_desc !== "包裹道具")
    .reduce((sum, r) => sum + recordActualCoins(r), 0);
  const monthGiftSummaryNew = (() => {
    // 合成材料排除：gift_id=1 且不在天选/红包列表，且不是"礼物天选"
    const tianxuanGiftIds = new Set((synthesisStats?.tianxuanGifts ?? []).map(g => g.id));
    const redPocketGiftIds = new Set((synthesisStats?.redPocketGifts ?? []).map(g => g.id));
    const map = new Map<string, { uid: string; gift_id: number; gift_name: string; gift_img: string; count: number; coins: number; displayCoins: number }>();
    for (const r of rawRecords) {
      // 排除合成材料：gift_id=1 且不在天选/红包列表，且不是"礼物天选"
      if (r.gift_id === 1 && r.gift_name !== "礼物天选" && !tianxuanGiftIds.has(r.gift_id) && !redPocketGiftIds.has(r.gift_id)) continue;
      const isTx = isTianxuanRecord(r);
      // 天选礼物按图片链接分组（同一链接=同一类），正常礼物按名称分组
      const key = isTx ? `tx_${r.gift_img}` : r.gift_name;
      const existing = map.get(key) ?? {
        uid: key,
        gift_id: r.gift_id,
        gift_name: r.gift_name,
        gift_img: isTx ? (fixImageUrl(r.gift_img) ?? "") : (giftImgMap.get(`${r.gift_id}_${r.gift_name}`) ?? fixImageUrl(r.gift_img) ?? ""),
        count: 0,
        coins: 0,
        displayCoins: 0,
      };
      existing.count += r.gift_num;
      // coins：实际花费（包裹道具=0，因为不是消费；自发天选是真实消费，正常计费）
      existing.coins += (r.bag_desc === "包裹道具") ? 0 : recordActualCoins(r);
      // displayCoins：清单展示用（包裹道具=礼物本身价值，其他=实际花费）
      existing.displayCoins += (r.bag_desc === "包裹道具") ? r.totalCoins : recordActualCoins(r);
      if (!existing.gift_img && r.gift_img) {
        existing.gift_img = fixImageUrl(r.gift_img);
        existing.gift_id = r.gift_id;
      }
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.displayCoins - a.displayCoins);
  })();

  // 实际日期范围（从第一条到最后一条礼物记录）
  const actualDateRange = filteredOverviewRecords.length > 0 ? (() => {
    const sorted = [...filteredOverviewRecords].sort((a, b) => a.timestamp - b.timestamp);
    return { start: formatDateShort(formatTimestamp(sorted[0].timestamp)), end: formatDateShort(formatTimestamp(sorted[sorted.length - 1].timestamp)) };
  })() : null;

    return {
      filteredOverviewRecords, monthlyData, recentRecords, giftImgMap,
      overviewAnchors, periodAnchors, monthRecords, dayRecords, dailyData,
      maxDayCoins, calendarData, monthGiftSummary, giftTypeCount,
      consumptionCoins, consumptionCount, earnedGiftRecords, earnedGiftCount, earnedGiftTypes,
      monthGiftSummaryNew, actualDateRange, giftListSpendingTotal,
    };
  }, [snapshot, overviewAnchor, selectedMonth, selectedDay, currentAccount, synthesisStats]);

  // 底部托盘导航：切换页面
  function handleDockChange(tab: DockTabKey) {
    if (tab === "fans") { pushView("revenue", "home"); }
    else if (tab === "anchor") { pushView("anchor", "home"); }
    else if (tab === "help") { pushView("screenshot", "home"); }
    else { pushView("pending", "home"); }
  }
  // 当前托盘高亮项
  const dockTab: DockTabKey = activeModule === "revenue" ? "fans"
    : activeModule === "anchor" ? "anchor"
    : activeModule === "screenshot" ? "help"
    : "pending";

  return (
    <main className="page-main flex flex-col min-h-0 bg-[#f5f5f5] text-[#1f1c17]">
      {/* Content Area - scrollable, 底部为悬浮托盘栏留出空间 */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden relative pb-24 page-scroll-area" style={{ overscrollBehavior: "none" }}>

      {/* Offline banner */}
      {!isOnline && (
        <div className="content-wrapper px-2 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-gray-100 border border-black/10 px-3 py-2">
            <span className="text-base">📴</span>
            <div className="flex-1">
              <p className="text-sm font-medium text-black/70">离线模式</p>
              <p className="text-xs text-black/45">当前无网络连接，正在使用本地缓存数据（收入、盲盒、合成、礼物等）。需要联网的功能（粉丝清理、粉丝牌清理、扫码登录等）暂不可用。</p>
            </div>
          </div>
        </div>
      )}

      {/* Auth error banner */}
      {authError && (
        <div className="content-wrapper px-2 py-2 bg-amber-50 rounded-lg">
          <p className="text-sm text-amber-800">{authError}</p>
        </div>
      )}

      {/* 首次初始化提示：无本地数据、正在后台拉取时全屏提示 */}
      {isFirstTime && syncing && createPortal(
        <div className="fixed inset-0 z-[9999] bg-[#f5f5f5]/95 backdrop-blur flex items-center justify-center px-6">
          <div className="text-center max-w-xs w-full">
            <div className="w-10 h-10 border-[3px] border-[#1f1c17] border-t-transparent rounded-full animate-spin mx-auto mb-6"></div>
            <p className="text-base font-semibold text-[#1f1c17] mb-3">获取数据中...</p>
            <p className="text-sm leading-6 text-black/55">首次登录，初始化耗时较长，请耐心等待。</p>
            <p className="text-sm leading-6 text-black/55 mt-1">每个账号只初始化一次，以后使用会变快。</p>
            {fetchProgress && (
              <div className="mt-5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
                  <div
                    className={`h-full rounded-full bg-[#1f1c17] transition-all duration-300 ${fetchProgress.ratio === undefined ? "w-1/3 progress-indeterminate" : ""}`}
                    style={fetchProgress.ratio !== undefined ? { width: `${Math.max(4, Math.round(fetchProgress.ratio * 100))}%` } : undefined}
                  ></div>
                </div>
                <p className="mt-2 text-xs text-black/55">{fetchProgress.text}</p>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}

      {/* Revenue module - 保持挂载，切换模块时仅切换 display，避免重新绘制图表/卡顿 */}
      <div className="min-h-full flex flex-col" style={{ display: activeModule === "revenue" ? "flex" : "none" }}>
        <RevenueModuleContent
          snapshot={snapshot}
          activeTab={activeTab}
          syncing={syncing}
          loading={loading}
          isLocalAccount={isLocalAccount}
          lastRefreshTime={lastRefreshTime}
          consumptionCoins={consumptionCoins}
          consumptionCount={consumptionCount}
          giftTypeCount={giftTypeCount}
          overviewAnchors={overviewAnchors}
          recentRecords={recentRecords}
          isRealSnapshot={isRealSnapshot}
          monthlyData={monthlyData}
          selectedMonth={selectedMonth}
          selectedDay={selectedDay}
          calendarData={calendarData}
          maxDayCoins={maxDayCoins}
          periodAnchors={periodAnchors}
          overviewAnchor={overviewAnchor}
          pieActive={pieActive}
          pieIsMobile={pieIsMobile}
          pieTipPos={pieTipPos}
          monthGiftSummaryNew={monthGiftSummaryNew}
          giftListSpendingTotal={giftListSpendingTotal}
          actualDateRange={actualDateRange}
          showGiftSaveModal={showGiftSaveModal}
          blindBoxStats={blindBoxStats}
          blindBoxFilters={blindBoxFilters}
          certifications={certifications}
          showCertModal={showCertModal}
          certModalIndex={certModalIndex}
          selectedCastleStat={selectedCastleStat}
          selectedCastleGift={selectedCastleGift}
          showCastleModal={showCastleModal}
          synthesisStats={synthesisStats}
          showHistoricalDebug={showHistoricalDebug}
          otherStats={otherStats}
          showStatsRules={showStatsRules}
          showGiftListRules={showGiftListRules}
          currentAccount={currentAccount}
          statsRulesRef={statsRulesRef}
          giftListRulesRef={giftListRulesRef}
          setActiveTab={setActiveTab}
          refreshData={handleRefresh}
          isServerAccount={currentAccount?.source === "server"}
          setSelectedMonth={setSelectedMonth}
          setSelectedDay={setSelectedDay}
          setOverviewAnchor={setOverviewAnchor}
          setPieActive={setPieActive}
          setPieTipPos={setPieTipPos}
          setShowStatsRules={setShowStatsRules}
          setShowGiftListRules={setShowGiftListRules}
          setShowGiftSaveModal={setShowGiftSaveModal}
          setShowCertModal={setShowCertModal}
          setCertModalIndex={setCertModalIndex}
          setSelectedCastleStat={setSelectedCastleStat}
          setSelectedCastleGift={setSelectedCastleGift}
          setShowCastleModal={setShowCastleModal}
          setShowHistoricalDebug={setShowHistoricalDebug}
          handleDateFilter={handleDateFilter}
          handleAnchorFilter={handleAnchorFilter}
          openAnchorBubbleChart={openAnchorBubbleChartStable}
          showToast={showToast}
          downloadJsonFile={downloadJsonFile}
          formatTimestamp={formatTimestamp}
          formatDateShort={formatDateShort}
          monthLabel={monthLabel}
          formatCoinsShort={formatCoinsShort}
          fixImageUrl={fixImageUrl}
          formatProfit={formatProfit}
        />
      </div>

      {/* 主播数据 - 保持挂载避免切换闪烁 */}
      <div style={{ display: activeModule === "anchor" ? "block" : "none" }}>
        <AnchorDataModule
          key={currentAccount?.sid ?? "no-account"}
          anchorName={currentAccount?.uname ?? ""}
          anchorFace={fixImageUrl(currentAccount?.face ?? "")}
          mid={currentAccount?.mid ?? 0}
          uname={currentAccount?.uname ?? ""}
          isServerAccount={currentAccount?.source === "server"}
          onFetchRequest={anchorRefreshRef}
        />
      </div>

      {/* B站小工具 - 保持挂载，仅切换 display */}
      <div style={{ display: activeModule === "screenshot" ? "block" : "none" }}>
        <div className="content-wrapper px-2 min-w-0 py-3">
          {toolsPage === "home" && (
              <>
              <div className="grid grid-cols-1 gap-3">
                {[
                  { icon: "🧹", title: "粉丝清理", desc: "管理粉丝列表，一键清理非互关粉丝或批量移除指定粉丝", offlineOnly: true },
                  { icon: "🏅", title: "粉丝牌清理", desc: "管理粉丝勋章，批量清理粉丝牌，不用读秒等待", offlineOnly: true },
                  { icon: "📸", title: "复活曲截图", desc: "复活曲倒计时投屏 + 自动截图，直播多人局必备工具", offlineOnly: false },
                ].map((tool) => {
                  // 仅离线模式禁用需要联网的工具（粉丝清理/粉丝牌清理）
                  const disabled = !isOnline && tool.offlineOnly;
                  return (
                  <button
                    key={tool.title}
                    onClick={() => {
                      if (disabled) {
                        showOfflineToast("当前处于离线模式，无法使用此项功能");
                        return;
                      }
                      if (tool.title === "粉丝清理") { pushView("screenshot", "fans"); loadFans(1); }
                      else if (tool.title === "粉丝牌清理") { pushView("screenshot", "medal"); loadMedals(1); }
                      else { pushView("screenshot", "screenshot"); }
                    }}
                    className={`rounded-xl border p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-left transition ${
                      disabled
                        ? "border-black/5 bg-gray-100/70 cursor-not-allowed opacity-60"
                        : "border-black/10 bg-white/80 hover:border-black/20 hover:shadow-lg"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`text-3xl ${disabled ? "grayscale opacity-50" : ""}`}>{tool.icon}</span>
                      <div>
                        <h3 className="text-base font-bold">{tool.title}</h3>
                        <p className="mt-0.5 text-xs text-black/45">{tool.desc}</p>
                      </div>
                      {disabled ? (
                        <svg className="w-4 h-4 text-black/30 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 10a6 6 0 00-12 0" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 10v6a2 2 0 002 2h8a2 2 0 002-2v-6" /></svg>
                      ) : (
                        <svg className="w-4 h-4 text-black/30 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      )}
                    </div>
                  </button>
                  );
                })}
                {/* 已使用过 admin 后，显示管理后台入口卡片 */}
                {adminUsed && (
                  <button
                    onClick={attemptAdminLogin}
                    className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-left transition hover:border-black/20 hover:shadow-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">🛠️</span>
                      <div>
                        <h3 className="text-base font-bold">管理后台</h3>
                        <p className="mt-0.5 text-xs text-black/45">查看用户、配置盲盒与合成活动</p>
                      </div>
                      <svg className="w-4 h-4 text-black/30 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </div>
                  </button>
                )}
              </div>

              {/* 用户卡片：显示当前账号头像+昵称，可切换本机账号（置于页面下方） */}
              <div className="rounded-xl border border-black/10 bg-white/85 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur mt-3">
                {isLoggedIn ? (
                  <>
                    <div className="flex items-center gap-3 mb-3">
                      {currentAccount?.face ? (
                        <img src={fixImageUrl(currentAccount.face)} alt="" className="w-12 h-12 rounded-full object-cover" />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center text-lg text-black/40">{currentAccount?.uname?.slice(0, 1) || "?"}</div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{currentAccount?.uname || currentAccount?.mid || "未命名账号"}</div>
                        <div className="text-xs text-black/40">点击下方账号即可切换</div>
                      </div>
                      {currentAccount?.mid && (
                        <span className="ml-auto text-[10px] text-black/30">UID {currentAccount.mid}</span>
                      )}
                    </div>
                    {/* 账号列表：只显示本机登录的账号（当前账号已显示在最上方，不再重复列出） */}
                    <div className="space-y-1.5">
                      {accounts
                        .filter((acc) => acc.sid !== currentAccount?.sid)
                        .map((acc) => {
                        const isSelected = acc.sid === currentAccount?.sid;
                        return (
                          <button
                            key={acc.sid}
                            onClick={() => switchAccount(acc.sid)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left text-sm transition ${
                              isSelected ? "bg-[#1f1c17] text-white" : "hover:bg-black/5 text-black"
                            }`}
                          >
                            {acc.face ? (
                              <img src={fixImageUrl(acc.face)} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <span className="w-7 h-7 rounded-full bg-black/5 flex items-center justify-center text-xs flex-shrink-0">{acc.uname.slice(0, 1)}</span>
                            )}
                            <span className="truncate flex-1">{acc.uname}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex gap-2 mt-3">
                      <Link href="/login" className="flex-1 rounded-lg border border-black/10 py-2 text-center text-sm text-black/70 hover:bg-black/5 transition">
                        添加新账号
                      </Link>
                      <button onClick={logout} className="flex-1 rounded-lg border border-red-200 py-2 text-center text-sm text-red-600 hover:bg-red-50 transition">
                        退出登录
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center text-lg text-black/40">?</div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">未登录</div>
                      <div className="text-xs text-black/40">扫码登录后可查看你的数据</div>
                    </div>
                    <Link href="/login" className="flex-shrink-0 rounded-full bg-[#1f1c17] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90">
                      扫码登录
                    </Link>
                  </div>
                )}
              </div>
              </>
            )}

            {/* 版本号卡片 - 连续点击3次进入管理员页面 */}
            {toolsPage === "home" && (
              <div className="mt-3 flex justify-center">
                <button
                  onClick={() => {
                    const next = versionClickCount + 1;
                    setVersionClickCount(next);
                    if (next >= 3) {
                      setVersionClickCount(0);
                      // 三连击仅显示"管理后台"卡片，不再直接进入 admin。
                      // 点击"管理后台"卡片才触发登录流程（首次弹密码框/非首次后台静默登录）。
                      localStorage.setItem("bili_live_admin_used", "1");
                      setAdminUsed(true);
                    }
                  }}
                  className="text-xs text-black/20 hover:text-black/40 transition cursor-default select-none"
                  title="v0.1.0"
                >
                  v0.1.0
                </button>
              </div>
            )}

            {/* Admin 密码弹窗 */}
            {showAdminPwd && createPortal(
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => { setShowAdminPwd(false); setAdminPwd(""); setAdminPwdError(false); }}>
                <div className="rounded-xl border border-black/10 bg-white p-6 shadow-xl w-72" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-sm font-semibold text-center mb-4">管理员验证</h3>
                  <input
                    type="password"
                    placeholder="请输入密码"
                    value={adminPwd}
                    onChange={(e) => { setAdminPwd(e.target.value); setAdminPwdError(false); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleAdminLogin();
                      }
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none ${adminPwdError ? "border-[#e74c3c]" : "border-black/10 focus:border-black/30"}`}
                    autoFocus
                  />
                  {adminPwdError && <p className="text-xs text-[#e74c3c] mt-1">密码错误</p>}
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={handleAdminLogin}
                      className="flex-1 rounded-lg bg-[#1f1c17] py-2 text-sm text-white font-medium hover:opacity-90 transition"
                    >
                      确认
                    </button>
                    <button
                      onClick={() => { setShowAdminPwd(false); setAdminPwd(""); setAdminPwdError(false); }}
                      className="flex-1 rounded-lg border border-black/10 py-2 text-sm text-black/60 hover:bg-gray-50 transition"
                    >
                      取消
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            {/* 粉丝清理 */}
            {activeModule === "screenshot" && toolsPage === "fans" && (
              <div className="space-y-3">
                {/* 返回 + 操作栏 */}
                <div className="flex items-center gap-4 py-1">
                  <button onClick={() => { pushView("screenshot", "home"); setFansList([]); setFansSelectMode(false); setFansSelected(new Set()); setFansMsg(""); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    返回
                  </button>
                  <span className="text-sm font-semibold">粉丝清理</span>
                  {fansTotal > 0 && <span className="text-xs text-black/40">共 {fansTotal} 个粉丝</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {fansMsg && <span className="text-xs text-[#e74c3c]">{fansMsg}</span>}
                    <button onClick={() => { loadFans(1); setFansSelectMode(false); setFansSelected(new Set()); setFansMsg(""); }} disabled={fansLoading} className="shrink-0 rounded-full border border-black/15 px-3 py-1 text-xs text-black/60 hover:bg-gray-50 transition disabled:opacity-50">
                      <svg className={`w-3.5 h-3.5 inline-block mr-0.5 ${fansLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      {fansLoading ? "刷新中..." : "刷新"}
                    </button>
                  </div>
                </div>

                {/* 操作按钮 */}
                {fansList.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => removeFans(fansList.map((f) => f.mid))}
                      disabled={fansRemoving}
                      className="rounded-lg bg-[#e74c3c] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
                    >
                      一键清理全部
                    </button>
                    <button
                      onClick={() => removeFans(fansList.filter((f) => (f.attribute & 0x02) === 0).map((f) => f.mid))}
                      disabled={fansRemoving}
                      className="rounded-lg bg-[#e67e22] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
                    >
                      一键清理非互关
                    </button>
                    <button
                      onClick={() => { setFansSelectMode(!fansSelectMode); setFansSelected(new Set()); }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${fansSelectMode ? "bg-black/10 text-black/60" : "bg-black/5 text-black/50 hover:bg-black/10"}`}
                    >
                      {fansSelectMode ? "取消选择" : "选择"}
                    </button>
                    {fansSelectMode && (
                      <>
                        <button onClick={toggleSelectAll} className="rounded-lg bg-black/5 px-3 py-1.5 text-xs text-black/50 font-medium hover:bg-black/10 transition">
                          {fansSelected.size === fansList.length ? "取消全选" : "全选"}
                        </button>
                        <button
                          onClick={() => removeFans(Array.from(fansSelected))}
                          disabled={fansRemoving || fansSelected.size === 0}
                          className="rounded-lg bg-[#e74c3c] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
                        >
                          移除 {fansSelected.size > 0 ? `(${fansSelected.size})` : ""}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* 粉丝列表 */}
                {fansLoading && fansList.length === 0 ? (
                  <div className="rounded-xl border border-black/10 bg-white/80 p-8 text-center text-sm text-black/35">加载中...</div>
                ) : fansList.length > 0 ? (
                  <div className="space-y-1.5">
                    {fansList.map((fan) => {
                      const isMutual = (fan.attribute & 0x06) >= 2; // attribute 2=已关注 6=互粉
                      const isDeactivated = fan.uname === "账号已注销";
                      const isSelected = fansSelected.has(fan.mid);
                      return (
                        <div
                          key={fan.mid}
                          onClick={() => fansSelectMode && toggleFanSelect(fan.mid)}
                          className={`flex items-center gap-3 rounded-lg border p-2.5 transition ${fansSelectMode ? "cursor-pointer" : ""} ${isSelected ? "border-[#e74c3c] bg-red-50" : isDeactivated ? "border-black/10 bg-black/5" : "border-black/10 bg-white"}`}
                        >
                          {fansSelectMode && (
                            <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${isSelected ? "bg-[#e74c3c] border-[#e74c3c]" : "border-black/20"}`}>
                              {isSelected && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                            </div>
                          )}
                          <img src={fixImageUrl(fan.face)} alt="" className={`w-9 h-9 rounded-full flex-shrink-0 ${isDeactivated ? "opacity-40 grayscale" : ""}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-sm font-medium truncate ${isDeactivated ? "text-black/30" : ""}`}>{fan.uname}</span>
                              {isDeactivated && <span className="text-[10px] text-black/30 bg-black/10 px-1 rounded">已注销</span>}
                              {isMutual && !isDeactivated && <span className="text-[10px] text-[#00a1d6] bg-[#00a1d6]/10 px-1 rounded">互关</span>}
                            </div>
                            <div className="text-[10px] text-black/35">关注于 {new Date(fan.mtime * 1000).toLocaleDateString("zh-CN")}</div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); removeFans([fan.mid]); }}
                            disabled={fansRemoving}
                            className="ml-auto flex-shrink-0 rounded-md border border-[#e74c3c]/30 bg-[#e74c3c]/5 px-2 py-1 text-[10px] text-[#e74c3c] font-medium hover:bg-[#e74c3c]/10 transition disabled:opacity-50"
                          >
                            移除
                          </button>
                        </div>
                      );
                    })}
                    {fansHasMore && (
                      <button
                        onClick={() => loadFans(fansPn + 1, true)}
                        disabled={fansLoading}
                        className="w-full rounded-lg border border-black/10 bg-white py-2 text-xs text-black/50 hover:bg-black/5 transition disabled:opacity-50"
                      >
                        {fansLoading ? "加载中..." : "加载更多"}
                      </button>
                    )}
                  </div>
                ) : (
                  !fansMsg && <div className="rounded-xl border border-black/10 bg-white/80 p-8 text-center text-sm text-black/35">点击上方按钮加载粉丝列表</div>
                )}
              </div>
            )}

            {/* 粉丝牌清理 */}
            {activeModule === "screenshot" && toolsPage === "medal" && (
              <div className="space-y-3">
                {/* 返回 + 操作栏 */}
                <div className="flex items-center gap-4 py-1">
                  <button onClick={() => { pushView("screenshot", "home"); setMedalsList([]); setMedalsMsg(""); setMedalsSelectMode(false); setMedalsSelected(new Set()); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    返回
                  </button>
                  <span className="text-sm font-semibold">粉丝牌清理</span>
                  {medalsTotal > 0 && <span className="text-xs text-black/40">共 {medalsTotal} 个粉丝牌</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {medalsMsg && <span className="text-xs text-[#e74c3c]">{medalsMsg}</span>}
                    <button onClick={() => loadMedals(1)} disabled={medalsLoading} className="shrink-0 rounded-full border border-black/15 px-3 py-1 text-xs text-black/60 hover:bg-gray-50 transition disabled:opacity-50">
                      <svg className={`w-3.5 h-3.5 inline-block mr-0.5 ${medalsLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      {medalsLoading ? "刷新中..." : "刷新"}
                    </button>
                  </div>
                </div>

                {/* 操作按钮 */}
                {medalsList.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => { const deletable = medalsList.filter((i) => i.medal.can_delete); setMedalsSelected(new Set(deletable.map((i) => i.medal.medal_id))); removeSelectedMedals(); }} disabled={medalsRemoving} className="rounded-lg bg-[#e74c3c] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50">
                      一键清理非舰粉丝牌
                    </button>
                    {medalsSelectMode ? (
                      <>
                        <button onClick={() => { setMedalsSelectMode(false); setMedalsSelected(new Set()); }} className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-xs text-black/70 hover:bg-gray-50 transition">取消</button>
                        {medalsSelected.size === medalsList.filter((i) => i.medal.can_delete).length ? (
                          <button onClick={() => setMedalsSelected(new Set())} className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-xs text-black/70 hover:bg-gray-50 transition">取消全选可删除</button>
                        ) : (
                          <button onClick={() => setMedalsSelected(new Set(medalsList.filter((i) => i.medal.can_delete).map((i) => i.medal.medal_id)))} className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-xs text-black/70 hover:bg-gray-50 transition">全选可删除</button>
                        )}
                        <button onClick={removeSelectedMedals} disabled={medalsSelected.size === 0 || medalsRemoving} className="rounded-lg bg-[#e74c3c] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50">
                          {medalsRemoving ? "处理中..." : `移除选中 (${medalsSelected.size})`}
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setMedalsSelectMode(true)} className="rounded-lg border border-black/15 bg-white px-3 py-1.5 text-xs text-black/70 hover:bg-gray-50 transition">选择</button>
                    )}
                  </div>
                )}

                {/* 粉丝牌列表 */}
                {medalsList.length > 0 ? (
                  <div className="space-y-2">
                    {medalsList.map((item) => {
                      const m = item.medal;
                      const guardLabel = m.guard_level === 1 ? "总督" : m.guard_level === 2 ? "提督" : m.guard_level === 3 ? "舰长" : null;
                      const isWearing = m.wearing_status === 1;
                      const isSelected = medalsSelected.has(m.medal_id);
                      const isInShip = !m.can_delete;
                      return (
                        <div
                          key={m.medal_id}
                          onClick={() => medalsSelectMode && m.can_delete && toggleMedalSelect(m.medal_id)}
                          className={`flex items-center gap-3 rounded-lg border p-3 transition ${isInShip ? "opacity-50 bg-black/5" : ""} ${medalsSelectMode && m.can_delete ? "cursor-pointer" : ""} ${isSelected ? "border-[#e74c3c] bg-red-50" : isWearing && !isInShip ? "border-[#00a1d6]/30 bg-[#eef3fb]" : "border-black/10 bg-white"}`}
                        >
                          {medalsSelectMode && (
                            <div className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${isInShip ? "border-black/10 bg-black/5" : isSelected ? "bg-[#e74c3c] border-[#e74c3c]" : "border-black/20"}`}>
                              {isSelected && <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                            </div>
                          )}
                          <img src={fixImageUrl(item.anchor_info.avatar)} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{item.anchor_info.nick_name}</span>
                              {guardLabel && <span className="text-[10px] px-1 rounded bg-[#ffa500]/10 text-[#ffa500]">{guardLabel}</span>}
                              {isWearing && <span className="text-[10px] px-1 rounded bg-[#00a1d6]/10 text-[#00a1d6]">佩戴中</span>}
                              {item.superscript && <span className="text-[10px] text-[#e74c3c]">{item.superscript.content}</span>}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: "linear-gradient(90deg, rgb(6, 21, 76), rgb(104, 136, 241))", color: "#fff" }}>
                                {m.medal_name} Lv.{m.level}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {isInShip && <span className="text-sm text-black/40">在舰不可删除</span>}
                            {m.can_delete && !medalsSelectMode && (
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteMedal(m.medal_id); }}
                                disabled={medalsRemoving}
                                className="rounded-lg bg-[#e74c3c] px-3 py-1.5 text-xs text-white font-medium hover:opacity-90 transition disabled:opacity-50"
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {medalsHasMore && (
                      <button
                        onClick={() => loadMedals(medalsPage + 1, true)}
                        disabled={medalsLoading}
                        className="w-full rounded-lg border border-black/10 bg-white py-2 text-xs text-black/50 hover:bg-black/5 transition disabled:opacity-50"
                      >
                        {medalsLoading ? "加载中..." : "加载更多"}
                      </button>
                    )}
                  </div>
                ) : (
                  medalsLoading ? (
                    <div className="rounded-xl border border-black/10 bg-white/80 p-8 text-center text-sm text-black/45">加载中...</div>
                  ) : (
                    !medalsMsg && <div className="rounded-xl border border-black/10 bg-white/80 p-8 text-center text-sm text-black/35">点击上方按钮加载粉丝牌列表</div>
                  )
                )}
              </div>
            )}

            {/* 复活曲截图 */}
            {activeModule === "screenshot" && toolsPage === "screenshot" && (
              <div className="space-y-4">
                <div className="flex items-center gap-4 py-1">
                  <button onClick={() => pushView("screenshot", "home")} className="flex items-center gap-1 text-xs text-black/50 hover:text-black/80 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    返回
                  </button>
                  <span className="text-sm font-semibold">复活曲截图</span>
                </div>

                <div className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur space-y-5">
                  <div className="text-center">
                    <div className="text-5xl mb-3">📸</div>
                    <h3 className="text-xl font-bold">复活曲截图工具</h3>
                    <p className="text-base text-black/50 mt-1">直播多人局必备，解决复活曲倒计时投屏和医药费争议</p>
                  </div>

                  <hr className="border-black/5" />

                  <div className="space-y-3">
                    <h4 className="text-base font-semibold">你是否遇到过这些问题？</h4>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <span className="text-[#e74c3c] leading-relaxed shrink-0">●</span>
                        <span className="text-base text-black/70 leading-relaxed">多人局时，不知道怎么把复活曲倒计时清晰方便地投屏出来给观众看</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-[#e74c3c] leading-relaxed shrink-0">●</span>
                        <span className="text-base text-black/70 leading-relaxed">最后偷塔守塔不确定有没有掉地上，而主持人没有截图，医药费有争议。而又不好意思争论，只能选择默默吃亏</span>
                      </div>
                    </div>
                  </div>

                  <hr className="border-black/5" />

                  <div className="space-y-3">
                    <h4 className="text-base font-semibold">软件功能</h4>
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <span className="text-[#2ecc71] leading-relaxed shrink-0">✓</span>
                        <span className="text-base text-black/70 leading-relaxed">方便地将复活曲倒计时投屏出来，一次操作长久有效，不用重复设置</span>
                      </div>
                      <div className="flex gap-2">
                        <span className="text-[#2ecc71] leading-relaxed shrink-0">✓</span>
                        <span className="text-base text-black/70 leading-relaxed">复活曲结束时自动精确地截屏直播画面，确定各位的分数，进而确定医药费</span>
                      </div>
                    </div>
                  </div>

                  <hr className="border-black/5" />

                  <div className="text-center">
                    <a
                      href="https://pan.baidu.com/s/1B8IbxCR9g6bZvE3zZp75-Q?pwd=0000"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block rounded-lg bg-[#1f1c17] px-6 py-3 text-base font-medium hover:opacity-90 transition"
                      style={{ color: "#fff" }}
                    >
                      百度网盘下载（提取码: 0000）
                    </a>
                  </div>

                  <hr className="border-black/5" />

                  <div className="space-y-3">
                    <h4 className="text-base font-semibold">软件界面预览</h4>
                    <div className="flex justify-center">
                      <img
                        src="/复活曲截图软件.png"
                        alt="复活曲截图软件界面"
                        className="rounded-lg border border-black/10 max-w-full"
                      />
                    </div>
                  </div>

                  <hr className="border-black/5" />

                  <div className="space-y-3">
                    <h4 className="text-base font-semibold">使用教程</h4>
                    <div className="aspect-video w-full rounded-lg overflow-hidden border border-black/10">
                      <iframe
                        src="//player.bilibili.com/player.html?bvid=BV1P8K66qE7Y&autoplay=0"
                        allowFullScreen
                        className="w-full h-full"
                        scrolling="no"
                        frameBorder="0"
                      />
                    </div>
                    <p className="text-sm text-black/40 text-center">详细使用方法请观看视频</p>
                  </div>
                </div>
              </div>
            )}
        </div>
      </div>

      {/* 离线轻提示 toast */}
      {offlineToast && (
        <div className="fixed left-1/2 top-16 -translate-x-1/2 z-[99999] pointer-events-none">
          <div className="rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
            {offlineToast}
          </div>
        </div>
      )}

      {/* Loading Overlay - only covers content area, header above is still clickable */}
      {loading && (
        <div className="absolute inset-0 z-[9999] bg-white/70 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 w-full max-w-[300px] px-6">
            <div className="w-12 h-12 border-4 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-base font-medium text-[#1f1c17]">正在加载数据...</p>
            <p className="text-sm text-black/45">切换账号需要重新获取数据，请耐心等待</p>
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
              <p className="text-xs text-black/30">首次加载可能需要几分钟</p>
            )}
          </div>
        </div>
      )}

      {/* 待定页（占位，等待后续功能）- 保持挂载 */}
      <div style={{ display: activeModule === "pending" ? "block" : "none" }}>
        <div className="content-wrapper px-2 min-w-0 py-3">
          <div className="rounded-xl border border-black/10 bg-white/85 p-10 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-center">
            <div className="text-4xl mb-3">🚧</div>
            <div className="text-sm text-black/60">新功能筹备中，敬请期待</div>
          </div>
        </div>
      </div>

      </div> {/* End of scrollable content area */}

      {/* iOS 苹果风格悬浮底部托盘导航栏 —— 通过 Portal 渲染到 body 层，完全脱离 page-main 的层叠上下文，避免 iOS Safari 上 transform 合成层覆盖点击区域 */}
      {mounted && createPortal(
        <BottomDock
          tabs={[
            { key: "fans", label: "粉丝" },
            { key: "anchor", label: "主播" },
            { key: "pending", label: "待定" },
            { key: "help", label: "帮助" },
          ]}
          activeKey={dockTab}
          onChange={handleDockChange}
        />,
        document.body
      )}

      {/* 欧皇/非酋认证弹窗 */}
      {showCertModal && certifications.length > 0 && (
        <CertificationModal
          certifications={certifications}
          currentIndex={certModalIndex}
          onIndexChange={setCertModalIndex}
          onClose={() => setShowCertModal(false)}
        />
      )}

      {/* 礼物清单保存图片弹窗 */}
      {showGiftSaveModal && monthGiftSummaryNew.length > 0 && (
        <GiftSaveModal
          gifts={monthGiftSummaryNew}
          userName={currentAccount?.uname ?? currentAccount?.mid?.toString() ?? "未知用户"}
          dateRange={selectedMonth
            ? `${selectedMonth.slice(0, 4)}.${selectedMonth.slice(4, 6)}${selectedDay !== null ? `.${selectedDay}` : ""}`
            : "全部"}
          anchorName={overviewAnchor ? (overviewAnchors.find((a) => a.ruid === Number(overviewAnchor))?.rname ?? "") : "全部主播"}
          anchorCount={overviewAnchors.length}
          selectedMonth={selectedMonth}
          selectedDay={selectedDay}
          actualDateRange={actualDateRange}
          onClose={() => setShowGiftSaveModal(false)}
        />
      )}

      {/* 头像气泡分布图 */}
      {bubbleChartData && (
        <AvatarBubbleChart
          items={bubbleChartData.items}
          title={bubbleChartData.title}
          loading={bubbleChartData.loading}
          loadingText={bubbleChartData.loadingText}
          onClose={() => setBubbleChartData(null)}
        />
      )}

      {/* 城堡统计弹窗 */}
      {showCastleModal && selectedCastleStat && (
        <CastleStatModal
          castleStat={selectedCastleStat}
          castleGift={selectedCastleGift}
          onClose={() => setShowCastleModal(false)}
        />
      )}
    </main>
  );
}