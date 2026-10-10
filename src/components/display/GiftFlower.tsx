"use client";

/**
 * 礼物展示：badge 条（横条/竖条可切换），沿滚动轴固定容纳 3 个礼物图标位。
 * 横条：礼物数 >= 3 时列表补齐铺满后复制两份从右到左无缝循环滚动；
 * 竖条：整个条竖直，礼物从下到上无缝循环滚动。
 * < 3 时静态居中展示。
 * 显示/隐藏裁剪由 badge 自身（.gift-bar 的 overflow:hidden + 圆角）完成，
 * 与 badge 形状（含圆角端头）完全对齐，礼物滚到 badge 边界才隐藏。
 * badge 样式：毛玻璃磨砂（半透明 + backdrop-filter + 细白边、中等圆角略方），
 * 背景叠一层横幅同款颜色滚动（低透明度）：横条 90° 横向、竖条 180° 纵向，与图标滚动同向配合。
 *
 * 突出显示（主播在面板点选送礼粉丝后）：有选择的礼物 badge 内容整体替换为
 * "粉丝头像 + 昵称 + 礼物图标"高亮帧（静态不滚动）；多选时循环切换——
 * 竖条向左滑动（translateX）、横条向上滑动（translateY），无缝轮播。
 */
import type { CSSProperties, ReactNode } from "react";
import type { DisplayGiftFan, DisplayGiftItem, GiftHighlight } from "@/lib/display/types";

const SLOTS = 3; // badge 容纳的礼物位数
const SLOT_SIZE = 96; // 每个礼物位沿滚动轴的尺寸
const SLOT_GAP = 4; // 礼物位间距（每项自带末尾边距，复制两份后两半长度相等，滚动无缝）
const BAR_LEN = SLOT_SIZE * SLOTS + 24; // badge 沿滚动轴的长度（比 3 个礼物位多 24px，礼物可滚入两端）
const BAR_THICK = 100; // badge 垂直于滚动轴的厚度（扁一些）
const ICON = 84; // 礼物图标尺寸
const HL_ICON = 84; // 高亮帧礼物图标尺寸（与非高亮礼物图标一致）
const HL_AVATAR = 84; // 高亮帧粉丝头像尺寸（横条）
const HL_AVATAR_V = 84; // 高亮帧粉丝头像尺寸（竖条）
/** 高亮帧礼物图标（连同右下角数量）向条内收缩的距离：badge 的 border-radius(44px)
 *  会裁掉四角，图标原贴边放置时右下角数量正落在被圆角裁掉的角落，整体内移后即完整可见 */
const HL_GIFT_INSET = 20;
/** 高亮帧轮播每帧时长（秒）：停顿 70% + 滑动 30% */
const HL_FRAME_SEC = 5;

/** 单个礼物位：图标 + 右下角金色数量（紧贴图标右下角，数量为 1 时只显示图标） */
function GiftSlot({ gift, vertical }: { gift: DisplayGiftItem; vertical: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={
        vertical
          ? { height: SLOT_SIZE, marginBottom: SLOT_GAP }
          : { width: SLOT_SIZE, marginRight: SLOT_GAP }
      }
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
function EmptySlot({ vertical }: { vertical: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={
        vertical
          ? { height: SLOT_SIZE, marginBottom: SLOT_GAP }
          : { width: SLOT_SIZE, marginRight: SLOT_GAP }
      }
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

/** 粉丝头像：有 face 用图片，缺头像回退昵称首字彩色圆底 */
function FanAvatar({ fan, size }: { fan: DisplayGiftFan; size: number }) {
  if (fan.face) {
    return (
      <img
        src={fan.face}
        alt={fan.uname}
        className="shrink-0 rounded-full object-cover ring-2 ring-white/70"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-white/70"
      style={{
        width: size,
        height: size,
        background: `hsl(${fan.uid % 360}, 65%, 55%)`,
        fontSize: size * 0.42,
      }}
    >
      {fan.uname.slice(0, 1)}
    </div>
  );
}

/** 高亮帧礼物图标：图标 + 右下角金色数量（该粉丝送出的数量），样式与非高亮礼物位一致。
 *  按朝向朝条内收缩 HL_GIFT_INSET，避开 badge 圆角对右下角数量的裁切。 */
function HighlightGiftIcon({
  gift,
  count,
  vertical,
}: {
  gift: DisplayGiftItem;
  count: number;
  vertical: boolean;
}) {
  return (
    <div
      className="relative shrink-0"
      style={{
        width: HL_ICON,
        height: HL_ICON,
        ...(vertical ? { marginBottom: HL_GIFT_INSET } : { marginRight: HL_GIFT_INSET }),
      }}
    >
      <img
        src={gift.img}
        alt={gift.giftName}
        className="object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.20)]"
        style={{ width: HL_ICON, height: HL_ICON }}
      />
      <span className="absolute right-0 bottom-0 text-[19px] font-bold leading-none text-[#ffd54a] [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
        ×{count}
      </span>
    </div>
  );
}

/**
 * 突出显示帧：粉丝头像 + 昵称 + 礼物图标（整条替换礼物滚动内容，静态展示）。
 * 横条：头像在左、昵称在中（最多前 6 字，超宽直接截断，无省略号）、礼物图标在右；
 * 竖条：头像在上、昵称在中（竖排从上到下）、礼物图标在下。
 * 礼物图标右下角显示该粉丝送出数量（×N）。
 * 昵称字号自适：按头像与礼物图标之间的可用长度逐字排布（文字越少字号越大），
 * 同时受另一维几何限制（横条行高 / 竖条列宽不超过条厚），最多填满头像与礼物之间的空间。
 */
function HighlightFrame({
  gift,
  fan,
  vertical,
}: {
  gift: DisplayGiftItem;
  fan: DisplayGiftFan;
  vertical: boolean;
}) {
  const name = fan.uname.slice(0, 6);
  const nameStyle: CSSProperties = {
    overflow: "hidden",
    whiteSpace: "nowrap",
    fontWeight: 700,
    color: "#fff",
    textShadow: "0 1px 4px rgba(0,0,0,0.55)",
    lineHeight: 1,
  };
  if (vertical) {
    // 可用高度 = 条长 - 上下 padding(8×2) - 头像 - 礼物 - 两段间距(10×2) - 礼物内缩
    const availH = BAR_LEN - 16 - HL_AVATAR_V - HL_ICON - 20 - HL_GIFT_INSET;
    // 字号自适填满头像与礼物图标之间的空间：按可用高度逐字排布（文字越少字号越大），
    // 同时列宽（lineHeight 1×字号）不超过条内容宽（BAR_THICK - 左右 padding 12）
    const fontSize = Math.max(
      12,
      Math.min(Math.floor(availH / Math.max(name.length, 1)), Math.floor(BAR_THICK - 12)),
    );
    return (
      <div
        className="flex shrink-0 flex-col items-center justify-center"
        style={{ width: BAR_THICK, height: "100%", gap: 10, padding: "8px 6px" }}
      >
        <FanAvatar fan={fan} size={HL_AVATAR_V} />
        {/* 昵称字号直接作用在占据 flex 空间的这一层（外层父容器 items-center 横向居中） */}
        <div
          style={{
            ...nameStyle,
            flex: "1 1 0",
            minHeight: 0,
            writingMode: "vertical-rl",
            textAlign: "center",
            fontSize,
          }}
        >
          {name}
        </div>
        <HighlightGiftIcon gift={gift} count={fan.count} vertical />
      </div>
    );
  }
  // 可用宽度 = 条长 - 左右 padding(8×2) - 头像 - 礼物 - 两段间距(8×2) - 礼物内缩
  const availW = BAR_LEN - 16 - HL_AVATAR - HL_ICON - 16 - HL_GIFT_INSET;
  // 字号自适填满头像与礼物图标之间的空间：按可用宽度逐字排布（文字越少字号越大），
  // 同时行高（lineHeight 1×字号）不超过条厚
  const fontSize = Math.max(
    12,
    Math.min(Math.floor(availW / Math.max(name.length, 1)), Math.floor(BAR_THICK)),
  );
  return (
    <div
      className="flex shrink-0 items-center"
      style={{ width: "100%", height: BAR_THICK, gap: 8, padding: "0 8px" }}
    >
      <FanAvatar fan={fan} size={HL_AVATAR} />
      <div style={{ ...nameStyle, flex: "1 1 0", minWidth: 0, textAlign: "center", fontSize }}>
        {name}
      </div>
      <HighlightGiftIcon gift={gift} count={fan.count} vertical={false} />
    </div>
  );
}

export default function GiftFlower({
  gifts,
  emptyPlaceholder = false,
  orientation = "horizontal",
  highlight,
}: {
  gifts: DisplayGiftItem[];
  /** 无礼物时也渲染占位条（供编辑模式摆放/预览） */
  emptyPlaceholder?: boolean;
  /** 条的方向：横条（礼物从右到左滚动）/ 竖条（礼物从下到上滚动） */
  orientation?: "horizontal" | "vertical";
  /** 突出显示选择（giftId → 选中 uid 列表，顺序 = 循环顺序）。编辑模式占位时忽略。 */
  highlight?: GiftHighlight;
}) {
  if (!gifts.length && !emptyPlaceholder) return null;

  const vertical = orientation === "vertical";
  const scrolling = gifts.length >= SLOTS;
  // 滚动速度：每个礼物约 3.5s，最短 9s，避免礼物太少时转得太快
  const durSec = Math.max(9, gifts.length * 3.5);

  // —— 突出显示帧：按选择顺序展平 (gift, fan) 对（只保留当前清单里存在且有该粉丝的）——
  const frames: Array<{ gift: DisplayGiftItem; fan: DisplayGiftFan }> = [];
  if (!emptyPlaceholder && highlight) {
    for (const [gid, uids] of Object.entries(highlight)) {
      const gift = gifts.find((g) => g.giftId === Number(gid));
      if (!gift?.fans?.length) continue;
      for (const uid of uids) {
        const fan = gift.fans.find((f) => f.uid === uid);
        if (fan) frames.push({ gift, fan });
      }
    }
  }
  const useHighlight = frames.length > 0;
  const n = frames.length;

  // 内容：有突出显示 → 高亮帧（单帧静态 / 多帧循环滑动）；
  // 否则 >=3 个礼物循环滚动；否则静态居中；无礼物渲染 3 个占位位
  let content: ReactNode;
  let innerClass: string;
  if (useHighlight) {
    innerClass = "relative z-[1] h-full w-full";
    if (n === 1) {
      // 单帧：静态占满 badge（头像与礼物不滚动）
      content = (
        <div className="absolute left-0 top-0 h-full w-full">
          <HighlightFrame gift={frames[0].gift} fan={frames[0].fan} vertical={vertical} />
        </div>
      );
    } else {
      // 多帧循环：轨道复制两份，逐帧停留——每帧停顿 70% 后只滑动一个帧位（BAR_THICK px）
      // 到下一帧再停，不连续滚动；按帧数 n 生成分段 keyframes（每步 100/n %，一步 = HL_FRAME_SEC）。
      // 滑到第 n 帧恰等于一份复制长度（-n×BAR_THICK），回到 0 时与首帧完全重合，首尾无缝。
      // 竖条 translateX 向左滑、横条 translateY 向上滑（keyframes 按方向+帧数命名，渲染在组件内 <style>）。
      const axis = vertical ? "x" : "y";
      const tf = vertical ? "translateX" : "translateY";
      const frames2 = [...frames, ...frames];
      const step = 100 / n;
      const kf: string[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i * step).toFixed(3);
        const b = (i * step + step * 0.7).toFixed(3);
        const c = ((i + 1) * step).toFixed(3);
        kf.push(
          `${a}%,${b}%{transform:${tf}(${-i * BAR_THICK}px)}` +
            `${c}%{transform:${tf}(${-(i + 1) * BAR_THICK}px)}`,
        );
      }
      content = (
        <>
          <style>{`@keyframes gift-hl-cycle-${axis}-${n}{${kf.join("")}}`}</style>
          <div
            className={`absolute left-0 top-0 flex will-change-transform ${vertical ? "" : "flex-col"}`}
            style={
              vertical
                ? {
                    height: "100%",
                    width: "max-content",
                    animation: `gift-hl-cycle-x-${n} ${n * HL_FRAME_SEC}s linear infinite`,
                  }
                : {
                    width: "100%",
                    height: "max-content",
                    animation: `gift-hl-cycle-y-${n} ${n * HL_FRAME_SEC}s linear infinite`,
                  }
            }
          >
            {frames2.map((f, i) => (
              <HighlightFrame key={i} gift={f.gift} fan={f.fan} vertical={vertical} />
            ))}
          </div>
        </>
      );
    }
  } else if (!gifts.length) {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    content = stack(vertical, [
      <EmptySlot key="e0" vertical={vertical} />,
      <EmptySlot key="e1" vertical={vertical} />,
      <EmptySlot key="e2" vertical={vertical} />,
    ]);
  } else if (scrolling) {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    // 一份列表（base）：礼物太少铺不满 badge 可视长度时整组重复补齐，
    // 保证滚动全程（周期末尾位移一份长度时）窗口始终被礼物铺满、无空白；
    // 轨道 = base 复制两份 + translate(0 → -50%)：-50% 正好是一份 base 长度（max-content
    // 保证按内容长度算，否则按容器算会跳变），回到 0 时与首帧完全重合，首尾无缝。
    // 横条 translateX 从右到左；竖条 translateY 从下到上。
    const copyLen = gifts.length * (SLOT_SIZE + SLOT_GAP);
    const reps = Math.max(1, Math.ceil(BAR_LEN / copyLen));
    const base = Array.from({ length: reps }, () => gifts).flat();
    content = (
      <div
        className={`flex shrink-0 items-center will-change-transform ${vertical ? "flex-col" : ""}`}
        style={
          vertical
            ? {
                width: "100%",
                height: "max-content",
                animation: `gift-bar-marquee-v ${durSec}s linear infinite`,
              }
            : {
                width: "max-content",
                animation: `gift-bar-marquee ${durSec}s linear infinite`,
              }
        }
      >
        {[...base, ...base].map((g, i) => (
          <GiftSlot key={i} gift={g} vertical={vertical} />
        ))}
      </div>
    );
  } else {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    content = stack(vertical, gifts.map((g, i) => <GiftSlot key={i} gift={g} vertical={vertical} />));
  }

  return (
    <div
      className={`gift-bar pointer-events-none relative flex items-center ${vertical ? "gift-bar-v flex-col" : ""}`}
      style={
        vertical
          ? { width: BAR_THICK, height: BAR_LEN }
          : { width: BAR_LEN, height: BAR_THICK }
      }
    >
      {/* 滚动轨道靠起始端铺满（不居中，否则周期末尾另一端露空白）；
          裁剪由 .gift-bar 自身的 overflow:hidden + 圆角完成，礼物显示/隐藏边界与 badge 形状完全对齐；
          z-index:1 盖过 .gift-bar::before 颜色滚动层 */}
      <div className={innerClass}>{content}</div>
    </div>
  );
}

/** 内容堆叠容器：沿滚动轴居中（静态展示用） */
function stack(vertical: boolean, items: ReactNode[]) {
  return (
    <div
      className={
        vertical
          ? "flex h-full w-full flex-col items-center justify-center"
          : "flex w-full items-center justify-center"
      }
    >
      {items}
    </div>
  );
}
