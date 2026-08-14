"use client";

import { useState, useEffect, useRef } from "react";
import type { Gift } from "./types";
import type { BagGift } from "./activityState";

const TABS = [
  { key: "gift", label: "礼物" },
  { key: "fans", label: "粉丝团" },
  { key: "voyage", label: "航海" },
  { key: "bag", label: "包裹" },
  { key: "all", label: "全部" },
];

const QUANTITY_OPTIONS = [10, 100, 520, 1314];

interface GiftPanelProps {
  isOpen: boolean;
  onClose: () => void;
  tabGifts: Record<string, Gift[] | BagGift[]>;
  selectedGift: Gift | null;
  comboGift: Gift | null;
  comboProgress: number;
  comboCount: number;
  onSelectGift: (gift: Gift) => void;
  onSendGiftFor: (gift: Gift, count: number) => void;
  onComboClick: () => void;
  balance: number;
  cornerMarkOverride?: Record<number, string>;
}

export default function GiftPanel({
  isOpen,
  onClose,
  tabGifts,
  selectedGift,
  comboGift,
  comboProgress,
  comboCount,
  onSelectGift,
  onSendGiftFor,
  onComboClick,
  balance,
  cornerMarkOverride,
}: GiftPanelProps) {
  const [activeTab, setActiveTab] = useState("gift");
  const [animating, setAnimating] = useState(false);
  const [longPressGift, setLongPressGift] = useState<Gift | null>(null);
  // 排序状态：gift 三态(none/asc/desc)，all 两态(asc/desc)
  const [sortState, setSortState] = useState<Record<string, string>>({ gift: "none", all: "asc" });
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setAnimating(true);
      setLongPressGift(null);
    }
  }, [isOpen]);

  function formatPrice(price: number): string {
    if (price >= 10000) {
      return `${(price / 10000).toFixed(3).replace(/\.?0+$/, "")}万电池`;
    }
    return `${Math.round(price)} 电池`;
  }

  function sortGifts(list: Gift[], mode: string): Gift[] {
    if (!list) return [];
    if (mode === "none") return list;
    const arr = [...list].sort((a, b) => a.price - b.price);
    if (mode === "desc") arr.reverse();
    return arr;
  }

  // 当前选项卡显示的礼物列表（包裹选项卡过滤掉数量为0的礼物）
  const currentGifts = sortGifts(
    (tabGifts[activeTab] || []).filter((g) => activeTab !== "bag" || !(g as BagGift).count || (g as BagGift).count > 0),
    sortState[activeTab] || "none"
  );

  function handleTabClick(tabKey: string) {
    setActiveTab(tabKey);
    if (tabKey === "gift") {
      setSortState((s) => ({
        ...s,
        gift: s.gift === "none" ? "asc" : s.gift === "asc" ? "desc" : "none",
      }));
    } else if (tabKey === "all") {
      setSortState((s) => ({ ...s, all: s.all === "asc" ? "desc" : "asc" }));
    }
  }

  function handlePressStart(gift: Gift) {
    handlePressEnd();
    longPressTimerRef.current = setTimeout(() => {
      setLongPressGift(gift);
    }, 500);
  }

  function handlePressEnd() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleGiftClick(gift: Gift) {
    const wasLongPress = !!longPressGift;
    handlePressEnd();
    if (wasLongPress) {
      setLongPressGift(null);
      return;
    }
    if (comboGift?.id === gift.id) {
      onComboClick();
    } else if (selectedGift?.id === gift.id) {
      onSendGiftFor(gift, 1);
    } else {
      onSelectGift(gift);
    }
  }

  function handleQuantitySelect(qty: number) {
    if (longPressGift) {
      onSendGiftFor(longPressGift, qty);
      setLongPressGift(null);
    }
  }

  if (!isOpen && !animating) return null;

  const whiteRingR = 25;
  const whiteRingC = 2 * Math.PI * whiteRingR;

  // 上下三角箭头组件
  const ArrowGroup = ({ sortMode }: { sortMode: string }) => (
    <div className="ml-1 flex flex-col gap-[3px] justify-center">
      <svg width="7" height="4" viewBox="0 0 7 5" fill="none" className="block">
        <path d="M6.6 3.2C7 3.6 6.7 4.4 6 4.4H1C0.3 4.4 0 3.6 0.4 3.2L3 0.6C3.2 0.4 3.8 0.4 4 0.6L6.6 3.2Z" fill={sortMode === "asc" ? "#D8819B" : "rgba(255,255,255,0.4)"} />
      </svg>
      <svg width="7" height="4" viewBox="0 0 7 5" fill="none" className="block">
        <path d="M0.4 1.8C0 1.4 0.3 0.6 1 0.6H6C6.7 0.6 7 1.4 6.6 1.8L4 4.4C3.8 4.6 3.2 4.6 3 4.4L0.4 1.8Z" fill={sortMode === "desc" ? "#D8819B" : "rgba(255,255,255,0.4)"} />
      </svg>
    </div>
  );

  return (
    <>
      {/* 遮罩 - 点击关闭 */}
      <div
        className={`absolute inset-0 z-25 transition-opacity duration-500 ${
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        style={{ backgroundColor: "rgba(0,0,0,0.3)" }}
      />

      {/* 礼物面板 */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 transition-transform duration-500 ease-out ${
          isOpen ? "translate-y-0" : "translate-y-full"
        }`}
        onTransitionEnd={() => {
          if (!isOpen) setAnimating(false);
        }}
        style={{ maxWidth: "var(--page-max-width)", margin: "0 auto", left: 0, right: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex flex-col rounded-t-2xl shadow-2xl relative overflow-hidden"
          style={{
            height: "52vh",
            minHeight: 340,
            backgroundColor: "#12101B",
          }}
        >
          {/* 顶部Tab栏 */}
          <div className="flex items-center border-b border-white/5 px-2 h-11 shrink-0 relative z-20">
            <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide flex-1 px-2 h-full">
              {TABS.map((tab) => {
                const showArrows = tab.key === "gift" || tab.key === "all";
                const sortMode = showArrows ? sortState[tab.key] : "none";
                return (
                  <button
                    key={tab.key}
                    onClick={() => handleTabClick(tab.key)}
                    className={`relative flex items-center h-full text-sm whitespace-nowrap transition-colors ${
                      activeTab === tab.key
                        ? "text-[#D8819B] font-semibold"
                        : "text-white/50"
                    }`}
                  >
                    {tab.label}
                    {showArrows && <ArrowGroup sortMode={sortMode} />}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3 shrink-0 pr-2">
              {/* 权益中心 - 非选项卡，不可点击 */}
              <div className="flex items-center text-[10px] text-white whitespace-nowrap">
                <img src="/gift-rights.avif" alt="权益" className="w-3 h-3 mr-0.5 object-contain" />
                权益中心
              </div>
              {/* 电池余额 - 直接显示，无badge */}
              <span className="flex items-center text-[10px] text-white whitespace-nowrap">
                <img src="/gift-battery.avif" alt="电池" className="w-3 h-3 mr-0.5 object-contain" />
                1万
              </span>
            </div>
          </div>

          {/* 数量选择栏 - 长按弹出 */}
          {longPressGift && (
            <div className="px-4 py-2 flex gap-2 z-20 bg-[#12101B] border-b border-white/5">
              {QUANTITY_OPTIONS.map((qty) => (
                <button
                  key={qty}
                  onClick={() => handleQuantitySelect(qty)}
                  className="flex-1 rounded bg-gradient-to-r from-[#FF6699] to-[#FF8FB3] text-white text-xs font-medium py-1.5 active:scale-95 transition-transform"
                >
                  {qty}个
                </button>
              ))}
            </div>
          )}

          {/* 礼物列表区域 */}
          <div className="flex-1 overflow-y-auto px-3 py-3 scrollbar-hide gift-scroll relative">
            {currentGifts.length > 0 ? (
              <div className="grid grid-cols-4 gap-x-2 gap-y-1.5 justify-items-center pb-8">
                {currentGifts.map((gift) => {
                  const isSelected = selectedGift?.id === gift.id && comboGift?.id !== gift.id;
                  const isCombo = comboGift?.id === gift.id;
                  return (
                    <div key={gift.id} className="w-full flex justify-center">
                      <div
                        onClick={() => handleGiftClick(gift)}
                        onMouseDown={() => handlePressStart(gift)}
                        onMouseUp={handlePressEnd}
                        onMouseLeave={handlePressEnd}
                        onTouchStart={() => handlePressStart(gift)}
                        onTouchEnd={handlePressEnd}
                        className={`relative w-[92%] cursor-pointer transition-colors duration-200 rounded-lg overflow-hidden flex flex-col items-center pt-2 ${
                          isCombo
                            ? ""
                            : isSelected
                            ? "scale-105 z-10"
                            : "hover:bg-white/5 active:bg-white/10"
                        }`}
                        style={{
                          backgroundColor: isSelected ? "#211F2A" : "transparent",
                        }}
                      >
                        {isCombo ? (
                          /* 连击状态：一体圆形 + 单个白色倒计时光环 */
                          <div className="relative w-[64px] h-[64px] my-2 flex items-center justify-center">
                            {/* 粉色填充圆 - 一体，无内圈间隙 */}
                            <div
                              className="absolute inset-0 rounded-full"
                              style={{
                                background: "linear-gradient(180deg, #FF7B9F 0%, #F04A7D 100%)",
                              }}
                            />
                            {/* 单个白色倒计时光环 - 不贴边露出粉色边缘 */}
                            <svg className="absolute inset-0 -rotate-90" width="64" height="64">
                              <circle
                                cx="32"
                                cy="32"
                                r={whiteRingR}
                                fill="none"
                                stroke="white"
                                strokeWidth="3.5"
                                strokeLinecap="butt"
                                strokeDasharray={whiteRingC}
                                strokeDashoffset={whiteRingC * (1 - comboProgress)}
                              />
                            </svg>
                            <img
                              src={gift.img}
                              alt={gift.name}
                              className="relative z-10 w-8 h-8 object-contain"
                            />
                            <span className="absolute bottom-1.5 z-10 text-white text-[11px] font-bold drop-shadow-md">
                              x{comboCount}
                            </span>
                          </div>
                        ) : (
                          <>
                            {/* 角标（盲盒使用配置的 1倍/5倍/3倍 覆盖） */}
                            {(cornerMarkOverride?.[gift.id] || gift.corner_mark) && (
                              <div
                                className="absolute left-0 top-0 h-3.5 flex items-center justify-center z-10 rounded-r px-1"
                                style={{ backgroundColor: gift.corner_background || "#FD94B2" }}
                              >
                                <span className="text-white text-[9px] whitespace-nowrap">
                                  {cornerMarkOverride?.[gift.id] || gift.corner_mark}
                                </span>
                              </div>
                            )}

                            {/* 礼物图片 */}
                            <div className="flex justify-center">
                              <div className="w-[46px] h-[46px]">
                                <img
                                  src={gift.img}
                                  alt={gift.name}
                                  className="w-full h-full object-contain"
                                  loading="lazy"
                                />
                              </div>
                            </div>

                            {/* 礼物名称行 - 固定高度，选中时隐藏但保留空间 */}
                            <div className="w-full px-1 h-[16px] flex items-center justify-center">
                              {!isSelected && (
                                <span className="text-[10px] text-white/80 truncate leading-none">
                                  {gift.name}
                                  {activeTab === "bag" && (gift as BagGift).count !== undefined && (gift as BagGift).count > 0 && (
                                    <span className="text-white/50"> x{(gift as BagGift).count}</span>
                                  )}
                                </span>
                              )}
                            </div>

                            {/* 电池数/投喂行 - 固定高度 */}
                            <div className="w-full mt-[2px] flex flex-col" style={{ height: "22px" }}>
                              {isSelected ? (
                                <div className="w-full h-full flex items-center justify-center bg-gradient-to-r from-[#FF6699] to-[#FF8FB3]">
                                  <span className="text-white text-[10px] font-medium">投喂</span>
                                </div>
                              ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                  <span className="text-[9px] text-white/40 leading-none">
                                    {formatPrice(gift.price)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-white/40 text-sm">
                此分类暂无礼物
              </div>
            )}
          </div>

          {/* 底部淡出遮罩 - 固定在面板底部，不随滚动 */}
          <div
            className="absolute bottom-0 left-0 right-0 pointer-events-none z-10"
            style={{
              height: "72px",
              background: "linear-gradient(to top, #12101B 55%, rgba(18,16,27,0) 100%)",
            }}
          />
        </div>
      </div>
    </>
  );
}
