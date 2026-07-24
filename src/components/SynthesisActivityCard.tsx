"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import type { SynthesisActivityStats } from "@/app/api/stats/synthesis/route";
import type { SynthesisGiftInfo, SynthesisDetailedRecord, SynthesisAnchorInfo } from "@/lib/gift-db";
import { toPng } from "html-to-image";

function formatProfit(profit: number): string {
  if (profit >= 0) return `+${profit}`;
  return `${profit}`;
}

function fixImageUrl(url: string): string {
  if (!url) return "";
  return url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
}

interface SynthesisActivityCardProps {
  activity: SynthesisActivityStats;
}

export default function SynthesisActivityCard({ activity }: SynthesisActivityCardProps) {
  const [selectedAnchor, setSelectedAnchor] = useState<string>("");
  const [selectedGift, setSelectedGift] = useState<SynthesisGiftInfo | null>(null);
  const [certIndex, setCertIndex] = useState(0);
  const [showCertModal, setShowCertModal] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const filteredRecords = useMemo(() => {
    if (!selectedAnchor) return activity.profit.detailedRecords;
    return activity.profit.detailedRecords.filter(r => String(r.ruid) === selectedAnchor);
  }, [selectedAnchor, activity.profit.detailedRecords]);

  const filteredStats = useMemo(() => {
    if (!selectedAnchor) {
      return activity.profit;
    }
    const anchor = activity.profit.anchors.find(a => String(a.ruid) === selectedAnchor);
    if (!anchor) return activity.profit;
    const anchorRecords = activity.profit.detailedRecords.filter(r => String(r.ruid) === selectedAnchor);
    const giftMap = new Map<string, SynthesisGiftInfo>();
    let totalEarned = 0;
    let successCount = 0;
    for (const r of anchorRecords) {
      if (r.synthetic_result === 0) continue;
      totalEarned += r.gift_price;
      successCount++;
      const key = r.gift_name;
      const existing = giftMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        giftMap.set(key, {
          gift_id: 0,
          gift_name: r.gift_name,
          gift_img: r.gift_img,
          gift_price: r.gift_price,
          count: 1,
        });
      }
    }
    return {
      ...activity.profit,
      totalSpent: anchor.totalSpent,
      totalEarned,
      profit: totalEarned - anchor.totalSpent,
      successCount,
      giftList: Array.from(giftMap.values()).sort((a, b) => a.gift_price - b.gift_price),
    };
  }, [selectedAnchor, activity.profit]);

  const totalGiftCount = filteredStats.giftList.reduce((sum, g) => sum + g.count, 0);

  // 整个卡片自适应缩放
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const MIN_CARD_WIDTH = 420;
    function applyScale() {
      const containerWidth = el!.parentElement?.clientWidth ?? el!.clientWidth;
      if (containerWidth < MIN_CARD_WIDTH) {
        el!.style.zoom = String(containerWidth / MIN_CARD_WIDTH);
      } else {
        el!.style.zoom = "";
      }
    }
    applyScale();
    const ro = new ResizeObserver(applyScale);
    ro.observe(el!.parentElement || el!);
    return () => ro.disconnect();
  }, [filteredStats.giftList]);

  const filteredCertifications = useMemo(() => {
    if (!selectedAnchor) return activity.certifications;
    return activity.certifications.filter(c => String(c.ruid) === selectedAnchor);
  }, [selectedAnchor, activity.certifications]);

  const cardBgColor = useMemo(() => {
    const colors: Record<string, string> = {
      "activity-1": "bg-[#fff7ef]",
      "activity-2": "bg-[#f0f7ee]",
      "historical": "bg-[#eef3fb]",
    };
    return colors[activity.id] || "bg-[#fff7ef]";
  }, [activity.id]);

  return (
    <div key={activity.id} ref={cardRef} className={`w-full min-w-0 rounded-xl border border-black/10 ${cardBgColor} p-3 shadow-[0_20px_80px_rgba(31,28,23,0.08)]`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {activity.icon && <img src={fixImageUrl(activity.icon)} alt="" className="w-7 h-7 rounded flex-shrink-0" />}
          <div className="text-base font-bold uppercase tracking-[0.15em] text-black/70">{activity.name}</div>
        </div>
        {filteredCertifications.length > 0 && (
          <button
            onClick={() => { setShowCertModal(true); setCertIndex(0); }}
            className="inline-flex items-center gap-1 rounded-full border border-yellow-400 bg-yellow-50 px-2 py-1 text-xs hover:bg-yellow-100 transition"
          >
            <span className="text-sm">👑</span>
            <span className="text-sm">👻</span>
            <span className="text-sm">💰</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="text-s text-black/70 font-medium whitespace-nowrap overflow-x-auto scrollbar-none flex-1 min-w-0">
            {filteredStats.totalEarned}-{filteredStats.totalSpent}=<span className={filteredStats.profit >= 0 ? "text-green-600 font-bold" : "text-red-500 font-bold"}>{filteredStats.profit >= 0 ? "+" : ""}{filteredStats.profit}</span>电池 | 合成 {totalGiftCount} 个礼物
          </div>
          <button
            onClick={() => setShowDebug(!showDebug)}
            className="text-xs text-black/40 hover:text-black/70 transition underline"
          >
            {showDebug ? "收起调试" : "调试"}
          </button>
        </div>
        <select
          value={selectedAnchor}
          onChange={(e) => setSelectedAnchor(e.target.value)}
          className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-black/65 outline-none focus:border-black/30 flex-shrink-0"
        >
          <option value="">全部主播</option>
          {activity.profit.anchors.map((anchor) => (
            <option key={anchor.ruid} value={anchor.ruid}>
              {anchor.rname || `主播${anchor.ruid}`}
            </option>
          ))}
        </select>
      </div>

      {filteredStats.giftList.length > 0 && (
        <div className="mt-4">
            <div className="rounded-lg border border-black/10 overflow-hidden">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-black/5 text-black/60">
                <tr>
                  <th className="pl-3 pr-2 py-2 font-medium whitespace-nowrap">合成礼物</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[12%]">单价</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[16%]">数目</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[12%]">价值</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[12%]">花费</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[12%]">盈亏</th>
                </tr>
              </thead>
              <tbody>
                {filteredStats.giftList
                  .sort((a, b) => a.gift_price - b.gift_price)
                  .map((gift) => {
                    const giftRecords = filteredRecords.filter(r => r.gift_name === gift.gift_name);
                    const giftCost = giftRecords.reduce((sum, r) => sum + r.spent, 0);
                    const giftProfit = (gift.gift_price * gift.count) - giftCost;
                    return (
                      <tr
                        key={`${gift.gift_id}_${gift.gift_name}`}
                        className="border-t border-black/10 bg-white hover:bg-black/5 cursor-pointer"
                        onClick={() => setSelectedGift(gift)}
                      >
                        <td className="pl-3 pr-2 py-2">
                          <div className="flex items-center gap-2">
                            {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-5 h-5 rounded flex-shrink-0" />}
                            <span className="font-medium truncate">{gift.gift_name}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right">{gift.gift_price}</td>
                        <td className="px-2 py-2 text-right">×{gift.count}</td>
                        <td className="px-2 py-2 text-right">{gift.gift_price * gift.count}</td>
                        <td className="px-2 py-2 text-right">{Math.floor(giftCost)}</td>
                        <td className={`px-2 py-2 text-right font-medium ${giftProfit >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {giftProfit >= 0 ? "+" : ""}{Math.floor(giftProfit)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Debug section */}
      {showDebug && (
        <div className="mt-4 border-t border-black/10 pt-3">
          <div className="text-xs text-black/50 mb-2">
            合成次数: {filteredRecords.filter(r => r.synthetic_result === 1).length} | 
            礼物总数: {totalGiftCount} | 
            总记录数: {filteredRecords.length} | 
            总花费: {filteredStats.totalSpent} | 
            总收益: {filteredStats.totalEarned}
          </div>
          <div className="overflow-x-auto rounded-lg border border-black/10 max-h-[50vh] overflow-y-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-black/5 text-black/50 sticky top-0">
                <tr>
                  <th className="pl-2 pr-1 py-1 font-medium">#</th>
                  <th className="px-1 py-1 font-medium">礼物</th>
                  <th className="px-1 py-1 font-medium">名称</th>
                  <th className="px-1 py-1 font-medium text-right">价值</th>
                  <th className="px-1 py-1 font-medium text-right">花费</th>
                  <th className="px-1 py-1 font-medium text-right">盈亏</th>
                  <th className="px-1 py-1 font-medium">主播</th>
                  <th className="px-1 py-1 font-medium">类型</th>
                  <th className="px-1 py-1 font-medium">日期</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((r, i) => (
                  <tr key={i} className={`border-t border-black/5 ${r.synthetic_result === 1 ? "bg-green-50/50" : "bg-red-50/30"}`}>
                    <td className="pl-2 pr-1 py-1 text-black/40">{i + 1}</td>
                    <td className="px-1 py-1">
                      {r.gift_img ? <img src={fixImageUrl(r.gift_img)} alt="" className="w-5 h-5 rounded" /> : "-"}
                    </td>
                    <td className="px-1 py-1 font-medium">{r.gift_name}</td>
                    <td className="px-1 py-1 text-right">{r.gift_price}</td>
                    <td className="px-1 py-1 text-right">{r.spent}</td>
                    <td className={`px-1 py-1 text-right ${r.profit >= 0 ? "text-green-600" : "text-red-500"}`}>{r.profit}</td>
                    <td className="px-1 py-1">{r.rname || `ID:${r.ruid}`}</td>
                    <td className="px-1 py-1">{r.synthetic_result === 1 ? "合成" : "抽取/替换"}</td>
                    <td className="px-1 py-1 text-black/50">{r.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedGift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setSelectedGift(null)}>
          <div
            className="relative mx-4 w-full max-w-md max-h-[80vh] rounded-xl border border-black/10 bg-white p-6 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setSelectedGift(null)}
              className="absolute -top-10 right-0 text-white/80 hover:text-white text-sm transition"
            >
              ✕ 关闭
            </button>
            <div className="flex items-center gap-2 mb-4 flex-shrink-0">
              {selectedGift.gift_img && <img src={fixImageUrl(selectedGift.gift_img)} alt="" className="w-8 h-8 rounded" />}
              <span className="text-lg font-bold">{selectedGift.gift_name}</span>
              <span className="text-sm text-black/50">单价 {selectedGift.gift_price}</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-black/10 flex-1 overflow-y-auto">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-gray-100 sticky top-0">
                  <tr>
                    <th className="pl-3 pr-2 py-2 font-medium text-xs">主播</th>
                    <th className="px-2 py-2 font-medium text-xs text-right">花费</th>
                    <th className="px-2 py-2 font-medium text-xs text-right">盈亏</th>
                    <th className="px-2 py-2 font-medium text-xs text-right">日期</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const giftRecords = filteredRecords
                      .filter(r => r.gift_name === selectedGift.gift_name);

                    if (activity.type === "card_flip") {
                      // 翻牌活动：每条记录独立，直接显示全部（包括坏牌被迫结束的）
                      return giftRecords.map((record, idx) => {
                        const profit = record.gift_price - record.spent;
                        return (
                          <tr key={idx} className={`border-t border-black/10 ${record.synthetic_result === 0 ? "bg-red-50/50" : "bg-white"}`}>
                            <td className="pl-3 pr-2 py-2 font-medium text-sm">{record.rname || `主播${record.ruid}`}</td>
                            <td className="px-2 py-2 text-right">{Math.floor(record.spent)}</td>
                            <td className={`px-2 py-2 text-right font-medium ${profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                              {profit >= 0 ? "+" : ""}{Math.floor(profit)}
                            </td>
                            <td className="px-2 py-2 text-right text-xs text-black/50">{record.date.split(' ')[0]}</td>
                          </tr>
                        );
                      });
                    }

                    // 其他活动：反向累积算法
                    const accumulatedMap = new Map<number, number>();
                    const successRecords: Array<{
                      ruid: number;
                      rname: string;
                      totalSpent: number;
                      value: number;
                      date: string;
                      isFull: boolean;
                    }> = [];

                    for (let i = giftRecords.length - 1; i >= 0; i--) {
                      const record = giftRecords[i];
                      const accumulated = accumulatedMap.get(record.ruid) || 0;
                      const newAccumulated = accumulated + record.spent;
                      if (record.synthetic_result !== 0) {
                        successRecords.push({
                          ruid: record.ruid,
                          rname: record.rname,
                          totalSpent: newAccumulated,
                          value: record.gift_price,
                          date: record.date,
                          isFull: record.synthetic_result === 2,
                        });
                        accumulatedMap.set(record.ruid, 0);
                      } else {
                        accumulatedMap.set(record.ruid, newAccumulated);
                      }
                    }

                    successRecords.reverse();

                    return successRecords.map((record, idx) => {
                      const profit = record.value - record.totalSpent;
                      return (
                        <tr key={idx} className="border-t border-black/10 bg-white">
                          <td className="pl-3 pr-2 py-2 font-medium text-sm">{record.rname || `主播${record.ruid}`}</td>
                          <td className="px-2 py-2 text-right">
                            {Math.floor(record.totalSpent)}
                            {record.isFull && <span className="text-xs text-red-500 ml-1">（满出）</span>}
                          </td>
                          <td className={`px-2 py-2 text-right font-medium ${profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                            {profit >= 0 ? "+" : ""}{Math.floor(profit)}
                          </td>
                          <td className="px-2 py-2 text-right text-xs text-black/50">{record.date.split(' ')[0]}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {showCertModal && filteredCertifications.length > 0 && (
        <CertificationModal
          certifications={filteredCertifications}
          currentIndex={certIndex}
          onIndexChange={setCertIndex}
          onClose={() => setShowCertModal(false)}
          activityType={activity.type}
        />
      )}
    </div>
  );
}

function CertificationModal({
  certifications,
  currentIndex,
  onIndexChange,
  onClose,
  activityType,
}: {
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
  currentIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  activityType?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const cert = certifications[currentIndex];
  const total = certifications.length;

  async function saveAsImage() {
    if (!cardRef.current) return;
    try {
      const dataUrl = await toPng(cardRef.current, {
        backgroundColor: "#fff",
        pixelRatio: 2,
        filter: (node: HTMLElement) => !node.classList?.contains("save-exclude"),
      });
      const link = document.createElement("a");
      link.download = `cert_${cert.type}_${cert.date.replace(/[^0-9]/g, "")}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("保存图片失败:", err);
    }
  }

  function goPrev() {
    if (currentIndex > 0) onIndexChange(currentIndex - 1);
  }

  function goNext() {
    if (currentIndex < total - 1) onIndexChange(currentIndex + 1);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="save-exclude absolute -top-10 right-0 text-white/80 hover:text-white text-sm transition"
        >
          ✕ 关闭
        </button>

        <div className="flex flex-col items-center gap-2">
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
                <span className="text-black/45 w-12 flex-shrink-0">日期</span>
                <span className="font-medium">{cert.date}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-black/45 w-12 flex-shrink-0">直播间</span>
                <span className="font-medium text-[#1f1c17]">{cert.rname || `主播${cert.ruid}`}</span>
              </div>
              {activityType === "card_flip" && cert.type === "lucky" && (
                <>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">礼物</span>
                    {cert.gift_img && (
                      <img src={fixImageUrl(cert.gift_img)} alt="" className="w-5 h-5 rounded" />
                    )}
                    <span className="font-medium">{cert.gift_name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">花费</span>
                    <span className="font-medium">{Math.floor(cert.spent)} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">价值</span>
                    <span className="font-medium">{cert.gift_price} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">盈亏</span>
                    <span className="font-bold text-green-600">
                      爆赚{Math.floor(cert.profit)} 电池
                    </span>
                  </div>
                  <div className="text-sm text-black/60 mt-1">只尝试了一次，一气呵成！</div>
                </>
              )}
              {activityType === "card_flip" && cert.type === "unlucky" && (
                <>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 flex-shrink-0">总共翻了</span>
                    <span className="font-bold">{cert.gift_name.replace("次翻牌", "")}</span>
                    <span>次牌</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="font-bold">{cert.count}</span>
                    <span>次翻到了凶牌，超过一半</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">花费</span>
                    <span className="font-medium">{Math.floor(cert.spent)} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">价值</span>
                    <span className="font-medium">{Math.floor(cert.gift_price || cert.spent + cert.profit)} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">盈亏</span>
                    <span className="font-bold text-red-500">
                      爆亏{Math.floor(Math.abs(cert.profit))} 电池！否极泰来...
                    </span>
                  </div>
                </>
              )}
              {activityType !== "card_flip" && cert.type !== "rich" && (
                <>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">礼物</span>
                    <span className="font-medium">{cert.gift_name}</span>
                    {cert.gift_img && (
                      <img src={fixImageUrl(cert.gift_img)} alt="" className="w-5 h-5 rounded" />
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">价值</span>
                    <span className="font-medium">{cert.gift_price} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">花费</span>
                    <span className="font-medium">{Math.floor(cert.spent)} 电池</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-black/45 w-12 flex-shrink-0">盈亏</span>
                    <span className={`font-bold ${cert.profit >= 0 ? "text-green-600" : "text-red-500"}`}>
                      {cert.profit >= 0 ? "+" : ""}{Math.floor(cert.profit)} 电池
                    </span>
                  </div>
                </>
              )}
              {cert.type === "rich" && (
                <div className="flex items-center gap-1">
                  <span className="text-black/45 w-12 flex-shrink-0">爆出</span>
                  <span className="font-bold text-purple-600">{cert.count}</span>
                  <span>个 {cert.gift_name}</span>
                  <span className="text-black/60">壕无人性！</span>
                </div>
              )}
            </div>

            <button
              onClick={saveAsImage}
              className="save-exclude mt-5 w-full rounded-xl bg-[#1f1c17] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 flex items-center justify-center gap-1.5"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              保存图片
            </button>
          </div>

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
      </div>
    </div>
  );
}