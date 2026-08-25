"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { SynthesisActivityStats, SynthesisGiftInfo } from "@/lib/gift-db";
import { toPng } from "html-to-image";
import { isMobileDevice } from "@/lib/device";
import { showToast } from "@/lib/toast";
import { saveMobileOrDownload } from "@/lib/save-image";
import Dropdown from "@/components/Dropdown";

function fixImageUrl(url: string): string {
  if (!url) return "";
  return url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
}

function formatActivityRange(start?: number, end?: number): string {
  const fmt = (ts?: number) => {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    // 精简日期：仅月份.日子，如 08.26
    return `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };
  const s = fmt(start);
  const e = fmt(end);
  if (s && e) return `${s} - ${e}`;
  return s || (e ? `~ ${e}` : "");
}

interface SynthesisActivityCardProps {
  activity: SynthesisActivityStats;
  index?: number;
}

// 合成活动卡片背景色板：每个活动使用不同颜色作区分（新增活动自动取新的颜色）
const ACTIVITY_CARD_BG = [
  "bg-[#fff7ef]", // 淡橙色
  "bg-[#f0f7ee]", // 淡绿色
  "bg-[#eef3fb]", // 淡蓝色
  "bg-[#f3f0fa]", // 淡紫色
  "bg-[#fdf0f4]", // 淡粉色
  "bg-[#eaf7f3]", // 淡青色
  "bg-[#f5f0e8]", // 淡驼色
  "bg-[#eef9e6]", // 淡黄绿
];

export default function SynthesisActivityCard({ activity, index = 0 }: SynthesisActivityCardProps) {
  const [selectedAnchor, setSelectedAnchor] = useState<string>("");
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
    let successCount = 0;
    for (const r of anchorRecords) {
      // 只统计产物，跳过素材记录（synthetic_result=0），与"全部主播"行为一致
      if (r.synthetic_result === 0) continue;
      // 包裹补充的批量礼物 gift_num 可能 >1，须按 gift_num 累加（与全部主播口径一致）
      const n = r.gift_num ?? 1;
      successCount += n;
      // 礼物聚合：按 gift_name 计数（只含产物）
      if (r.gift_name) {
        const key = r.gift_name;
        const existing = giftMap.get(key);
        if (existing) {
          existing.count += n;
        } else {
          giftMap.set(key, {
            gift_id: 0,
            gift_name: r.gift_name,
            gift_img: r.gift_img,
            gift_price: r.gift_price,
            count: n,
          });
        }
      }
    }
    return {
      ...activity.profit,
      totalSpent: anchor.totalSpent,
      totalEarned: anchor.totalEarned,
      profit: anchor.totalEarned - anchor.totalSpent,
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

  const cardBgColor = ACTIVITY_CARD_BG[index % ACTIVITY_CARD_BG.length];
  const activityRange = formatActivityRange(activity.start_time, activity.end_time);

  return (
    <div key={activity.id} ref={cardRef} className={`w-full min-w-0 rounded-xl border border-black/10 ${cardBgColor} p-2 shadow-[0_20px_80px_rgba(31,28,23,0.08)]`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {activity.icon && <img src={fixImageUrl(activity.icon)} alt="" className="w-7 h-7 rounded flex-shrink-0" />}
          <div className="text-base font-bold uppercase tracking-[0.15em] text-black/70 truncate max-w-[100px]">
            {activity.name.slice(0, 6)}{activity.name.length > 6 ? "..." : ""}
          </div>
          {activityRange && (
            <span className="text-sm font-medium tracking-normal normal-case text-black/60 whitespace-nowrap">
              {activityRange}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Dropdown
            value={selectedAnchor}
            onChange={setSelectedAnchor}
            className="rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs text-black/65 outline-none flex-shrink-0"
            options={[
              { value: "", label: "全部主播" },
              ...activity.profit.anchors.map((anchor) => ({
                value: String(anchor.ruid),
                label: anchor.rname || `主播${anchor.ruid}`,
              })),
            ]}
          />
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
      </div>

      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="text-s text-black/70 font-medium whitespace-nowrap overflow-x-auto scrollbar-none flex-1 min-w-0">
          合成 {totalGiftCount} 个礼物 | {filteredStats.totalEarned}-{filteredStats.totalSpent}=<span className={filteredStats.profit >= 0 ? "text-green-600 font-bold" : "text-red-500 font-bold"}>{filteredStats.profit >= 0 ? "+" : ""}{filteredStats.profit}</span>电池
        </div>
        {/* 调试按钮已隐藏，保留调试代码 */}
        {/* <button
          onClick={() => setShowDebug(!showDebug)}
          className="text-xs text-black/40 hover:text-black/70 transition underline flex-shrink-0"
        >
          {showDebug ? "收起调试" : "调试"}
        </button> */}
      </div>

      {filteredStats.giftList.length > 0 && (
        <div className="mt-4">
            <div className="rounded-lg border border-black/10 overflow-hidden">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-black/5 text-black/60">
                <tr>
                  <th className="pl-3 pr-2 py-2 font-medium whitespace-nowrap">合成礼物</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[16%]">单价</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[16%]">数量</th>
                  <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[20%]">小计</th>
                </tr>
              </thead>
              <tbody>
                {filteredStats.giftList
                  .sort((a, b) => a.gift_price - b.gift_price)
                  .map((gift) => (
                    <tr
                      key={`${gift.gift_id}_${gift.gift_name}`}
                      className="border-t border-black/10 bg-white"
                    >
                      <td className="pl-3 pr-2 py-2">
                        <div className="flex items-center gap-2">
                          {gift.gift_img && <img src={fixImageUrl(gift.gift_img)} alt="" className="w-5 h-5 rounded flex-shrink-0" />}
                          <span className="font-medium">{gift.gift_name}</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right">{gift.gift_price}</td>
                      <td className="px-2 py-2 text-right">×{gift.count}</td>
                      <td className="px-2 py-2 text-right">{Math.floor(gift.gift_price * gift.count)}</td>
                    </tr>
                  ))}
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
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cert = certifications[currentIndex];
  const total = certifications.length;

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

  return createPortal(
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
    </div>,
    document.body
  );
}