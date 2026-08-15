"use client";

import { useEffect, useState } from "react";

// ==================== 宣传语轮播（霓虹光晕·淡入淡出） ====================
// 七句话在同一位置依次"淡入 → 停留 → 淡出 → 下一句"，只占一行。
// 每句循环使用霓虹色，文字带多层光晕（text-shadow）、背景为柔和径向光晕，
// 简洁优雅、无需引入额外依赖。
const SLOGANS = [
  "想回顾你和爱播的甜蜜送礼瞬间？",
  "与爱播闹崩，看花了多少冤枉钱？",
  "被粉丝骚扰，列清单不惯臭毛病？",
  "主播想统计收了什么，赚了多少？",
  "大礼物忘了录屏，想补礼物截图？",
  "陪伴最久的爱播？最常来的粉丝？",
  "抢到的最香，想看中了多少天选？",
  "想看氪了多少，更好的防止剁手？",
  "想看盲盒盈亏，合成活动练练手？",
  "想解锁所有礼物，体验神豪视角？",
  "大哥大姐们想批量清理无关粉丝？",
  "清理粉丝牌，被迫单个强制等待？",
  "守医药费，想知道有没有掉地上？",
  "计算医药费，不想再掏出计算器？",
  "发医药费，不想再统计在哪个群？",
  "爱播没开播，新活动找不到入口？",
];

// 霓虹色板：与句子循环取色，营造霓虹光晕氛围（无绿色，绿色在浅色背景上易看不清）
const NEON = [
  "#ff2d78", // 霓虹粉
  "#00d9ff", // 霓虹青
  "#b967ff", // 霓虹紫
  "#ff5722", // 橙红
  "#ff9800", // 橙
  "#ff3d81", // 荧光红
  "#7c4dff", // 蓝紫
];

const FADE_MS = 1100; // 淡入 / 淡出时长
const HOLD_MS = 2600; // 停留时长
const PAUSE_MS = 400; // 两句之间的间隔

export default function SloganRotator() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true); // 控制淡入淡出

  useEffect(() => {
    const inTimer = setTimeout(() => setVisible(true), 40);
    const outTimer = setTimeout(() => setVisible(false), FADE_MS + HOLD_MS);
    const nextTimer = setTimeout(
      () => setIndex((i) => (i + 1) % SLOGANS.length),
      FADE_MS + HOLD_MS + FADE_MS + PAUSE_MS,
    );
    return () => {
      clearTimeout(inTimer);
      clearTimeout(outTimer);
      clearTimeout(nextTimer);
    };
  }, [index]);

  const color = NEON[index % NEON.length];

  return (
    <div className="relative mt-8 flex h-10 items-center justify-center sm:mt-12 sm:h-12">
      {/* 背景霓虹光晕：恒定亮度横幅光晕，整句范围亮度一致（无中心/周边区别），外缘快速淡出 */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-[42rem] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-xl"
        style={{
          background: `radial-gradient(ellipse 50% 50% at center, ${color}59 0%, ${color}59 88%, transparent 100%)`,
          opacity: visible ? 1 : 0,
          transition: `opacity ${FADE_MS}ms ease`,
        }}
        aria-hidden="true"
      />
      {/* 宣传语文字：霓虹色纯色，光晕轻微，保证清晰易读 */}
      <span
        className="relative text-xl font-semibold sm:text-2xl"
        style={{
          color,
          textShadow: "0 0 2px rgba(0,0,0,0.05)",
          opacity: visible ? 1 : 0,
          transform: visible ? "translateY(0)" : "translateY(6px)",
          filter: visible ? "blur(0)" : "blur(2px)",
          transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`,
        }}
      >
        {SLOGANS[index]}
      </span>
    </div>
  );
}
