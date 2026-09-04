"use client";

/**
 * 礼物展示（左上方）：在所有"今日单价 > 阈值"的礼物之间每 8s 轮换一次。
 * 礼物图标放在固定不变的黄色 badge 里（无 ×、无圆形角标），
 * 数量以纯文本形式显示在图标正下方；badge 不动，仅内部"图标 + 数量"渐隐渐显轮换。
 */
import { useEffect, useRef, useState } from "react";
import type { DisplayGiftItem } from "@/lib/display/types";

const CYCLE_MS = 8000;
const FADE_MS = 1000;

export default function GiftFlower({
  gifts,
  emptyPlaceholder = false,
}: {
  gifts: DisplayGiftItem[];
  /** 无礼物时也渲染占位圆形 badge（供编辑模式摆放/预览） */
  emptyPlaceholder?: boolean;
}) {
  const [shown, setShown] = useState<DisplayGiftItem | null>(null);
  // true=内部内容可见；轮换时先 false（渐隐）再 true（渐显）
  const [fadeIn, setFadeIn] = useState(true);
  const listRef = useRef(gifts);
  listRef.current = gifts;
  const idxRef = useRef(0);

  // 清单变化：切回首个并直接显示
  useEffect(() => {
    idxRef.current = 0;
    setShown(gifts[0] ?? null);
    setFadeIn(true);
  }, [gifts]);

  // 每 CYCLE_MS 轮换一次：先渐隐旧内容，再换上新内容并渐显
  useEffect(() => {
    if (!gifts.length) return;
    let cancelled = false;
    const t = setInterval(() => {
      setFadeIn(false);
      setTimeout(() => {
        if (cancelled) return;
        idxRef.current = (idxRef.current + 1) % listRef.current.length;
        setShown(listRef.current[idxRef.current]);
        setFadeIn(true);
      }, FADE_MS);
    }, CYCLE_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [gifts]);

  if (!gifts.length && !emptyPlaceholder) return null;

  // 无礼物时的占位 badge：仅保留紫渐变正圆底 + 白色礼物图标（无数量），
  // 让编辑模式下该元素仍可见可摆放，尺寸与实际展示完全一致。
  if (!gifts.length) {
    return (
      <div className="relative w-24 h-24 pointer-events-none">
        <div
          className="absolute inset-0 rounded-full border border-black/10 shadow-[0_6px_18px_rgba(0,0,0,0.30)]"
          style={{ background: "linear-gradient(135deg, #9926AF, #0F0874)" }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            {/* 白色礼物盒图标（SVG，非 emoji，避免平台字体差异） */}
            <svg
              viewBox="0 0 24 24"
              className="w-10 h-10"
              fill="none"
              stroke="white"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="8" width="18" height="13" rx="1.5" fill="white" stroke="none" opacity="0.95" />
              <path d="M3 8h18M12 8v13" strokeWidth="1.4" />
              <path d="M12 8c-2-3.5-5.5-4.2-7-1.6C3.6 9 7 9.5 12 8z" fill="white" stroke="none" />
              <path d="M12 8c2-3.5 5.5-4.2 7-1.6C20.4 9 17 9.5 12 8z" fill="white" stroke="none" />
            </svg>
          </div>
        </div>
      </div>
    );
  }

  if (!shown) return null;

  // 礼物展示：紫渐变正圆 badge（仅图标）+ 数量置于圆外右下角（无白底，仅数字）。
  // 容器 96x96 与圆同大 → 虚线框右/下与圆的最右/最下相切；数字放容器右下角，
  // 该角落在圆盘外（45° 弧线之外），数字即显示在圆外并紧贴弧线。
  return (
    <div className="relative w-24 h-24 pointer-events-none">
      {/* 紫渐变正圆 badge（仅图标）：铺满容器，背景 #9926AF → #0F0874 */}
      <div
        className="absolute inset-0 rounded-full border border-black/10 shadow-[0_6px_18px_rgba(0,0,0,0.30)]"
        style={{ background: "linear-gradient(135deg, #9926AF, #0F0874)" }}
      >
        {/* 礼物图标：尽可能大，居中 */}
        <div
          className={`absolute inset-0 flex items-center justify-center transition-opacity duration-1000 ${
            fadeIn ? "opacity-100" : "opacity-0"
          }`}
        >
          <img
            src={shown.img}
            alt={shown.giftName}
            className="w-[5.5rem] h-[5.5rem] object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.20)]"
          />
        </div>
      </div>
      {/* 数量：置于圆外右下角、虚线框内，贴圆的下右弧；仅数字，无“×”与白底板。
          bottom-0/right-0 基础上再向下、向右各 2px（底/右用负值外移）。
          与图标使用同一 fadeIn 状态 + 相同 duration → 切换时完全同步渐隐渐显。
          数量为 1 时不显示（单个礼物无需计数） */}
      <span
        className={`absolute -right-[2px] -bottom-[2px] text-xl font-bold text-black/90 leading-none transition-opacity duration-1000 ${
          fadeIn ? "opacity-100" : "opacity-0"
        }`}
      >
        {shown.count > 1 ? shown.count : ""}
      </span>
    </div>
  );
}
