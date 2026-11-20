"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import type { SynthesisActivityStats, SynthesisGiftInfo } from "@/lib/gift-db";
import { showToast } from "@/lib/toast";
import { sendDanmaku } from "@/lib/barrage";
import { fetchMedicalRoomId } from "@/lib/medical-client";
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

  // 发送合成活动盈亏弹幕到主播直播间：[吃瓜]<活动名称>活动：合成<n>个 <爆出价值>-<花费> = <盈亏>电池
  const handleSendDanmaku = async () => {
    if (!selectedAnchor) return;
    const text = `[吃瓜]${activity.name}活动：合成${totalGiftCount}个 ${filteredStats.totalEarned}-${filteredStats.totalSpent} = ${filteredStats.profit}电池`;
    const roomRes = await fetchMedicalRoomId(Number(selectedAnchor));
    if (roomRes.code !== 0 || !roomRes.data?.roomid) {
      showToast(roomRes.message || "获取直播间号失败", "error");
      return;
    }
    const res = await sendDanmaku(roomRes.data.roomid, text);
    if (res.code === 0) {
      showToast("弹幕已发送");
    } else {
      showToast(res.message || res.msg || "发送弹幕失败", "error");
    }
  };

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

      {/* 盈亏弹幕：选择具体主播时显示 */}
      {selectedAnchor !== "" && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-black/15 bg-gray-200 px-3 py-1.5 text-xs">
          <span className="flex-1 min-w-0 text-black/80 font-medium">
            [吃瓜]{activity.name}活动：合成<b>{totalGiftCount}</b>个 <b>{filteredStats.totalEarned}</b>-<b>{filteredStats.totalSpent}</b> = <b className={filteredStats.profit >= 0 ? "text-green-600" : "text-red-500"}>{filteredStats.profit}</b>电池
          </span>
          <button
            onClick={handleSendDanmaku}
            className="flex-shrink-0 rounded-full bg-blue-500 px-3 py-1 text-xs text-white hover:bg-blue-600 transition"
          >
            发送弹幕
          </button>
        </div>
      )}
    </div>
  );
}

