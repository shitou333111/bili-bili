"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { buildMockPayRecordSnapshot } from "@/lib/revenue";
import { toPng } from "html-to-image";
import { isMobileDevice } from "@/lib/device";
import { BLIND_BOX_CONFIG } from "@/lib/config";
import SynthesisActivityCard from "@/components/SynthesisActivityCard";
import AnchorDataModule from "@/components/AnchorDataModule";
import AvatarBubbleChart, { type BubbleItem } from "@/components/AvatarBubbleChart";

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
  source: "qr" | "dev";
  updatedAt: string;
};

type Snapshot = {
  source: "mock" | "real";
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
  historical: { totalSpent: number; totalEarned: number; profit: number; drawCount: number; replaceCount: number; synthesisCount: number; successCount: number; detailedRecords?: any[]; giftList?: any[] };
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
  gifts: Array<{ gift_id: number; gift_name: string; gift_img: string; count: number; coins: number }>;
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
  const totalCoins = gifts.reduce((s, g) => s + g.coins, 0);

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
    try {
      const link = document.createElement("a");
      link.download = `gift_list_${Date.now()}.png`;
      link.href = generatedImage;
      link.click();
    } catch (err) {
      console.error("下载图片失败:", err);
    }
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
                <div key={`${g.gift_id}_${g.gift_name}`} className="flex items-center gap-1 text-sm py-0.5">
                  {g.gift_img ? <img src={fixImageUrl(g.gift_img)} alt="" className="w-7 h-7 rounded flex-shrink-0" crossOrigin="anonymous" /> : <span className="text-[12px] text-black/50 truncate max-w-[55px] flex-shrink-0">{g.gift_name}</span>}
                  <span className="truncate text-black/70 text-sm">×{g.count}</span>
                </div>
              ))}
              {gifts.length > 59 && (
                <div className="flex items-center gap-1 text-sm py-0.5">
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
            {/* 上方提示 */}
            {isMobileDevice() && (
              <span className="text-center text-white/80 text-base font-medium mb-2 block">长按图片保存到相册</span>
            )}

            <img src={generatedImage} alt="礼物清单" className="max-w-full max-h-[70vh] rounded-lg shadow-2xl mx-auto" />

            {/* 下方按钮区域 */}
            <div className="flex flex-col gap-2 mt-3 w-full">
              {!isMobileDevice() && (
                <button onClick={downloadImage} className="w-full rounded-xl bg-[#1f1c17] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载图片
                </button>
              )}
              <button onClick={onClose} className="w-full rounded-xl border border-white/40 bg-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/30">
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
    try {
      const link = document.createElement("a");
      link.download = `cert_${cert.type}_${cert.date.replace(/[^0-9]/g, "")}.png`;
      link.href = generatedImage;
      link.click();
    } catch (err) {
      console.error("下载图片失败:", err);
    }
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
            <div className="flex flex-col gap-2 mt-3">
              {!isMobileDevice() && (
                <button onClick={downloadImage} className="w-full rounded-xl bg-[#1f1c17] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载图片
                </button>
              )}
              <button onClick={onClose} className="w-full rounded-xl border border-white/40 bg-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/30">
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
    try {
      const link = document.createElement("a");
      link.download = `castle_stat_${castleStat.rname}_${Date.now()}.png`;
      link.href = generatedImage;
      link.click();
    } catch (err) {
      console.error("下载图片失败:", err);
    }
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
            <div className="flex flex-col gap-2 mt-3">
              {!isMobileDevice() && (
                <button onClick={downloadImage} className="w-full rounded-xl bg-[#1f1c17] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载图片
                </button>
              )}
              <button onClick={onClose} className="w-full rounded-xl border border-white/40 bg-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/30">
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
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
  const [bubbleChartData, setBubbleChartData] = useState<{ items: BubbleItem[]; title: string; loading?: boolean; loadingText?: string } | null>(null);
  const [anchorFaces, setAnchorFaces] = useState<Record<number, string>>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<"revenue" | "anchor" | "screenshot">("revenue");
  const [toolsPage, setToolsPage] = useState<"home" | "fans" | "medal" | "screenshot">("home");
  // 饼图选中状态 - 用于移动端点击显示tooltip
  const [pieActiveIndex, setPieActiveIndex] = useState<number | null>(null);
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
  const [isMockMode, setIsMockMode] = useState(false);
  const [apiLoggedIn, setApiLoggedIn] = useState(false);
  const [showHistoricalDebug, setShowHistoricalDebug] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  // 点击空白区域关闭下拉菜单
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isDropdownOpen]);

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

  async function fetchData() {
    setLoading(true);
    try {
      const [accountsRes, snapshotRes] = await Promise.all([
        fetch("/api/auth/accounts", { cache: "no-store" }),
        fetch("/api/revenue/pay-record", { cache: "no-store" }),
      ]);

      const accountsData = await accountsRes.json();
      const snapshotData = await snapshotRes.json();

      setAccounts(accountsData.data?.accounts || []);

      const statusRes = await fetch("/api/auth/status", { cache: "no-store" });
      const statusData = await statusRes.json();
      if (statusData.data?.loggedIn && statusData.data?.sid) {
        setApiLoggedIn(true);
        setCurrentAccount(accountsData.data?.accounts?.find((a: Account) => a.sid === statusData.data?.sid) || null);
        setIsMockMode(false);
      } else if (statusData.data?.expired) {
        setApiLoggedIn(false);
        // B站凭证失效且刷新失败，展示模拟数据
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
        } else if (snapshotData.message === "mock snapshot") {
          setIsMockMode(true);
          setAuthError("当前查看的是模拟数据，切换账号查看自己数据");
        } else {
          setIsMockMode(false);
          setAuthError(null);
        }
      } else {
        // 没有真实数据，回退到模拟数据
        setSnapshot(buildMockPayRecordSnapshot());
        setIsMockMode(true);
        setAuthError("当前查看的是模拟数据，切换账号查看自己数据");
      }

      // 有真实数据或模拟数据时获取统计（模拟模式下 API 返回模拟数据）
      if (snapshotData.data?.source === "real" || snapshotData.data?.source === "mock") {
        await Promise.all([
          fetchStats(),
          fetchCertifications(),
          fetchOtherStats(),
        ]);
      }
    } catch (error) {
      console.error("Failed to fetch data:", error);
    } finally {
      setLoading(false);
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

      const [blindBoxRes, synthesisRes] = await Promise.all([
        fetch(blindBoxUrl, { cache: "no-store" }),
        fetch("/api/stats/synthesis", { cache: "no-store" }),
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

  function handleAnchorFilter(blindBoxId: number, ruid: string) {
    const newFilters = {
      ...blindBoxFilters,
      [blindBoxId]: { ruid, dateRange: blindBoxFilters[blindBoxId]?.dateRange ?? "all" },
    };
    setBlindBoxFilters(newFilters);
    fetchStats(newFilters);
  }

  function handleDateFilter(blindBoxId: number, dateRange: string) {
    const newFilters = {
      ...blindBoxFilters,
      [blindBoxId]: { ruid: blindBoxFilters[blindBoxId]?.ruid ?? "", dateRange },
    };
    setBlindBoxFilters(newFilters);
    fetchStats(newFilters);
  }

  async function fetchCertifications() {
    try {
      const res = await fetch("/api/stats/certification", { cache: "no-store" });
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
      const res = await fetch("/api/stats/other", { cache: "no-store" });
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
    const initialItems: BubbleItem[] = topAnchors.map(a => ({
      id: a.ruid,
      name: a.rname,
      value: a.coins,
      face: anchorFaces[a.ruid] || "",
    }));
    setBubbleChartData({ items: initialItems, title: "消费主播分布", loading: true, loadingText: "正在获取主播头像..." });

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
            const res = await fetch(`/api/tools/user-info?uids=${batch.join(",")}`, { cache: "no-store" });
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
      face: faces[a.ruid] || "",
    }));

    setBubbleChartData({ items, title: "消费主播分布", loading: false });
  }

  async function loadFans(pn: number, append = false) {
    setFansLoading(true);
    setFansMsg("");
    try {
      const res = await fetch(`/api/tools/fans?pn=${pn}&ps=50`, { cache: "no-store" });
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
      const res = await fetch("/api/tools/remove-fan", {
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
      const res = await fetch(`/api/tools/medals?page=${page}`, { cache: "no-store" });
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
      const res = await fetch("/api/tools/delete-medal", {
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
        const res = await fetch("/api/tools/delete-medal", {
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

  async function refreshData() {
    setLoading(true);
    setAuthError(null);
    try {
      const snapshotRes = await fetch("/api/revenue/pay-record?refresh=true", { cache: "no-store" });
      const snapshotData = await snapshotRes.json();
      if (snapshotData.data) {
        setSnapshot(snapshotData.data);
        // 根据 message 判断数据来源
        if (snapshotData.message === "needs-relogin") {
          await handleAuthExpired();
          setLoading(false);
          return;
        } else if (snapshotData.message === "cached snapshot") {
          setAuthError("B站请求失败，当前显示的是历史缓存数据。");
        } else if (snapshotData.message === "mock snapshot") {
          setAuthError("未登录B站，查看的是模拟数据。扫码登录查看自己的数据");
        }
      }
      if (snapshotData.data?.source === "real" || snapshotData.data?.source === "mock") {
        await Promise.all([
          fetchStats(),
          fetchCertifications(),
          fetchOtherStats(),
        ]);
      }
    } catch (error) {
      console.error("Failed to refresh data:", error);
      setAuthError("网络请求失败，请检查网络连接后重试。");
    } finally {
      setLoading(false);
      setLastRefreshTime(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    }
  }

  async function switchAccount(sid: string) {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid }),
      });
      const data = await response.json();
      if (data.code === 0) {
        setIsDropdownOpen(false);
        await fetchData();
      }
    } catch (error) {
      console.error("Failed to switch account:", error);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setCurrentAccount(null);
      setIsDropdownOpen(false);
      setSnapshot(buildMockPayRecordSnapshot());
      setBlindBoxStats(null);
      setSynthesisStats(null);
    } catch (error) {
      console.error("Failed to logout:", error);
    }
  }

  function switchToMock() {
    setSnapshot(buildMockPayRecordSnapshot());
    setBlindBoxStats(null);
    setSynthesisStats(null);
    setIsMockMode(true);
    setAuthError("当前查看的是模拟数据，切换账号查看自己数据");
    // 模拟模式下立即调用统计API获取模拟统计数据
    fetchStats();
    fetchCertifications();
    fetchOtherStats();
  }

  /** 登录凭证失效时：清除会话，展示模拟数据，不跳转登录页 */
  async function handleAuthExpired() {
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentAccount(null);
    setApiLoggedIn(false);
    setSnapshot(buildMockPayRecordSnapshot());
    setBlindBoxStats(null);
    setSynthesisStats(null);
    setIsMockMode(true);
    setAuthError("B站登录已失效，当前查看的是模拟数据");
    fetchStats();
    fetchCertifications();
    fetchOtherStats();
  }

  const isLoggedIn = Boolean(currentAccount) || apiLoggedIn;
  const isRealSnapshot = snapshot?.source === "real";

  // 按主播筛选记录
  const filteredOverviewRecords = snapshot ? (overviewAnchor
    ? snapshot.records.filter((r) => r.ruid === Number(overviewAnchor) && r.status_msg !== "已退回")
    : snapshot.records.filter(r => r.status_msg !== "已退回")) : [];

  // 按月份聚合数据
  const monthlyData: MonthlyData[] = snapshot ? (() => {
    const map = new Map<string, { coins: number; count: number }>();
    for (const r of filteredOverviewRecords) {
      const d = new Date(r.timestamp * 1000);
      const key = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
      const existing = map.get(key) || { coins: 0, count: 0 };
      existing.coins += r.totalCoins;
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
    const map = new Map<number, { rname: string; coins: number }>();
    for (const r of snapshot.records) {
      const existing = map.get(r.ruid) ?? { rname: r.r_uname, coins: 0 };
      existing.coins += r.totalCoins;
      map.set(r.ruid, existing);
    }
    return Array.from(map.entries())
      .map(([ruid, v]) => ({ ruid, rname: v.rname, coins: v.coins }))
      .sort((a, b) => b.coins - a.coins);
  })() : [];

  // 按选定日期范围计算的主播分布（不受 anchor 筛选影响，用于右侧饼图+下拉）
  const periodAnchors: Array<{ ruid: number; rname: string; coins: number }> = snapshot ? (() => {
    let records = snapshot.records;
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
    const map = new Map<number, { rname: string; coins: number }>();
    for (const r of records) {
      const existing = map.get(r.ruid) ?? { rname: r.r_uname, coins: 0 };
      existing.coins += r.totalCoins;
      map.set(r.ruid, existing);
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

  // 当日记录（按 selectedDay 筛选）
  const dayRecords = selectedDay !== null
    ? monthRecords.filter((r) => {
        const d = new Date(r.timestamp * 1000);
        return d.getDate() === selectedDay;
      })
    : [];

  // 每日聚合数据（用于日历）
  const dailyData: Map<number, number> = (() => {
    const map = new Map<number, number>();
    for (const r of monthRecords) {
      const d = new Date(r.timestamp * 1000);
      const day = d.getDate();
      map.set(day, (map.get(day) ?? 0) + r.totalCoins);
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

  // 消费电池数：排除所有包裹道具（合成产出、天选、红包都不是实际消费）
  const consumptionCoins = filteredOverviewRecords
    .filter(r => r.bag_desc !== "包裹道具")
    .reduce((sum, r) => sum + r.totalCoins, 0);

  // 赚取礼物统计（包裹道具，排除合成消费gift_id=1）
  const earnedGiftRecords = filteredOverviewRecords.filter(r => r.bag_desc === "包裹道具" && r.gift_id !== 1);
  const earnedGiftCount = earnedGiftRecords.reduce((sum, r) => sum + r.gift_num, 0);
  const earnedGiftTypes = new Set(earnedGiftRecords.map(r => r.gift_name)).size;

  // 礼物清单汇总（所有实际送出的礼物，排除合成原料gift_id=1）
  const monthGiftSummaryNew = (() => {
    const rawRecords = dayRecords.length > 0 ? dayRecords : (selectedMonth ? monthRecords : filteredOverviewRecords);
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
      if (!existing.gift_img && r.gift_img) {
        existing.gift_img = fixImageUrl(r.gift_img);
        existing.gift_id = r.gift_id;
      }
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.coins - a.coins);
  })();

  // 实际日期范围（从第一条到最后一条礼物记录）
  const actualDateRange = filteredOverviewRecords.length > 0 ? (() => {
    const sorted = [...filteredOverviewRecords].sort((a, b) => a.timestamp - b.timestamp);
    return { start: formatDateShort(formatTimestamp(sorted[0].timestamp)), end: formatDateShort(formatTimestamp(sorted[sorted.length - 1].timestamp)) };
  })() : null;

  return (
    <main className="h-screen flex flex-col bg-[#f5f5f5] text-[#1f1c17]">
      {/* Header - outside scroll area, always clickable during loading */}
      <header className="flex-shrink-0 mx-auto w-full max-w-4xl flex items-center justify-between px-4 py-2 bg-[#e8e8e8]">
        <h1 className="font-[family-name:var(--font-space-grotesk)] text-lg font-semibold tracking-tight">B站小工具</h1>
        <div className="flex items-center gap-2">
            {isLoggedIn || isMockMode ? (
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  className="flex items-center gap-1.5 rounded-full bg-[#1f1c17] px-2 py-1.5 text-sm font-medium text-white transition hover:opacity-90"
                >
                  {isMockMode ? (
                    <span className="text-white">🎮 模拟数据</span>
                  ) : currentAccount?.face ? (
                    <img src={fixImageUrl(currentAccount.face)} alt="" className="w-5 h-5 rounded-full object-cover" />
                  ) : (
                    <span className="max-w-[60px] truncate">{currentAccount?.uname || currentAccount?.mid}</span>
                  )}
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {isDropdownOpen && (
                  <div className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-black/10 bg-white shadow-lg z-[10001]">
                    <div className="p-2">
                      <div className="px-3 py-2 text-xs font-medium text-black/40 uppercase tracking-wider">已登录账号</div>
                      {accounts.map((acc) => {
                          const isSelected = !isMockMode && acc.sid === currentAccount?.sid;
                          return (
                            <button
                              key={acc.sid}
                              onClick={() => switchAccount(acc.sid)}
                              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-sm transition ${
                                isSelected
                                  ? "bg-[#1f1c17] text-white"
                                  : "hover:bg-black/5 text-black"
                              }`}
                            >
                              <span>{acc.uname}</span>
                              {isSelected && (
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      <div className="border-t border-black/10 my-2"></div>
                      <button
                        onClick={() => { setIsDropdownOpen(false); switchToMock(); }}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-sm transition ${
                          isMockMode ? "bg-[#1f1c17] text-white" : "hover:bg-black/5 text-black"
                        }`}
                      >
                        <span>模拟数据</span>
                        {isMockMode && (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </button>
                      <Link href="/login" className="w-full block px-3 py-2 rounded-lg text-left text-sm text-black hover:bg-black/5 transition">
                        添加新账号
                      </Link>
                      <button
                        onClick={logout}
                        className="w-full px-3 py-2 rounded-lg text-left text-sm text-red-600 hover:bg-red-50 transition"
                      >
                        退出登录
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <Link href="/login" className="rounded-full bg-[#1f1c17] px-3 py-1.5 text-sm font-medium !text-white transition hover:opacity-90">
                扫码登录
              </Link>
            )}
            {/* 刷新按钮已移至各页面内部 */}
          </div>
        </header>

      {/* Content Area - scrollable, overlay only covers this area (not header) */}
      <div className="flex-1 overflow-y-auto relative pb-14">

      {/* Auth error banner */}
      {authError && (
        <div className="mx-auto w-full max-w-4xl px-2 py-2 bg-amber-50 rounded-lg">
          <p className="text-sm text-amber-800">{authError}</p>
        </div>
      )}

      {/* Loading state (only for revenue module) */}
      {activeModule === "revenue" && !snapshot && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm text-black/45">加载中...</p>
            <p className="text-xs text-black/30">首次加载需要几分钟，请耐心等待</p>
          </div>
        </div>
      )}

      {/* Content - Revenue module */}
      {activeModule === "revenue" && snapshot && (
        <div className="mx-auto w-full max-w-4xl px-2 min-w-0 py-3">
          {/* L3 Tab bar - sticky at top */}
            <div className="flex items-center gap-2 px-4 py-1.5 mb-2 overflow-x-auto whitespace-nowrap scrollbar-none sticky top-0 bg-[#f5f5f5]/95 backdrop-blur z-10">
              {(["overview", "blindbox", "synthesis", "other"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    activeTab === tab
                      ? "bg-[#1f1c17] text-white"
                      : "bg-white border border-black/15 text-black/75 hover:bg-gray-50"
                  }`}
                >
                  {tab === "overview" ? "消费统计" : tab === "blindbox" ? "盲盒盈亏" : tab === "synthesis" ? "合成盈亏" : "其他数据"}
                </button>
              ))}
              <button
                onClick={refreshData}
                disabled={loading}
                className="shrink-0 rounded-full border border-black/15 px-3 py-1.5 text-xs font-medium text-black/60 transition hover:bg-gray-50 disabled:opacity-50"
              >
                <svg className={`w-3.5 h-3.5 inline-block mr-0.5 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                {loading ? "刷新中..." : "刷新"}
              </button>
              {lastRefreshTime && <span className="shrink-0 text-xs text-black/30">{lastRefreshTime}</span>}
            </div>
          <section className="grid gap-6">
            {/* Overview tab - Unified card: Summary + Date/Anchor + Gift List */}
            {activeTab === "overview" && (
              <article className="rounded-xl border border-black/10 bg-white/80 p-3 shadow-[0_20px_80px_rgba(31,28,23,0.08)] overflow-visible">
                {/* Row 0: Date range */}
                {snapshot.records.length > 0 && (() => {
                  const sorted = [...snapshot.records].sort((a, b) => a.timestamp - b.timestamp);
                  return <div className="text-xs text-black/40 mb-3">统计范围: {formatDateShort(formatTimestamp(sorted[0].timestamp))} - {formatDateShort(formatTimestamp(sorted[sorted.length - 1].timestamp))}</div>;
                })()}

                {/* Row 1: Summary stats cards */}
                <div className="grid gap-3 grid-cols-2 sm:grid-cols-4 mb-3">
                  <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3 relative">
                    <div className="text-xs text-black/45 flex items-center gap-1">
                      消费电池
                      <div className="relative" ref={statsRulesRef}>
                        <button
                          onClick={() => setShowStatsRules(!showStatsRules)}
                          className="w-3.5 h-3.5 rounded-full bg-black/10 text-black/40 text-[9px] flex items-center justify-center hover:bg-black/20 hover:text-black/60 transition-colors cursor-pointer"
                          title="查看计算规则"
                        >?</button>
                        {showStatsRules && (
                          <div className="absolute left-5 top-0 z-50 w-72 bg-white border border-black/10 rounded-lg shadow-lg p-3 text-xs text-black/70 leading-relaxed">
                            <div className="font-medium text-black/90 mb-1.5">消费电池计算规则</div>
                            <div>实际花费的电池数 = 所有消费记录 - 包裹道具（合成产出、天选礼物、红包礼物）</div>
                            <div className="mt-1 text-black/50">包裹道具不是实际消费，不计入消费电池。</div>
                            <div className="mt-1 text-black/50">本站所有消费单位都是电池</div>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="mt-1 text-xl font-semibold">{consumptionCoins.toLocaleString()}</div>
                  </div>
                  <div className="rounded-lg border border-black/10 bg-[#fff7ef] p-3">
                    <div className="text-xs text-black/45">消费次数</div>
                    <div className="mt-1 text-xl font-semibold">{filteredOverviewRecords.filter(r => r.bag_desc !== "包裹道具").length}</div>
                  </div>
                  <div className="rounded-lg border border-black/10 bg-[#f0f7ee] p-3">
                    <div className="text-xs text-black/45">礼物种类</div>
                    <div className="mt-1 text-xl font-semibold">{giftTypeCount}</div>
                  </div>
                  <div
                    className="rounded-lg border border-black/10 bg-[#f5f0f7] p-3 cursor-pointer hover:shadow-md transition-shadow relative group"
                    onClick={openAnchorBubbleChart}
                  >
                    <div className="text-xs text-black/45 flex items-center gap-1">
                      主播数
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-black/10 text-[10px] text-black/50 cursor-help">?</span>
                    </div>
                    <div className="mt-1 text-xl font-semibold">{overviewAnchors.length}</div>
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 px-3 py-2 bg-black/85 text-white text-xs rounded-lg shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-[9999] text-center leading-relaxed">
                      点击查看主播消费分布图<br/>此操作耗时约3分钟，频繁访问会限流，建议访问一次后保存图片
                      <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-black/85"></div>
                    </div>
                  </div>
                </div>

                {/* Row 2: Latest record */}
                {recentRecords.length > 0 && recentRecords.map((record) => (
                  <div key={record.id} className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3 mb-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-black/65">最新记录（验证是否最新）</span>
                      {isRealSnapshot && (
                        <a
                          href="/api/export/json"
                          download
                          className="rounded-full border border-[#1f1c17] px-3 py-0.5 text-xs font-medium text-[#1f1c17] transition hover:bg-black/5"
                        >
                          下载全部数据
                        </a>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        {record.gift_img && <img src={fixImageUrl(record.gift_img)} alt="" className="w-5 h-5 rounded" />}
                        <span className="font-medium">{record.gift_name}×{record.gift_num}</span>
                      </div>
                      <span className="text-black">{record.r_uname}</span>
                      <span className="text-black/55">{formatTimestamp(record.timestamp)}</span>
                    </div>
                  </div>
                ))}

                <hr className="border-t border-black/10 my-2" />

                {/* Row 2: Left-Right Date + Anchor */}
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0">
                  {/* Left: Date stats */}
                  <div className="min-w-0 pr-2 border-r border-black/10">
                    <h3 className="text-sm font-semibold tracking-tight text-center mb-1">日期统计</h3>
                    {/* Monthly bar chart */}
                    {monthlyData.length > 0 && (() => {
                      const barWidth = 10;
                      const minWidth = Math.max(monthlyData.length * (barWidth + 4) + 20, 100);
                      const shouldSkipLabels = monthlyData.length > 8;

                      function formatCoinsForTooltip(value: number) {
                        if (value >= 10000) return `${(value / 10000).toFixed(1)}万 电池`;
                        return `${value} 电池`;
                      }

                      return (
                        <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none">
                          <div className="text-[10px] text-black/45">月度统计</div>
                          <div className="overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
                            <div style={{ width: "100%", minWidth: `${minWidth}px` }}>
                              <ResponsiveContainer width="100%" height={170}>
                                <BarChart data={monthlyData} margin={{ top: 16, right: 2, left: 2, bottom: 2 }}>
                                  <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 10, fill: "#888" }} axisLine={{ stroke: "#e5e0d8" }} tickLine={false} />
                                  <Tooltip
                                    content={({ active, label, payload }: any) => {
                                      if (active && payload && payload.length) {
                                        return (
                                          <div style={{ borderRadius: "12px", border: "1px solid #e5e0d8", background: "#fff", padding: "8px 12px", fontSize: "12px" }}>
                                            <p style={{ margin: 0, fontWeight: 500 }}>{monthLabel(String(label))}</p>
                                            <p style={{ margin: "4px 0 0 0", color: "#1f1c17" }}>{formatCoinsForTooltip(Number(payload[0].value))}</p>
                                          </div>
                                        );
                                      }
                                      return null;
                                    }}
                                  />
                                  <Bar dataKey="coins" radius={[3, 3, 0, 0]} barSize={barWidth} cursor="pointer"
                                    onClick={(data: any) => { if (data?.month) { setSelectedMonth(data.month === selectedMonth ? null : data.month); setSelectedDay(null); } }}
                                    label={(props: any) => {
                                      const { x, y, width, value, index } = props;
                                      if (!value) return null;
                                      // 月份超过8个时，每隔3个显示一个标签
                                      if (shouldSkipLabels && index % 3 !== 0) return null;
                                      const text = value >= 10000 ? `${(value / 10000).toFixed(1)}万` : value;
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

                    {/* Calendar */}
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
                              const intensity = cell.day !== null && cell.coins > 0
                                ? Math.min(cell.coins / maxDayCoins, 1)
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
                                  title={cell.day !== null ? `${cell.day}日: ${cell.coins}电池` : ""}
                                >
                                  {cell.day !== null && (
                                    <>
                                      <span>{cell.day}</span>
                                      {cell.coins > 0 && (
                                        <span className="text-[8px] opacity-70 leading-none">{formatCoinsShort(cell.coins)}</span>
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

                  {/* Right: Anchor distribution */}
                  <div className="pl-2">
                    <h3 className="text-sm font-semibold tracking-tight text-center mb-1">主播分布</h3>
                    <div className="flex flex-col">
                      {/* First pie: all-time anchors */}
                      {overviewAnchors.length > 0 && (() => {
                        const pieColors = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#c026d3", "#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#e11d48", "#0284c7", "#b91c1c", "#047857", "#b45309", "#6d28d9"];
                        const TOP_N = 20;
                        const buildPieData = (anchors: Array<{ ruid: number; rname: string; coins: number }>) => {
                          const result: Array<{ rname: string; coins: number; ruid: number | null; fill: string }> = [];
                          let otherCoins = 0;
                          for (let i = 0; i < anchors.length; i++) {
                            if (i < TOP_N) {
                              result.push({ rname: anchors[i].rname, coins: anchors[i].coins, ruid: anchors[i].ruid, fill: pieColors[i % pieColors.length] });
                            } else {
                              otherCoins += anchors[i].coins;
                            }
                          }
                          if (otherCoins > 0) {
                            result.push({ rname: "其他", coins: otherCoins, ruid: null, fill: "#94a3b8" });
                          }
                          return result;
                        };
                        const allTimePieData = buildPieData(overviewAnchors);
                        return (
                          <>
                            <div className="text-[10px] text-black/45">全部时期</div>
                            <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none -mx-1" style={{ height: 170 }}>
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                  <Pie
                                    data={allTimePieData}
                                    dataKey="coins"
                                    nameKey="rname"
                                    cx="50%"
                                    cy="50%"
                                    outerRadius="95%"
                                    paddingAngle={0}
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    onClick={(data: any, index: number) => {
                                      if (data?.ruid !== null && data?.ruid !== undefined) {
                                        const ruidStr = String(data.ruid);
                                        setOverviewAnchor(ruidStr === overviewAnchor ? "" : ruidStr);
                                        setSelectedDay(null);
                                      }
                                      // 移动端点击切换tooltip显示
                                      setPieActiveIndex(pieActiveIndex === index ? null : index);
                                    }}
                                    cursor="pointer"
                                  >
                                    {allTimePieData.map((entry, index) => (
                                      <Cell
                                        key={`cell-all-${index}`}
                                        fill={entry.fill}
                                        stroke={overviewAnchor && entry.ruid !== null && String(entry.ruid) === overviewAnchor ? "#1f1c17" : "none"}
                                        strokeWidth={overviewAnchor && entry.ruid !== null && String(entry.ruid) === overviewAnchor ? 2 : 0}
                                      />
                                    ))}
                                  </Pie>
                                  <Tooltip
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    formatter={((value: number, name: string) => [`${value} 电池`, name]) as any}
                                    contentStyle={{ borderRadius: "12px", border: "1px solid #e5e0d8", background: "#fff" }}
                                  />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                          </>
                        );
                      })()}

                      {/* Second pie: period anchors (visible when month selected) */}
                      {selectedMonth && periodAnchors.length > 0 && (() => {
                        const pieColors = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#c026d3", "#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#e11d48", "#0284c7", "#b91c1c", "#047857", "#b45309", "#6d28d9"];
                        const TOP_N = 20;
                        const buildPieData = (anchors: Array<{ ruid: number; rname: string; coins: number }>) => {
                          const result: Array<{ rname: string; coins: number; ruid: number | null; fill: string }> = [];
                          let otherCoins = 0;
                          for (let i = 0; i < anchors.length; i++) {
                            if (i < TOP_N) {
                              result.push({ rname: anchors[i].rname, coins: anchors[i].coins, ruid: anchors[i].ruid, fill: pieColors[i % pieColors.length] });
                            } else {
                              otherCoins += anchors[i].coins;
                            }
                          }
                          if (otherCoins > 0) {
                            result.push({ rname: "其他", coins: otherCoins, ruid: null, fill: "#94a3b8" });
                          }
                          return result;
                        };
                        const periodPieData = buildPieData(periodAnchors);
                        const title = selectedDay !== null
                          ? `${selectedMonth.slice(0, 4)}年${parseInt(selectedMonth.slice(4, 6))}月${selectedDay}日主播分布`
                          : `${selectedMonth.slice(0, 4)}年${parseInt(selectedMonth.slice(4, 6))}月主播分布`;
                        return (
                          <div className="mt-2 border-t border-black/10 pt-2">
                            <div className="text-[10px] text-black/45">{title}</div>
                            <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none -mx-1" style={{ height: 170 }}>
                              <ResponsiveContainer width="100%" height="100%">
                                <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                  <Pie
                                    data={periodPieData}
                                    dataKey="coins"
                                    nameKey="rname"
                                    cx="50%"
                                    cy="50%"
                                    outerRadius="95%"
                                    paddingAngle={0}
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    onClick={(data: any, index: number) => {
                                      if (data?.ruid !== null && data?.ruid !== undefined) {
                                        const ruidStr = String(data.ruid);
                                        setOverviewAnchor(ruidStr === overviewAnchor ? "" : ruidStr);
                                        setSelectedDay(null);
                                      }
                                      // 移动端点击切换tooltip显示
                                      setPieActiveIndex(pieActiveIndex === index ? null : index);
                                    }}
                                    cursor="pointer"
                                  >
                                    {periodPieData.map((entry, index) => (
                                      <Cell
                                        key={`cell-period-${index}`}
                                        fill={entry.fill}
                                        stroke={overviewAnchor && entry.ruid !== null && String(entry.ruid) === overviewAnchor ? "#1f1c17" : "none"}
                                        strokeWidth={overviewAnchor && entry.ruid !== null && String(entry.ruid) === overviewAnchor ? 2 : 0}
                                      />
                                    ))}
                                  </Pie>
                                  <Tooltip
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    formatter={((value: number, name: string) => [`${value} 电池`, name]) as any}
                                    contentStyle={{ borderRadius: "12px", border: "1px solid #e5e0d8", background: "#fff" }}
                                  />
                                </PieChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Anchor dropdown - uses periodAnchors when date selected, else overviewAnchors */}
                      <div className="mt-1">
                        <select
                          value={overviewAnchor}
                          onChange={(e) => { setOverviewAnchor(e.target.value); setSelectedDay(null); }}
                          className="w-full rounded border border-black/10 bg-white px-2 py-1 text-xs text-black/80 outline-none"
                        >
                          <option value="">全部主播（电池）</option>
                          {(selectedMonth ? periodAnchors : overviewAnchors).map((anchor) => (
                            <option key={anchor.ruid} value={anchor.ruid}>
                              {anchor.rname} ({anchor.coins})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <hr className="border-t border-black/10 my-2" />

                {/* Row 3: Gift list */}
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold tracking-tight flex items-center gap-1">
                      礼物清单
                      <div className="relative" ref={giftListRulesRef}>
                        <button
                          onClick={() => setShowGiftListRules(!showGiftListRules)}
                          className="w-3.5 h-3.5 rounded-full bg-black/10 text-black/40 text-[9px] flex items-center justify-center hover:bg-black/20 hover:text-black/60 transition-colors cursor-pointer"
                          title="查看统计规则"
                        >?</button>
                        {showGiftListRules && (
                          <div className="absolute left-5 top-0 z-50 w-72 bg-white border border-black/10 rounded-lg shadow-lg p-3 text-xs text-black/70 leading-relaxed">
                            <div className="font-medium text-black/90 mb-1.5">礼物清单规则</div>
                            <div>罗列所有实际送出的礼物（含合成、天选、红包）。</div>
                            <div className="mt-1">电池数 = 实际消费的电池，所以这里的电池数并不精确等于列表中礼物的总价值</div>
                          </div>
                        )}
                      </div>
                      <span className="ml-2 text-xs font-normal text-black/45">
                        {overviewAnchor ? (overviewAnchors.find((a) => a.ruid === Number(overviewAnchor))?.rname ?? "") : "全部主播"}
                      </span>
                      <span className="ml-2 text-xs font-normal text-black/45">
                        {selectedMonth
                          ? `${monthLabel(selectedMonth)}${selectedDay !== null ? `.${selectedDay}日` : ""}`
                          : actualDateRange ? `${actualDateRange.start} ~ ${actualDateRange.end}` : "全部时间"}
                      </span>
                      <span className="ml-2 text-xs font-semibold text-black/65">
                        {monthGiftSummaryNew.reduce((s, g) => s + g.coins, 0)}电池
                      </span>
                    </h3>
                    {monthGiftSummaryNew.length > 0 && (
                      <button
                        onClick={() => setShowGiftSaveModal(true)}
                        className="rounded-full bg-[#1f1c17] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90"
                      >
                        保存为图片
                      </button>
                    )}
                  </div>

                  {monthGiftSummaryNew.length > 0 ? (
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
                          {monthGiftSummaryNew.map((gift) => (
                            <tr key={`${gift.gift_id}_${gift.gift_name}`} className="border-t border-black/10 bg-white">
                              <td className="px-3 py-1.5">
                                <div className="flex items-center gap-1.5">
                                  {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-4 h-4 rounded" />}
                                  <span className="font-medium text-xs">{gift.gift_name}</span>
                                </div>
                              </td>
                              <td className="px-3 py-1.5 text-right text-xs">{Math.round(gift.coins / gift.count)}</td>
                              <td className="px-3 py-1.5 text-right text-xs">{gift.count}</td>
                              <td className="px-3 py-1.5 text-right text-xs">{gift.coins}</td>
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

            {/* Blind box tab */}
            {activeTab === "blindbox" && (
              <>
                {blindBoxStats ? (
                  <div className="space-y-4">
                    {blindBoxStats.map((stat) => {
                      const currentFilter = blindBoxFilters[stat.blindBoxId] ?? { ruid: "", dateRange: "all" };
                      const isXindong = stat.blindBoxId === 32251;
                      return (
                        <div key={stat.blindBoxId} className={`rounded-lg border border-black/10 p-2 ${isXindong ? "bg-[#f9f4ea]" : "bg-[#fff7ef]"}`}>
                          {/* Row 1: 盲盒图标+名称 + 统计时间 */}
                          <div className="flex items-center gap-2 mb-2">
                            {BLIND_BOX_CONFIG.icons[stat.blindBoxId] && (
                              <img src={BLIND_BOX_CONFIG.icons[stat.blindBoxId]} alt="" className="w-6 h-6 rounded" />
                            )}
                            <span className="font-semibold text-sm truncate max-w-[80px]">{stat.blindBoxName.slice(0, 6)}{stat.blindBoxName.length > 6 ? "..." : ""}</span>
                            {isXindong && (
                              <button
                                onClick={() => {
                                  if (certifications.length > 0) {
                                    setShowCertModal(true);
                                    setCertModalIndex(0);
                                  } else {
                                    alert("当前暂无满足欧皇/非酋认证的记录。\n\n欧皇认证：某一天爆出至少1个浪漫城堡，且盈利超过10,000电池。\n非酋认证：某一天抽取超过1,000个心动盲盒，但没有爆出浪漫城堡。");
                                  }
                                }}
                                className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs transition ${
                                  certifications.length > 0
                                    ? "border-yellow-400 bg-yellow-50 hover:bg-yellow-100"
                                    : "border-black/15 bg-white opacity-40"
                                }`}
                                title={certifications.length > 0 ? "查看欧皇/非酋认证" : "暂无认证记录"}
                              >
                                <span className="text-sm leading-none">👑</span>
                                <span className="w-px h-3 bg-black/20 mx-0.5"></span>
                                <span className="text-sm leading-none">👻</span>
                              </button>
                            )}
                            <span className="ml-auto text-xs text-black/65">
                              {stat.dateRange
                                ? `${stat.dateRange.start.split(" ")[0].replace(/-/g, ".")} - ${stat.dateRange.end.split(" ")[0].replace(/-/g, ".")}`
                                : "无数据"}
                            </span>
                          </div>

                          {/* Row 2: 时间筛选 + 主播筛选 */}
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div className="flex border border-black/10 rounded-lg overflow-hidden">
                              {(["all", "thisMonth", "thisWeek", "today"] as const).map((key) => (
                                <button
                                  key={key}
                                  onClick={() => handleDateFilter(stat.blindBoxId, key)}
                                  className={`flex-1 px-1 py-1 text-[10px] whitespace-nowrap transition ${
                                    currentFilter.dateRange === key
                                      ? "bg-[#1f1c17] text-white"
                                      : "bg-white text-black/65 hover:bg-black/5"
                                  }`}
                                >
                                  {key === "all" ? "全部" : key === "thisMonth" ? "本月" : key === "thisWeek" ? "本周" : "本日"}
                                </button>
                              ))}
                            </div>
                            <select
                              value={currentFilter.ruid}
                              onChange={(e) => handleAnchorFilter(stat.blindBoxId, e.target.value)}
                              className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/65 outline-none focus:border-black/30"
                            >
                              <option value="">全部主播</option>
                              {stat.anchors.map((anchor) => (
                                <option key={anchor.ruid} value={anchor.ruid}>
                                  {anchor.rname} ({anchor.count})
                                </option>
                              ))}
                            </select>
                          </div>

                          {/* Row 3: 统计数据 */}
                          <div className="flex items-center justify-between gap-3 rounded-lg bg-black/5 px-3 py-2 text-xs">
                            <span className="text-black/50">单价 <b className="text-black/80">{stat.blindPrice}</b></span>
                            <span className="text-black/50">共 <b className="text-black/80">{stat.drawCount}</b> 次</span>
                            <span className="text-black/50">花费 <b className="text-black/80">{stat.totalSpent}</b></span>
                            <span className="text-black/50">爆出 <b className="text-black/80">{stat.totalEarned}</b></span>
                            <span className={`font-bold text-sm ${stat.profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                              {stat.profit >= 0 ? "+" : ""}{stat.profit}
                            </span>
                          </div>

                          {/* 礼品明细 */}
                          {stat.gifts.length > 0 && (
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
                                  {stat.gifts
                                    .sort((a, b) => b.unitPrice - a.unitPrice)
                                    .map((gift) => (
                                      <tr key={`${gift.gift_id}_${gift.gift_name}`} className="border-t border-black/10 bg-white">
                                        <td className="pl-3 pr-2 py-2">
                                          <div className="flex items-center gap-2">
                                            {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-5 h-5 rounded flex-shrink-0" />}
                                            <span className="font-medium">{gift.gift_name}</span>
                                          </div>
                                        </td>
                                        <td className="px-2 py-2 text-right">{gift.unitPrice}</td>
                                        <td className="px-2 py-2 text-right">{gift.count}</td>
                                        <td className="px-2 py-2 text-right">{gift.totalValue}</td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          {/* 城堡统计（仅心动盲盒） */}
                          {isXindong && stat.castleStats.length > 0 && (
                            <div className="mt-3">
                              <div className="flex items-center gap-2 mb-2">
                                {stat.castleGift?.gift_img && (
                                  <img src={fixImageUrl(stat.castleGift.gift_img)} alt="" className="w-6 h-6 rounded" />
                                )}
                                <span className="text-sm font-semibold text-black/70">城堡统计</span>
                              </div>
                              <div className="overflow-hidden rounded-lg border border-black/10">
                                <table className="w-full border-collapse text-left text-sm">
                                  <thead className="bg-black/5 text-black/60">
                                    <tr>
                                      <th className="pl-3 pr-2 py-1.5 font-medium text-xs w-[40%]">主播</th>
                                      <th className="px-2 py-1.5 font-medium text-xs text-center w-[20%]">数量</th>
                                      <th className="px-2 py-1.5 font-medium text-xs text-right w-[40%]">日期</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {stat.castleStats.map((castleStat) => (
                                      <tr
                                        key={castleStat.ruid}
                                        className="border-t border-black/10 bg-white cursor-pointer hover:bg-black/5 transition"
                                        onClick={() => {
                                          setSelectedCastleStat(castleStat);
                                          setSelectedCastleGift(stat.castleGift);
                                          setShowCastleModal(true);
                                        }}
                                      >
                                        <td className="pl-3 pr-2 py-1.5 font-medium text-sm">{castleStat.rname}</td>
                                        <td className="px-2 py-1.5 text-center text-sm">{castleStat.totalCount}</td>
                                        <td className="px-2 py-1.5 text-right">
                                          <div className="flex flex-col items-end">
                                            {castleStat.dates.length === 1 && (
                                              <span className="text-xs text-black/50">{castleStat.dates[0].date.replace(/-/g, ".")}</span>
                                            )}
                                            {castleStat.dates.length === 2 && (
                                              <>
                                                <span className="text-xs text-black/50">{castleStat.dates[1].date.replace(/-/g, ".")}</span>
                                                <span className="text-xs text-black/50">{castleStat.dates[0].date.replace(/-/g, ".")}</span>
                                              </>
                                            )}
                                            {castleStat.dates.length > 2 && (
                                              <>
                                                <span className="text-xs text-black/50">{castleStat.dates[castleStat.dates.length - 1].date.replace(/-/g, ".")}</span>
                                                <span className="text-[10px] text-black/30">......</span>
                                                <span className="text-xs text-black/50">{castleStat.dates[0].date.replace(/-/g, ".")}</span>
                                              </>
                                            )}
                                          </div>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {blindBoxStats.length === 0 && (
                      <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4">
                        <div className="text-sm text-black/35">暂无盲盒记录</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-black/45">
                    正在加载盲盒统计...
                  </div>
                )}
              </>
            )}

            {/* Synthesis tab */}
            {activeTab === "synthesis" && synthesisStats ? (
              <>
                {synthesisStats.activities.length > 0 ? (
                  synthesisStats.activities.map((activity) => (
                    <SynthesisActivityCard key={activity.id} activity={activity} />
                  ))
                ) : (
                  <div className="rounded-xl border border-black/10 bg-[#f9f4ea] p-6 shadow-[0_20px_80px_rgba(31,28,23,0.08)]">
                    <div className="text-xs uppercase tracking-[0.2em] text-black/45">当前活动</div>
                    <div className="mt-2 text-sm text-black/45">当前无合成活动</div>
                  </div>
                )}

                <div className="mt-4 rounded-xl border border-black/10 bg-[#eef3fb] p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)]">
                  <div className="flex items-center justify-between">
                    <div className="textsm font-bold uppercase tracking-[0.15em] text-black/70">历史总盈亏</div>
                    <button
                      onClick={() => setShowHistoricalDebug(!showHistoricalDebug)}
                      className="text-xs text-black/40 hover:text-black/70 transition underline"
                    >
                      {showHistoricalDebug ? "收起调试" : "调试"}
                    </button>
                  </div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold">{formatProfit(synthesisStats.historical.profit)}</span>
                    <span className={`text-sm font-medium ${synthesisStats.historical.profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                      {synthesisStats.historical.profit >= 0 ? "赚" : "亏"}
                    </span>
                  </div>
                  <div className="mt-3 overflow-hidden">
                    <div className="text-xs text-black/70 font-medium whitespace-nowrap overflow-x-auto scrollbar-none">
                      {synthesisStats.historical.totalEarned}-{synthesisStats.historical.totalSpent}=<span className={synthesisStats.historical.profit >= 0 ? "text-green-600 font-bold" : "text-red-500 font-bold"}>{formatProfit(synthesisStats.historical.profit)}</span>电池 | 合成 {synthesisStats.historical.synthesisCount} 个礼物
                    </div>
                  </div>

                  {/* Historical debug */}
                  {showHistoricalDebug && (
                    <div className="mt-4 border-t border-black/10 pt-3">
                      {/* 天选礼物列表 */}
                      {synthesisStats.tianxuanGifts && synthesisStats.tianxuanGifts.length > 0 && (
                        <div className="mb-3 text-xs text-black/70">
                          <span className="font-medium">当前天选礼物列表（{synthesisStats.tianxuanGifts.length}个）：</span>
                          {synthesisStats.tianxuanGifts.map((g) => (
                            <span key={g.id} className="ml-1 inline-block rounded bg-black/5 px-1.5 py-0.5">
                              id:{g.id} {g.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* 红包礼物列表 */}
                      {synthesisStats.redPocketGifts && synthesisStats.redPocketGifts.length > 0 && (
                        <div className="mb-3 text-xs text-black/70">
                          <span className="font-medium">当前红包礼物列表（{synthesisStats.redPocketGifts.length}个）：</span>
                          {synthesisStats.redPocketGifts.map((g) => (
                            <span key={g.id} className="ml-1 inline-block rounded bg-red-50 px-1.5 py-0.5">
                              id:{g.id} {g.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {synthesisStats.historical.detailedRecords && (
                      <>
                      <div className="text-xs text-black/50 mb-2">
                        合成次数: {synthesisStats.historical.synthesisCount} | 
                        礼物种类: {(synthesisStats.historical as any).giftList?.length || 0} | 
                        明细记录: {(synthesisStats.historical as any).detailedRecords.length} | 
                        总花费: {synthesisStats.historical.totalSpent} | 
                        总收益: {synthesisStats.historical.totalEarned}
                      </div>
                      <div className="overflow-x-auto rounded-lg border border-black/10 max-h-[50vh] overflow-y-auto">
                        <table className="w-full border-collapse text-left text-xs">
                          <thead className="bg-black/5 text-black/50 sticky top-0">
                            <tr>
                              <th className="pl-2 pr-1 py-1 font-medium">#</th>
                              <th className="px-1 py-1 font-medium">礼物</th>
                              <th className="px-1 py-1 font-medium">名称</th>
                              <th className="px-1 py-1 font-medium">gift_id</th>
                              <th className="px-1 py-1 font-medium">coin_type</th>
                              <th className="px-1 py-1 font-medium text-right whitespace-nowrap">单价</th>
                              <th className="px-1 py-1 font-medium text-right whitespace-nowrap">数量</th>
                              <th className="px-1 py-1 font-medium text-right whitespace-nowrap">总价值</th>
                              <th className="px-1 py-1 font-medium">主播</th>
                              <th className="px-1 py-1 font-medium">日期</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(synthesisStats.historical as any).detailedRecords.map((r: any, i: number) => (
                              <tr key={i} className="border-t border-black/5 bg-green-50/50">
                                <td className="pl-2 pr-1 py-1 text-black/40">{i + 1}</td>
                                <td className="px-1 py-1">
                                  {r.gift_img ? <img src={fixImageUrl(r.gift_img)} alt="" className="w-5 h-5 rounded" /> : "-"}
                                </td>
                                <td className="px-1 py-1 font-medium">{r.gift_name}</td>
                                <td className="px-1 py-1 text-black/40 text-[10px]">{r.gift_id ?? "-"}</td>
                                <td className="px-1 py-1 text-black/40 text-[10px]">{r.coin_type || "(空)"}</td>
                                <td className="px-1 py-1 text-right whitespace-nowrap">{r.gift_price}</td>
                                <td className="px-1 py-1 text-right whitespace-nowrap">×1</td>
                                <td className="px-1 py-1 text-right whitespace-nowrap">{r.gift_price}</td>
                                <td className="px-1 py-1">{r.rname || `ID:${r.ruid}`}</td>
                                <td className="px-1 py-1 text-black/50">{r.date}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      </>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : activeTab === "synthesis" ? (
              <div className="rounded-xl border border-black/10 bg-white/80 p-6 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-center">
                <div className="text-sm text-black/45">
                  正在加载合成统计...
                </div>
              </div>
            ) : null}

            {/* 其他数据 tab */}
            {activeTab === "other" && otherStats && (
              <div className="space-y-4">
                {/* Card 1: 天选/红包礼物统计 */}
                <article className="rounded-xl border border-black/10 bg-white/80 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-base font-bold tracking-tight">天选&红包礼物</h3>
                    {otherStats.giftStats.hasLuckyTitle && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-yellow-400 bg-yellow-50 px-2 py-0.5 text-xs font-medium cursor-help"
                        title="天选或红包中过水晶球以上礼物🎉"
                      >
                        <span>🎯</span>
                        <span className="text-yellow-700">天选之子</span>
                      </span>
                    )}
                    {otherStats.dateRange && (
                      <span className="ml-auto text-xs text-black/40">
                        {otherStats.dateRange.start.replace(/-/g, ".")} - {otherStats.dateRange.end.replace(/-/g, ".")}
                      </span>
                    )}
                  </div>
                  {otherStats.giftStats.gifts.length > 0 ? (
                    <>
                      <div className="grid grid-cols-3 gap-2 mb-2">
                        <div className="rounded-lg border border-black/10 bg-[#f5f0f7] p-2 text-center">
                          <div className="text-[10px] text-black/45">礼物种类</div>
                          <div className="text-lg font-semibold">{otherStats.giftStats.gifts.length}</div>
                        </div>
                        <div className="rounded-lg border border-black/10 bg-[#f5f0f7] p-2 text-center">
                          <div className="text-[10px] text-black/45 flex items-center justify-center gap-0.5">
                            总数量
                            <span
                              className="w-3 h-3 rounded-full bg-black/10 text-black/40 text-[8px] flex items-center justify-center cursor-help"
                              title="如果自己发出的红包有剩余礼物，会返还到自己包裹，也会算进去，但天选是准确的"
                            >?</span>
                          </div>
                          <div className="text-lg font-semibold">{otherStats.giftStats.totalCount}</div>
                        </div>
                        <div className="rounded-lg border border-black/10 bg-[#f5f0f7] p-2 text-center">
                          <div className="text-[10px] text-black/45">总价值(电池)</div>
                          <div className="text-lg font-semibold">{otherStats.giftStats.totalValue.toLocaleString()}</div>
                        </div>
                      </div>
                      <div className="overflow-hidden rounded-lg border border-black/10">
                        <table className="w-full border-collapse text-left text-sm">
                          <thead className="bg-black/5 text-black/60">
                            <tr>
                              <th className="pl-3 pr-2 py-1.5 font-medium text-xs w-[45%]">礼物</th>
                              <th className="px-2 py-1.5 font-medium text-xs text-right w-[15%]">单价</th>
                              <th className="px-2 py-1.5 font-medium text-xs text-right w-[15%]">数量</th>
                              <th className="px-2 py-1.5 font-medium text-xs text-right w-[25%]">小计</th>
                            </tr>
                          </thead>
                          <tbody>
                            {otherStats.giftStats.gifts.map((gift) => (
                              <tr key={gift.gift_id} className="border-t border-black/10 bg-white">
                                <td className="pl-3 pr-2 py-1.5">
                                  <div className="flex items-center gap-1.5">
                                    {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-4 h-4 rounded flex-shrink-0" />}
                                    <span className="font-medium text-xs truncate">{gift.gift_name}</span>
                                  </div>
                                </td>
                                <td className="px-2 py-1.5 text-right text-xs">{gift.unitPrice}</td>
                                <td className="px-2 py-1.5 text-right text-xs">{gift.totalNum}</td>
                                <td className="px-2 py-1.5 text-right text-xs">{gift.totalValue}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3">
                      <div className="text-xs text-black/35">暂无天选或红包礼物记录</div>
                    </div>
                  )}
                </article>

                {/* Card 2: 送礼天数统计 */}
                <article className="rounded-xl border border-black/10 bg-white/80 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="text-base font-bold tracking-tight">送礼天数</h3>
                    {(otherStats.dayStats.maxConsecutiveDays >= 100 || otherStats.dayStats.maxDaysInYear >= 300) && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-orange-400 bg-orange-50 px-2 py-0.5 text-xs font-medium cursor-help"
                        title={otherStats.dayStats.maxConsecutiveDays >= 100
                          ? `${otherStats.dayStats.maxConsecutiveStart.replace(/-/g, ".")} - ${otherStats.dayStats.maxConsecutiveEnd.replace(/-/g, ".")}，连续 ${otherStats.dayStats.maxConsecutiveDays} 天送礼，一天不刷浑身难受🎉`
                          : `${otherStats.dayStats.maxDaysInYearRange.start.replace(/-/g, ".")} - ${otherStats.dayStats.maxDaysInYearRange.end.replace(/-/g, ".")}，365天内 ${otherStats.dayStats.maxDaysInYear} 天活跃🎉`}
                      >
                        <span>🏠</span>
                        <span className="text-orange-700">住在直播间</span>
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3">
                      <div className="text-xs text-black/70">总送礼天数</div>
                      <div className="mt-1 text-2xl font-semibold">{otherStats.dayStats.totalDays} <span className="text-sm font-normal text-black/45">天</span></div>
                    </div>
                    <div className="rounded-lg border border-black/10 bg-[#eef3fb] p-3">
                      <div className="text-xs text-black/70">连续送礼最长</div>
                      <div className="mt-1 text-2xl font-semibold">{otherStats.dayStats.maxConsecutiveDays} <span className="text-sm font-normal text-black/45">天</span></div>
                      {otherStats.dayStats.maxConsecutiveDays > 0 && (
                        <div className="text-xs text-black/60 mt-1">
                          {otherStats.dayStats.maxConsecutiveStart.replace(/-/g, ".")} - {otherStats.dayStats.maxConsecutiveEnd.replace(/-/g, ".")}
                        </div>
                      )}
                    </div>
                  </div>

                  <hr className="border-t border-black/10 my-4" />

                  <h3 className="text-base font-bold tracking-tight mb-3">主播送礼详情</h3>
                  {otherStats.roomStats.length > 0 ? (
                    <div className="space-y-2">
                      {otherStats.roomStats.slice(0, 10).map((room) => {
                        const hasGuardTitle = room.maxConsecutiveDays >= 30 || room.maxDaysInYear >= 200;
                        return (
                          <div key={room.ruid} className="rounded-lg border border-black/10 bg-white p-3">
                            <div className="flex items-center justify-between mb-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{room.rname}</span>
                                {hasGuardTitle && (
                                  <span
                                    className="inline-flex items-center gap-0.5 rounded-full border border-pink-400 bg-pink-50 px-1.5 py-0.5 text-[10px] font-medium cursor-help"
                                    title={room.maxConsecutiveDays >= 30
                                      ? `${room.maxConsecutiveStart.replace(/-/g, ".")} - ${room.maxConsecutiveEnd.replace(/-/g, ".")}，连续 ${room.maxConsecutiveDays} 天对TA送礼🎉`
                                      : `${room.maxDaysInYearRange.start.replace(/-/g, ".")} - ${room.maxDaysInYearRange.end.replace(/-/g, ".")}，365天内 ${room.maxDaysInYear} 天对TA送礼🎉`}
                                  >
                                    <span>🛡️</span>
                                    <span className="text-pink-700">爱的守护</span>
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-black/45">{room.totalDays} 天</span>
                            </div>
                            {room.maxDaysInYear > 0 && (
                              <div className="text-xs text-black/55">
                                过去1年有 <b className="text-black/80">{room.maxDaysInYear}</b> 天给TA送过礼物
                              </div>
                            )}
                            <div className="flex items-center gap-4 text-xs text-black/55 mt-0.5">
                              <span>连续最长 <b className="text-black/80">{room.maxConsecutiveDays}</b> 天给TA送过礼物</span>
                              {room.maxConsecutiveDays > 0 && (
                                <span className="text-black/40">{room.maxConsecutiveStart.replace(/-/g, ".")} - {room.maxConsecutiveEnd.replace(/-/g, ".")}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3">
                      <div className="text-xs text-black/35">暂无主播记录</div>
                    </div>
                  )}
                </article>
              </div>
            )}
            {activeTab === "other" && !otherStats && (
              <article className="rounded-xl border border-black/10 bg-white/80 p-6 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-center">
                <div className="text-sm text-black/45">正在加载其他数据...</div>
              </article>
            )}
          </section>
        </div>
      )}

      {/* 主播数据 - 保持挂载避免切换闪烁 */}
      <div style={{ display: activeModule === "anchor" ? "block" : "none" }}>
        <AnchorDataModule
          key={currentAccount?.sid ?? "no-account"}
          anchorName={currentAccount?.uname ?? ""}
          anchorFace={currentAccount?.face ?? ""}
        />
      </div>

      {/* B站小工具 */}
      {activeModule === "screenshot" && (
        <div className="mx-auto w-full max-w-4xl px-2 min-w-0">
          {toolsPage === "home" && (
              <div className="grid grid-cols-1 gap-3">
                {[
                  { icon: "🧹", title: "粉丝清理", desc: "管理粉丝列表，一键清理非互关粉丝或批量移除指定粉丝", action: () => { setToolsPage("fans"); loadFans(1); } },
                  { icon: "🏅", title: "粉丝牌清理", desc: "管理粉丝勋章，批量清理粉丝牌，不用读秒等待", action: () => { setToolsPage("medal"); loadMedals(1); } },
                  { icon: "📸", title: "复活曲截图", desc: "复活曲倒计时投屏 + 自动截图，直播多人局必备工具", action: () => setToolsPage("screenshot") },
                ].map((tool) => (
                  <button
                    key={tool.title}
                    onClick={tool.action}
                    className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur text-left transition hover:border-black/20 hover:shadow-lg"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{tool.icon}</span>
                      <div>
                        <h3 className="text-base font-bold">{tool.title}</h3>
                        <p className="mt-0.5 text-xs text-black/45">{tool.desc}</p>
                      </div>
                      <svg className="w-4 h-4 text-black/30 ml-auto flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* 粉丝清理 */}
            {activeModule === "screenshot" && toolsPage === "fans" && (
              <div className="space-y-3">
                {/* 返回 + 操作栏 */}
                <div className="flex items-center gap-4 py-1">
                  <button onClick={() => { setToolsPage("home"); setFansList([]); setFansSelectMode(false); setFansSelected(new Set()); setFansMsg(""); }} className="flex items-center gap-1 text-xs text-black/50 hover:text-black/80 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
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
                  <button onClick={() => { setToolsPage("home"); setMedalsList([]); setMedalsMsg(""); setMedalsSelectMode(false); setMedalsSelected(new Set()); }} className="flex items-center gap-1 text-xs text-black/50 hover:text-black/80 transition">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
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
                  <button onClick={() => setToolsPage("home")} className="flex items-center gap-1 text-xs text-black/50 hover:text-black/80 transition">
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
      )}

      {/* Loading Overlay - only covers content area, header above is still clickable */}
      {loading && (
        <div className="absolute inset-0 z-[9999] bg-white/70 backdrop-blur-sm flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-base font-medium text-[#1f1c17]">正在加载数据...</p>
            <p className="text-sm text-black/45">切换账号需要重新获取数据，请耐心等待</p>
            <p className="text-xs text-black/30">首次加载可能需要几分钟</p>
          </div>
        </div>
      )}

      </div> {/* End of scrollable content area */}

      {/* Bottom Navigation - fixed at bottom */}
      <nav className="fixed bottom-0 left-0 right-0 mx-auto w-full max-w-4xl flex items-center justify-around px-4 py-1.5 bg-[#e8e8e8] rounded-t-xl border-t border-black/10 z-50">
        {([
          { key: "revenue", label: "粉丝消费", icon: "📊" },
          { key: "anchor", label: "主播数据", icon: "📈" },
          { key: "screenshot", label: "其他工具", icon: "🧰" },
        ] as const).map((mod) => (
          <button
            key={mod.key}
            onClick={() => {
              setActiveModule(mod.key);
              if (mod.key !== "screenshot") setToolsPage("home");
            }}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition min-w-0 ${
              activeModule === mod.key
                ? "text-[#1f1c17]"
                : "text-black/40 hover:text-black/70"
            }`}
          >
            <span className="text-lg leading-none">{mod.icon}</span>
            <span className={`text-[10px] leading-none ${activeModule === mod.key ? "font-semibold" : ""}`}>{mod.label}</span>
          </button>
        ))}
      </nav>

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