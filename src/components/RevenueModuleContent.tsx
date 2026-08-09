"use client";

import React from "react";
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { BLIND_BOX_CONFIG } from "@/lib/config";
import { getBlindBoxCardBg, HISTORICAL_PNL_BG } from "@/lib/layout";
import SynthesisActivityCard from "@/components/SynthesisActivityCard";
import PieTooltip from "@/components/PieTooltip";
import Dropdown from "@/components/Dropdown";

// ===== Type definitions =====
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
  historical: {
    totalSpent: number;
    totalEarned: number;
    profit: number;
    drawCount: number;
    replaceCount: number;
    synthesisCount: number;
    successCount: number;
    detailedRecords?: any[];
    giftList?: any[];
    anchorStats?: Array<{ ruid: number; rname: string; count: number; value: number; spent: number; profit: number }>;
  };
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

type Account = {
  sid: string;
  uname: string;
  mid: number;
  face?: string;
  source: "qr" | "dev";
  updatedAt: string;
};

// ===== Props interface =====
interface RevenueModuleContentProps {
  // Data
  snapshot: Snapshot | null;
  activeTab: "overview" | "blindbox" | "synthesis" | "other";
  syncing: boolean;
  loading: boolean;
  isLocalAccount: boolean;
  lastRefreshTime: string;
  consumptionCoins: number;
  consumptionCount: number;
  giftTypeCount: number;
  overviewAnchors: Array<{ ruid: number; rname: string; coins: number }>;
  recentRecords: Array<{
    id: number;
    gift_num: number;
    gift_name: string;
    gift_img: string;
    ruid: number;
    r_uname: string;
    timestamp: number;
  }>;
  isRealSnapshot: boolean;
  monthlyData: MonthlyData[];
  selectedMonth: string | null;
  selectedDay: number | null;
  calendarData: { year: number; month: number; weeks: Array<Array<{ day: number | null; coins: number }>> } | null;
  maxDayCoins: number;
  periodAnchors: Array<{ ruid: number; rname: string; coins: number }>;
  overviewAnchor: string;
  pieActive: { chart: "all" | "period"; index: number } | null;
  pieIsMobile: boolean;
  pieTipPos: { x: number; y: number };
  monthGiftSummaryNew: Array<{ uid: string; gift_id: number; gift_name: string; gift_img: string; count: number; coins: number; displayCoins: number }>;
  giftListSpendingTotal: number;
  actualDateRange: { start: string; end: string } | null;
  showGiftSaveModal: boolean;
  blindBoxStats: BlindBoxStats | null;
  blindBoxFilters: Record<number, { ruid: string; dateRange: string }>;
  certifications: Certification[];
  showCertModal: boolean;
  certModalIndex: number;
  selectedCastleStat: CastleStat | null;
  selectedCastleGift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null;
  showCastleModal: boolean;
  synthesisStats: SynthesisStats | null;
  showHistoricalDebug: boolean;
  otherStats: OtherStats | null;
  showStatsRules: boolean;
  showGiftListRules: boolean;
  currentAccount: Account | null;

  // Refs
  statsRulesRef: React.RefObject<HTMLDivElement | null>;
  giftListRulesRef: React.RefObject<HTMLDivElement | null>;

  // Callbacks
  setActiveTab: (tab: "overview" | "blindbox" | "synthesis" | "other") => void;
  refreshData: () => void;
  setSelectedMonth: (month: string | null) => void;
  setSelectedDay: (day: number | null) => void;
  setOverviewAnchor: (anchor: string) => void;
  setPieActive: (active: { chart: "all" | "period"; index: number } | null) => void;
  setPieTipPos: (pos: { x: number; y: number }) => void;
  setShowStatsRules: (show: boolean) => void;
  setShowGiftListRules: (show: boolean) => void;
  setShowGiftSaveModal: (show: boolean) => void;
  setShowCertModal: (show: boolean) => void;
  setCertModalIndex: (index: number) => void;
  setSelectedCastleStat: (stat: CastleStat | null) => void;
  setSelectedCastleGift: (gift: { gift_id: number; gift_name: string; gift_img: string; price: number } | null) => void;
  setShowCastleModal: (show: boolean) => void;
  setShowHistoricalDebug: (show: boolean) => void;
  handleDateFilter: (blindBoxId: number, dateRange: string) => void;
  handleAnchorFilter: (blindBoxId: number, ruid: string) => void;
  openAnchorBubbleChart: () => void;

  // Utility functions
  showToast: (msg: string) => void;
  downloadJsonFile: () => void;
  formatTimestamp: (ts: number) => string;
  formatDateShort: (dateStr: string) => string;
  monthLabel: (ym: string) => string;
  formatCoinsShort: (coins: number) => string;
  fixImageUrl: (url: string) => string;
  formatProfit: (coins: number) => string;
}

function RevenueModuleContentInner(props: RevenueModuleContentProps) {
  const {
    snapshot,
    activeTab,
    syncing,
    loading,
    isLocalAccount,
    lastRefreshTime,
    consumptionCoins,
    consumptionCount,
    giftTypeCount,
    overviewAnchors,
    recentRecords,
    isRealSnapshot,
    monthlyData,
    selectedMonth,
    selectedDay,
    calendarData,
    maxDayCoins,
    periodAnchors,
    overviewAnchor,
    pieActive,
    pieIsMobile,
    pieTipPos,
    monthGiftSummaryNew,
    giftListSpendingTotal,
    actualDateRange,
    showGiftSaveModal,
    blindBoxStats,
    blindBoxFilters,
    certifications,
    synthesisStats,
    showHistoricalDebug,
    otherStats,
    showStatsRules,
    showGiftListRules,
    statsRulesRef,
    giftListRulesRef,
    setActiveTab,
    refreshData,
    setSelectedMonth,
    setSelectedDay,
    setOverviewAnchor,
    setPieActive,
    setPieTipPos,
    setShowStatsRules,
    setShowGiftListRules,
    setShowGiftSaveModal,
    setShowCertModal,
    setCertModalIndex,
    setSelectedCastleStat,
    setSelectedCastleGift,
    setShowCastleModal,
    setShowHistoricalDebug,
    handleDateFilter,
    handleAnchorFilter,
    openAnchorBubbleChart,
    showToast,
    downloadJsonFile,
    formatTimestamp,
    formatDateShort,
    monthLabel,
    formatCoinsShort,
    fixImageUrl,
    formatProfit,
  } = props;

  return (
    <>
      {/* Loading state (only for revenue module) */}
      {!snapshot && (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-[#1f1c17] border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm text-black/45">加载中...</p>
          </div>
        </div>
      )}

      {/* Content - Revenue module */}
      {snapshot && (
        <div className="content-wrapper px-2 min-w-0 py-3">
        {/* L3 Tab bar - segmented control, sticky at top, 整体居中 */}
          <div className="flex items-center justify-center gap-2.5 px-4 py-2 mb-2 sticky top-0 bg-[#f5f5f5]/95 backdrop-blur z-10">
            {/* 分段按钮组（宽度覆盖页面 80%，更扁；按钮均分） */}
            <div className="flex items-center rounded-full border border-black/10 bg-white/85 p-1 shadow-sm shrink-0 w-[80%] max-w-[800px]">
              {(["overview", "blindbox", "synthesis", "other"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 rounded-full px-2 py-1 text-sm font-medium transition-all ${
                    activeTab === tab
                      ? "bg-[#1f1c17] text-white shadow-sm"
                      : "text-black/65 hover:bg-black/5"
                  }`}
                >
                  {tab === "overview" ? "消费" : tab === "blindbox" ? "盲盒" : tab === "synthesis" ? "合成" : "其他"}
                </button>
              ))}
            </div>
            {/* 刷新按钮（右侧）：缺口弧形边框；同步中显示三点动画，否则显示时间/“刷新” */}
            <div className="shrink-0">
              <button
                onClick={() => {
                  if (!isLocalAccount) {
                    showToast("非本机登录账号，没有登录凭证，无法更新数据");
                    return;
                  }
                  refreshData();
                }}
                disabled={syncing || loading || !isLocalAccount}
                className={`refresh-btn-arc relative flex items-center justify-center h-[34px] w-[34px] ${!isLocalAccount ? "opacity-40" : ""}`}
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
        <section className="grid gap-6 content-wrapper">
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
                  <div className="mt-1 text-xl font-semibold">{consumptionCount.toLocaleString()}</div>
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
                      <button
                        onClick={() => downloadJsonFile()}
                        className="rounded-full border border-[#1f1c17] px-3 py-0.5 text-xs font-medium text-[#1f1c17] transition hover:bg-black/5 active:scale-95"
                      >
                        下载全部数据
                      </button>
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

                    return (
                      <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none">
                        <div className="text-[10px] text-black/45">月度统计</div>
                        <div className="overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
                          <div style={{ width: "100%", minWidth: `${minWidth}px` }}>
                            <ResponsiveContainer width="100%" height={170} minWidth={0}>
                              <BarChart data={monthlyData} margin={{ top: 16, right: 2, left: 2, bottom: 2 }}>
                                <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 10, fill: "#888" }} axisLine={{ stroke: "#e5e0d8" }} tickLine={false} />
                                <Bar dataKey="coins" radius={[3, 3, 0, 0]} barSize={barWidth} isAnimationActive={false} activeBar={false}
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
                        const result: Array<{ rname: string; coins: number; ruid: number | null; fill: string; battery: number }> = [];
                        let otherCoins = 0;
                        for (let i = 0; i < anchors.length; i++) {
                          if (i < TOP_N) {
                            result.push({ rname: anchors[i].rname, coins: anchors[i].coins, ruid: anchors[i].ruid, fill: pieColors[i % pieColors.length], battery: anchors[i].coins });
                          } else {
                            otherCoins += anchors[i].coins;
                          }
                        }
                        if (otherCoins > 0) {
                          result.push({ rname: "其他", coins: otherCoins, ruid: null, fill: "#94a3b8", battery: otherCoins });
                        }
                        return result;
                      };
                      const allTimePieData = buildPieData(overviewAnchors);
                      return (
                        <>
                          <div className="text-[10px] text-black/45">全部时期</div>
                          <div className="outline-none [&_*]:outline-none [&_*]:focus:outline-none -mx-1" style={{ height: 170 }}>
                            <ResponsiveContainer width="100%" height={170}>
                              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                <Pie
                                  data={allTimePieData}
                                  dataKey="coins"
                                  nameKey="rname"
                                  cx="50%"
                                  cy="50%"
                                  outerRadius="95%"
                                  paddingAngle={0}
                                  isAnimationActive={false}
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  onClick={(data: any, index: number, e: any) => {
                                    if (data?.ruid !== null && data?.ruid !== undefined) {
                                      const ruidStr = String(data.ruid);
                                      setOverviewAnchor(ruidStr === overviewAnchor ? "" : ruidStr);
                                      setSelectedDay(null);
                                    }
                                    // 点击扇形：选中/取消选中。移动端只有选中才显示提示框
                                    setPieActive(pieActive?.chart === "all" && pieActive?.index === index ? null : { chart: "all", index });
                                    // 记录点击位置，用于移动端提示框定位（约束在视口内）
                                    const pt = (e as any)?.clientX;
                                    if (typeof pt === "number") {
                                      setPieTipPos({ x: (e as any).clientX, y: (e as any).clientY });
                                    }
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
                                      name: allTimePieData[pieActive.index].rname,
                                      value: allTimePieData[pieActive.index].coins,
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

                    {/* Second pie: period anchors (visible when month selected) */}
                    {selectedMonth && periodAnchors.length > 0 && (() => {
                      const pieColors = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#ea580c", "#4f46e5", "#0d9488", "#c026d3", "#f59e0b", "#10b981", "#6366f1", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#e11d48", "#0284c7", "#b91c1c", "#047857", "#b45309", "#6d28d9"];
                      const TOP_N = 20;
                      const buildPieData = (anchors: Array<{ ruid: number; rname: string; coins: number }>) => {
                        const result: Array<{ rname: string; coins: number; ruid: number | null; fill: string; battery: number }> = [];
                        let otherCoins = 0;
                        for (let i = 0; i < anchors.length; i++) {
                          if (i < TOP_N) {
                            result.push({ rname: anchors[i].rname, coins: anchors[i].coins, ruid: anchors[i].ruid, fill: pieColors[i % pieColors.length], battery: anchors[i].coins });
                          } else {
                            otherCoins += anchors[i].coins;
                          }
                        }
                        if (otherCoins > 0) {
                          result.push({ rname: "其他", coins: otherCoins, ruid: null, fill: "#94a3b8", battery: otherCoins });
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
                            <ResponsiveContainer width="100%" height={170}>
                              <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                                <Pie
                                  data={periodPieData}
                                  dataKey="coins"
                                  nameKey="rname"
                                  cx="50%"
                                  cy="50%"
                                  outerRadius="95%"
                                  paddingAngle={0}
                                  isAnimationActive={false}
                                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                  onClick={(data: any, index: number, e: any) => {
                                    if (data?.ruid !== null && data?.ruid !== undefined) {
                                      const ruidStr = String(data.ruid);
                                      setOverviewAnchor(ruidStr === overviewAnchor ? "" : ruidStr);
                                      setSelectedDay(null);
                                    }
                                    // 点击扇形：选中/取消选中。移动端只有选中才显示提示框
                                    setPieActive(pieActive?.chart === "period" && pieActive?.index === index ? null : { chart: "period", index });
                                    const pt = (e as any)?.clientX;
                                    if (typeof pt === "number") {
                                      setPieTipPos({ x: (e as any).clientX, y: (e as any).clientY });
                                    }
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
                                      name: periodPieData[pieActive.index].rname,
                                      value: periodPieData[pieActive.index].coins,
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

                    {/* Anchor dropdown - uses periodAnchors when date selected, else overviewAnchors */}
                    <div className="mt-1">
                      <Dropdown
                        value={overviewAnchor}
                        onChange={(v) => { setOverviewAnchor(v); setSelectedDay(null); }}
                        placeholder="全部主播（电池）"
                        className="w-full rounded border border-black/10 bg-white px-2 py-1 text-xs text-black/80 outline-none"
                        options={[
                          { value: "", label: "全部主播（电池）" },
                          ...(selectedMonth ? periodAnchors : overviewAnchors).map((a) => ({
                            value: String(a.ruid),
                            label: `${a.rname} (${a.coins})`,
                          })),
                        ]}
                      />
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
                          <div className="mt-1">电池数 = 实际消费的电池，所以这里的电池数并不精确等于列表中礼物的总价值。电池数以消费时间计，礼物清单以送出时间计。比如第一天花费了1万电池玩合成活动，得到了2万电池的礼物，礼物第二天送出。那么第一天电池消费1万，礼物清单没有任何礼物，第二天电池消费0，礼物清单列有2万价值的礼物。</div>
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
                      {giftListSpendingTotal}电池
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
                          <tr key={gift.uid} className="border-t border-black/10 bg-white">
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-1.5">
                                {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-4 h-4 rounded" />}
                                <span className="font-medium text-xs">{gift.gift_name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs">{Math.round(gift.displayCoins / gift.count)}</td>
                            <td className="px-3 py-1.5 text-right text-xs">{gift.count}</td>
                            <td className="px-3 py-1.5 text-right text-xs">{gift.displayCoins}</td>
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
                  {blindBoxStats.map((stat, boxIndex) => {
                    const currentFilter = blindBoxFilters[stat.blindBoxId] ?? { ruid: "", dateRange: "all" };
                    const isXindong = stat.blindBoxId === 32251;
                    const cardBg = getBlindBoxCardBg(boxIndex);
                    return (
                      <div key={stat.blindBoxId} className={`rounded-lg border border-black/10 p-2 ${cardBg}`}>
                        {/* Row 1: 盲盒图标+名称 + 统计时间 */}
                        <div className="flex items-center gap-2 mb-2">
                          {(stat.blindBoxImg || BLIND_BOX_CONFIG.icons[stat.blindBoxId]) && (
                            <img src={stat.blindBoxImg || BLIND_BOX_CONFIG.icons[stat.blindBoxId]} alt="" className="w-6 h-6 rounded" />
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
                          <Dropdown
                            value={currentFilter.ruid}
                            onChange={(v) => handleAnchorFilter(stat.blindBoxId, v)}
                            className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/65 outline-none"
                            options={[
                              { value: "", label: "全部主播" },
                              ...stat.anchors.map((a) => ({
                                value: String(a.ruid),
                                label: `${a.rname} (${a.count})`,
                              })),
                            ]}
                          />
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
                synthesisStats.activities.map((activity, actIndex) => (
                  <SynthesisActivityCard key={activity.id} activity={activity} index={actIndex} />
                ))
              ) : (
                <div className="rounded-xl border border-black/10 bg-[#f9f4ea] p-6 shadow-[0_20px_80px_rgba(31,28,23,0.08)]">
                  <div className="text-xs uppercase tracking-[0.2em] text-black/45">当前活动</div>
                  <div className="mt-2 text-sm text-black/45">当前无合成活动</div>
                </div>
              )}

              <div className={`mt-4 rounded-xl border border-black/10 ${HISTORICAL_PNL_BG} p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)]`}>
                <div className="flex items-center justify-between">
                  <div className="textsm font-bold uppercase tracking-[0.15em] text-black/70">历史总盈亏</div>
                  <button
                    onClick={() => setShowHistoricalDebug(!showHistoricalDebug)}
                    className="text-xs text-black/40 hover:text-black/70 transition underline"
                  >
                    {showHistoricalDebug ? "收起调试" : "调试"}
                  </button>
                </div>
                <div className="mt-3">
                  <div className="text-lg font-semibold whitespace-nowrap overflow-x-auto scrollbar-none">
                    {synthesisStats.historical.totalEarned}-{synthesisStats.historical.totalSpent}=<span className={synthesisStats.historical.profit >= 0 ? "text-green-600 font-bold" : "text-red-500 font-bold"}>{formatProfit(synthesisStats.historical.profit)}</span>电池
                  </div>
                  <div className="mt-1 text-xs text-black/50">共合成 {synthesisStats.historical.synthesisCount} 个礼物</div>
                </div>

                {/* 各主播直播间盈亏 */}
                {synthesisStats.historical.anchorStats && synthesisStats.historical.anchorStats.length > 0 && (
                  <div className="mt-4">
                    <div className="text-xs font-medium text-black/70 mb-2">各主播直播间盈亏</div>
                    <div className="overflow-x-auto rounded-lg border border-black/10">
                      <table className="w-full border-collapse text-left text-xs">
                        <thead className="bg-black/5 text-black/50">
                          <tr>
                            <th className="pl-2 pr-1 py-1 font-medium">主播名</th>
                            <th className="px-1 py-1 font-medium text-right">数目</th>
                            <th className="px-1 py-1 font-medium text-right">价值</th>
                            <th className="px-1 py-1 font-medium text-right">花费</th>
                            <th className="px-1 py-1 font-medium text-right">盈亏</th>
                          </tr>
                        </thead>
                        <tbody>
                          {synthesisStats.historical.anchorStats.map((a) => (
                            <tr key={a.ruid} className="border-t border-black/5">
                              <td className="pl-2 pr-1 py-1">{a.rname || `ID:${a.ruid}`}</td>
                              <td className="px-1 py-1 text-right tabular-nums">{a.count}</td>
                              <td className="px-1 py-1 text-right tabular-nums">{a.value}</td>
                              <td className="px-1 py-1 text-right tabular-nums">{a.spent}</td>
                              <td className={`px-1 py-1 text-right tabular-nums ${a.profit >= 0 ? "text-green-600" : "text-red-500"}`}>{formatProfit(a.profit)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

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

                <h3 className="text-base font-bold tracking-tight mb-3">给主播送礼详情</h3>
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
    </>
  );
}

export const RevenueModuleContent = React.memo(RevenueModuleContentInner);