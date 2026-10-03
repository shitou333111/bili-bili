"use client";

/**
 * 礼物展示（左上方）：横条 badge，宽度固定容纳 3 个礼物图标位。
 * 礼物数 >= 3 时列表补齐铺满后复制两份从右到左无缝循环滚动；< 3 时静态居中展示。
 * 显示/隐藏裁剪由 badge 自身（.gift-bar 的 overflow:hidden + 圆角）完成，
 * 与 badge 形状（含圆角端头）完全对齐，礼物滚到 badge 边界才隐藏。
 * badge 样式：毛玻璃磨砂（半透明 + backdrop-filter + 细白边、中等圆角略方），
 * 背景叠一层横幅同款 90° 横向颜色滚动（低透明度），与图标滚动同向配合。
 */
import type { ReactNode } from "react";
import type { DisplayGiftItem } from "@/lib/display/types";

const SLOTS = 3; // badge 容纳的礼物位数
const SLOT_W = 96; // 每个礼物位宽度
const SLOT_GAP = 4; // 礼物位间距（每项自带右边距，复制两份后两半宽度相等，滚动无缝）
const BAR_W = SLOT_W * SLOTS + 24; // badge 外宽（比 3 个礼物位多 24px，礼物可滚入两端）
const BAR_H = 100; // badge 高度（扁一些）
const ICON = 84; // 礼物图标尺寸

/** 单个礼物位：图标 + 右下角金色数量（紧贴图标右下角，数量为 1 时只显示图标） */
function GiftSlot({ gift }: { gift: DisplayGiftItem }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{ width: SLOT_W, marginRight: SLOT_GAP }}
    >
      <div className="relative" style={{ width: ICON, height: ICON }}>
        <img
          src={gift.img}
          alt={gift.giftName}
          className="object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.20)]"
          style={{ width: ICON, height: ICON }}
        />
        {gift.count > 1 && (
          <span className="absolute right-0 bottom-0 text-[19px] font-bold leading-none text-[#ffd54a] [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
            ×{gift.count}
          </span>
        )}
      </div>
    </div>
  );
}

/** 空占位礼物位：白色礼物盒图标（编辑模式下摆放用，无数量） */
function EmptySlot() {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{ width: SLOT_W, marginRight: SLOT_GAP }}
    >
      <svg
        viewBox="0 0 24 24 "
        style={{ width: ICON, height: ICON }}
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
  );
}

export default function GiftFlower({
  gifts,
  emptyPlaceholder = false,
}: {
  gifts: DisplayGiftItem[];
  /** 无礼物时也渲染占位横条（供编辑模式摆放/预览） */
  emptyPlaceholder?: boolean;
}) {
  if (!gifts.length && !emptyPlaceholder) return null;

  const scrolling = gifts.length >= SLOTS;
  // 滚动速度：每个礼物约 3.5s，最短 9s，避免礼物太少时转得太快
  const durSec = Math.max(9, gifts.length * 3.5);

  // 内容：>=3 个礼物循环滚动；否则静态居中；无礼物渲染 3 个占位位
  const row = (items: ReactNode[]) => (
    <div className="flex w-full items-center justify-center">{items}</div>
  );
  let content: ReactNode;
  if (!gifts.length) {
    content = row([<EmptySlot key="e0" />, <EmptySlot key="e1" />, <EmptySlot key="e2" />]);
  } else if (scrolling) {
    // 一份列表（base）：礼物太少铺不满 badge 可视宽度时整组重复补齐，
    // 保证滚动全程（周期末尾位移一份宽度时）窗口始终被礼物铺满、无空白；
    // 轨道 = base 复制两份 + translateX(0 → -50%)：-50% 正好是一份 base 宽度（width:max-content
    // 保证按内容宽算，否则按容器宽算会跳变），回到 0 时与首帧完全重合，首尾无缝。
    const copyW = gifts.length * (SLOT_W + SLOT_GAP);
    const reps = Math.max(1, Math.ceil(BAR_W / copyW));
    const base = Array.from({ length: reps }, () => gifts).flat();
    content = (
      <div
        className="flex shrink-0 items-center will-change-transform"
        style={{ width: "max-content", animation: `gift-bar-marquee ${durSec}s linear infinite` }}
      >
        {[...base, ...base].map((g, i) => (
          <GiftSlot key={i} gift={g} />
        ))}
      </div>
    );
  } else {
    content = row(gifts.map((g, i) => <GiftSlot key={i} gift={g} />));
  }

  return (
    <div
      className="gift-bar pointer-events-none relative flex items-center"
      style={{ width: BAR_W, height: BAR_H }}
    >
      {/* 滚动轨道靠左铺满（不居中，否则周期末尾右半段露空白）；
          裁剪由 .gift-bar 自身的 overflow:hidden + 圆角完成，礼物显示/隐藏边界与 badge 形状完全对齐；
          z-index:1 盖过 .gift-bar::before 颜色滚动层 */}
      <div className="relative z-[1] flex w-full items-center">
        {content}
      </div>
    </div>
  );
}
