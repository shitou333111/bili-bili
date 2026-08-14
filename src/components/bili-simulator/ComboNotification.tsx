"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import type { Gift } from "./types";

interface ComboNotificationProps {
  gift: Gift;
  count: number;
  userName?: string;
  isPanelOpen?: boolean;
  isAnimating?: boolean;
  stackIndex?: number;
  evicting?: boolean;
  onDismiss?: () => void;
}

// 获取数字的每一位
function getNumberDigits(num: number): string[] {
  return String(num).split("");
}

// 数字SVG组件
function DigitImage({ digit }: { digit: string }) {
  return (
    <img
      src={`/combo/combo-${digit}.svg`}
      alt={digit}
      className="h-full"
      style={{ imageRendering: "auto" }}
    />
  );
}

export default function ComboNotification({
  gift,
  count,
  userName = "我",
  isPanelOpen = false,
  isAnimating = false,
  stackIndex = 0,
  evicting = false,
  onDismiss,
}: ComboNotificationProps) {
  const [slidIn, setSlidIn] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [bounce, setBounce] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);

  // 始终引用最新的 onDismiss，但不让它触发效果重跑
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const digits = useMemo(() => getNumberDigits(count), [count]);

  // 仅在连击次数变化时触发：从底部滑入 + 弹跳 + 3秒后向上隐去
  useEffect(() => {
    setSlidIn(true);
    setLeaving(false);
    setBounce(true);
    const bounceTimer = setTimeout(() => setBounce(false), 300);

    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setSlidIn(false);
      setLeaving(true);
      setTimeout(() => {
        onDismissRef.current?.();
      }, 400);
    }, 3000);

    return () => {
      clearTimeout(bounceTimer);
    };
  }, [count]);

  // 卸载时清理隐藏计时器，避免对已卸载组件触发 onDismiss
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // 被顶出时：向上隐去并通知父组件移除（用于新礼物顶掉最早的横幅）
  useEffect(() => {
    if (evicting) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setSlidIn(false);
      setLeaving(true);
      const t = setTimeout(() => onDismissRef.current?.(), 400);
      return () => clearTimeout(t);
    }
  }, [evicting]);

  // 位置：动画播放时推到最高；面板展开时在面板上方；面板收起时固定在距底部300px处。
  // stackIndex 用于多条横幅纵向堆叠（从底部往上排列）
  const stackOffset = stackIndex * 44;
  const bottom = isAnimating
    ? `calc(max(52vh, 340px) + 120px + ${stackOffset}px)`
    : isPanelOpen
    ? `calc(max(52vh, 340px) + 26px + ${stackOffset}px)`
    : `${300 + stackOffset}px`;

  return (
    <div
      className="absolute left-4 z-20 pointer-events-none"
      style={{ bottom, transition: "bottom 0.4s ease-out" }}
    >
      <style>{`
        @keyframes comboMiniBounce {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>
      <div
        className="relative flex items-center h-7"
        style={{
          // 未显示：下方待命；进入：从底部滑入；离开：向上隐去
          transform: leaving
            ? "translateY(-160%)"
            : slidIn
            ? "translateY(0)"
            : "translateY(150%)",
          opacity: leaving ? 0 : slidIn ? 1 : 0,
          transition: "transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.4s ease-out",
        }}
      >
        {/* 斜角长条背景 - 更淡更透明，更窄更矮 */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-full"
          style={{
            width: "205px",
            background: "linear-gradient(135deg, rgba(60,90,160,0.5) 0%, rgba(90,60,140,0.5) 100%)",
            clipPath: "polygon(0 0, 100% 0, calc(100% - 14px) 100%, 0 100%)",
          }}
        />

        {/* 头像 */}
        <div className="relative z-10 w-6 h-6 rounded-full overflow-hidden border-2 border-white/30 ml-0.5 shrink-0">
          <div className="w-full h-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center">
            <span className="text-white text-[10px]">📺</span>
          </div>
        </div>

        {/* 昵称和投喂文字 */}
        <div className="relative z-10 ml-1 flex flex-col justify-center shrink-0" style={{ width: "100px" }}>
          <p className="text-white text-[10px] font-medium leading-tight truncate">{userName}</p>
          <p className="text-white text-[9px] leading-tight flex items-center gap-1">
            <span>投喂</span>
            <span className="text-yellow-300 truncate">{gift.name}</span>
          </p>
        </div>

        {/* 大礼物图标 - 向左移动，与横幅右侧留出间隔 */}
        <div className="relative z-10 ml-1 mr-5 shrink-0">
          <img
            src={gift.img}
            alt={gift.name}
            className="w-8 h-8 object-contain drop-shadow-lg"
            style={{ animation: bounce ? "comboMiniBounce 0.3s ease" : undefined }}
          />
        </div>

        {/* x + 数字 - 在横幅右侧外，紧贴横幅斜线 */}
        <div className="relative z-20 flex items-end" style={{ transform: "translateX(-4px)" }}>
          <img src="/combo/combo-x.svg" alt="x" className="h-3 mb-0.5 mr-0.5" />
          <div
            className="flex items-end"
            style={{
              height: "20px",
              filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.5))",
            }}
          >
            {digits.map((d, i) => (
              <DigitImage key={`${d}-${i}`} digit={d} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
