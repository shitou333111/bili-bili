"use client";

import { useState } from "react";
import LeaderboardViewer, { type LeaderboardBoardMode } from "@/components/LeaderboardViewer";

/**
 * 「全站黑白榜」入口：粉丝页与主播页共用的同一样式链接。
 * 点击后在软件内以全屏 iframe 打开 /hbb，并按入口定位到对应榜单。
 */
export default function LeaderboardLink({
  mode,
  className = "",
}: {
  mode: LeaderboardBoardMode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`-my-2 flex w-full items-center justify-center gap-6 rounded-xl border border-black/10 bg-white/75 px-4 py-2.5 text-sm font-semibold text-black/75 shadow-[0_8px_24px_rgba(31,28,23,0.06)] backdrop-blur transition hover:bg-white hover:text-black active:scale-[0.99] ${className}`}
      >
        <span>全站黑白榜</span>
        <span className="text-[#5b3fa8] underline decoration-[#c9b8ee] underline-offset-2">
          bili-bili.icu/hbb
        </span>
      </button>

      {open && <LeaderboardViewer mode={mode} onBack={() => setOpen(false)} />}
    </>
  );
}
