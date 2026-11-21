"use client";

import InAppWebViewer from "@/components/InAppWebViewer";

/** APP 内嵌黑白榜的三种入口（与 /hbb 顶部模式一一对应） */
export type LeaderboardBoardMode = "user-blind" | "user-synthesis" | "anchor-blind";

/**
 * APP 内黑白榜查看器：全屏 iframe 打开 /hbb（按入口带上 mode），
 * 顶栏提供返回、外链地址（点击交给系统浏览器打开）与「复制网址分享」。
 */
export default function LeaderboardViewer({
  mode,
  onBack,
}: {
  mode: LeaderboardBoardMode;
  onBack: () => void;
}) {
  return (
    <InAppWebViewer
      path={`/hbb?mode=${mode}`}
      title="B瓜黑白榜"
      displayUrl="bili-bili.icu/hbb"
      shareUrl="https://bili-bili.icu/hbb"
      onBack={onBack}
    />
  );
}
