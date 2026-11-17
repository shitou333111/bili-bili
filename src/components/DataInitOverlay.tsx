"use client";

import type { ReactNode } from "react";
import SloganRotator from "@/app/landing/SloganRotator";
import type { FetchProgress } from "@/lib/client-fetch";

// ==================== 首次登录 / 重建数据 的全屏初始化遮罩 ====================
// 视觉与登录页一致：顶部标题栏 + 下方功能轮播。
// 标题栏三段式：左「阶段标题」/ 中「进度文案」/ 右「进度指示器」。
//   · 消费记录：没有百分比 → 右侧用圆形旋转按钮；
//   · 流水记录：百分比已知 → 右侧用湖水填充的圆球（面积即百分比，带波动）。
// 轮播暂时用登录页轮播的前 3 张（消费记录）与前 6 张（流水记录）占位，后续可直接换素材。

/** 三个竖直居中的点，依次闪烁（用于「正在探测流水记录」的无进度阶段） */
function TypingDots() {
  return (
    <span className="ml-1.5 inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-black/55"
          style={{ animation: `init-dot 1.2s ease-in-out ${i * 0.15}s infinite` }}
        />
      ))}
    </span>
  );
}

/** 圆形旋转按钮（与主界面顶部刷新按钮同款弧线圆环） */
function ProgressRing() {
  return (
    <span
      className="block h-10 w-10 animate-spin rounded-full border-[3.5px] border-[#22c55e]/25 border-t-[#22c55e]"
      aria-hidden="true"
    />
  );
}

/** 波浪层：填充圆球底色制造波浪缺口，水平平移形成湖面荡漾 */
function Wave({ d, duration, delay, base }: { d: string; duration: number; delay: number; base: string }) {
  return (
    <svg
      className="absolute left-0 h-[8px] w-[200%]"
      style={{
        top: "-4px",
        animation: `anti-kill-wave-x ${duration}s linear infinite`,
        animationDelay: `${delay}s`,
      }}
      viewBox="0 0 200 12"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={d} fill={base} />
    </svg>
  );
}

/** 百分比圆球：水位高度 = 进度，水面是两层反向荡漾的波浪 */
function WaterBall({ ratio }: { ratio: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const base = "#151a23"; // 圆球底色（波浪用同色制造缺口）
  return (
    <div
      className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-black/10 shadow-[0_2px_10px_rgba(15,23,42,0.18)]"
      style={{ background: base }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      {/* 水面：从底部按百分比填充 */}
      <div
        className="absolute inset-x-0 bottom-0 transition-[height] duration-700 ease-out"
        style={{
          height: `${pct}%`,
          background: "linear-gradient(180deg, #34d399 0%, #22d3ee 60%, #3b82f6 100%)",
        }}
      >
        <Wave
          d="M0,0 L200,0 L200,6 C195.83,6 191.67,9 187.5,9 C183.33,9 179.17,6 175,6 C170.83,6 166.67,3 162.5,3 C158.33,3 154.17,6 150,6 C145.83,6 141.67,9 137.5,9 C133.33,9 129.17,6 125,6 C120.83,6 116.67,3 112.5,3 C108.33,3 104.17,6 100,6 C95.83,6 91.67,9 87.5,9 C83.33,9 79.17,6 75,6 C70.83,6 66.67,3 62.5,3 C58.33,3 54.17,6 50,6 C45.83,6 41.67,9 37.5,9 C33.33,9 29.17,6 25,6 C20.83,6 16.67,3 12.5,3 C8.33,3 4.17,6 0,6 Z"
          duration={4.5}
          delay={0}
          base={base}
        />
        <Wave
          d="M0,0 L200,0 L200,6 C191.67,6 183.33,8 175,8 C166.67,8 158.33,6 150,6 C141.67,6 133.33,4 125,4 C116.67,4 108.33,6 100,6 C91.67,6 83.33,8 75,8 C66.67,8 58.33,6 50,6 C41.67,6 33.33,4 25,4 C16.67,4 8.33,6 0,6 Z"
          duration={7}
          delay={-2}
          base={base}
        />
      </div>
      <span className="absolute inset-0 z-10 flex items-center justify-center text-[11px] font-bold tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
        {pct}%
      </span>
    </div>
  );
}

export default function DataInitOverlay({ progress }: { progress: FetchProgress | null }) {
  const isAnchor = !!progress?.anchorGift;
  // 首次全量探测阶段没有可靠百分比，走不定态
  const isProbe = isAnchor && (!!progress?.probe || progress?.ratio === undefined);
  const ratio = progress?.ratio;

  let title = "消费记录";
  let text: ReactNode = "正在获取消费记录";
  let showDots = false;

  if (!isAnchor) {
    // 消费记录：没有百分比，只展示页数与条数
    if (progress?.page !== undefined) {
      text = `已下载${progress.page}页（${progress.current ?? 0}条）`;
    } else if (progress?.text) {
      text = progress.text;
    }
  } else {
    title = "流水记录";
    if (progress?.probe) {
      text = "正在探测流水记录";
      showDots = true;
    } else if (progress?.month && progress?.page !== undefined && progress?.pages) {
      // 已知百分比阶段：月份 + 页码 + 剩余时间
      text = `正在下载 ${progress.month} 第${progress.page}/${progress.pages}页${progress.remain ? ` · ${progress.remain}` : ""}`;
    } else if (progress?.text) {
      text = progress.text;
    } else {
      text = "正在获取流水记录";
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex h-[100svh] flex-col overflow-hidden bg-[#f2f2f4] text-[#1f1c17]"
      // 桌面客户端的自定义窗口标题栏（decorations:false）固定在顶部，--safe-top 即其高度；
      // 移动端则是状态栏安全区。与登录页一致，顶部留出这段距离，避免标题栏被遮挡。
      style={{ paddingTop: "var(--safe-top, 0px)" }}
    >
      {/* 背景光晕：与登录页同色系（浅色灰白底上的淡色氛围） */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 80% at 18% 0%, rgba(34,197,94,0.10), transparent 60%), radial-gradient(120% 90% at 82% 100%, rgba(56,189,248,0.09), transparent 62%)",
          }}
        />
      </div>

      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col">
        {/* ============ 标题栏：左标题 / 中进度 / 右指示器（仅用下边框分隔） ============ */}
        <div className="shrink-0 border-b border-black/10">
          <header className="mx-auto flex w-full max-w-6xl items-center gap-4 px-5 py-3 sm:px-8 sm:py-3.5">
            <div className="shrink-0 text-[19px] font-semibold leading-tight tracking-wide text-[#17171b]">{title}</div>
            <div className="min-w-0 flex-1 truncate text-center text-[14px] font-medium leading-5 text-black/60">
              {text}
              {showDots && <TypingDots />}
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center">
              {isAnchor && !isProbe && ratio !== undefined ? (
                <WaterBall ratio={ratio} />
              ) : (
                <ProgressRing />
              )}
            </div>
          </header>
        </div>

        {/* ============ 占位轮播（阶段一 3 张 / 阶段二 6 张） ============ */}
        <div className="relative flex min-h-0 w-full flex-1 flex-col pb-2 sm:pb-3">
          <SloganRotator key={isAnchor ? "anchor" : "pay"} fitViewport count={isAnchor ? 6 : 3} />
        </div>
      </div>
    </div>
  );
}
