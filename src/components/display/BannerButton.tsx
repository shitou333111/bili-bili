"use client";

/**
 * 横幅 —— 严格参照 scripts/banner-sample.html 的 ".party-button" 彩虹胶囊样式
 * （渐变底 + ::before 外发光光晕 + 4s 渐变流动动画，CSS 统一放在 globals.css）。
 *
 * - 文字由外部传入（面板失焦后经 WS 同步的完整内容），宽度随文字自适应（width:max-content 由 MovableBox 提供）
 * - 纯展示元素（普通 div，非 button）：无任何点击/聚焦语义，仅可移动/缩放，鼠标悬停即显示拖拽光标
 * - 挂载/文字变化后实测宽度上报父级，用于"默认位置水平居中"计算（仅用户未自定义位置时）
 */
import { useLayoutEffect, useRef } from "react";

export default function BannerButton({
  text,
  onMeasure,
}: {
  /** 已提交的按钮文字（输入中不更新，失焦才换新值） */
  text: string;
  /** 测量横幅实际宽度（挂载/文字变化时同步回调，供父级动态水平居中） */
  onMeasure?: (width: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 文字变化会改变横幅宽度：每次渲染前重新测量并上报（useLayoutEffect 绘制前执行，无闪烁）
  useLayoutEffect(() => {
    if (onMeasure && ref.current) {
      onMeasure(ref.current.offsetWidth);
    }
  }, [onMeasure, text]);

  return (
    <div ref={ref} className="party-button">
      {text}
    </div>
  );
}
