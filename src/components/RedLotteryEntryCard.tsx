"use client";

import { useState } from "react";
import InAppWebViewer from "@/components/InAppWebViewer";

/**
 * 帮助页「天选红包」入口：点击在 APP 内以全屏 iframe 打开 /red，
 * 只展示直播间列表，参与需用户自行进入直播间。
 */
export default function RedLotteryEntryCard() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-black/10 bg-white/80 px-4 py-3 text-left shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur transition hover:border-black/20 hover:shadow-lg"
      >
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/red_pocket.png"
            alt="天选红包"
            className="h-9 w-9 shrink-0 select-none object-contain"
          />
          <div className="min-w-0">
            <h3 className="text-base font-bold">天选红包列表</h3>
            <p className="mt-0.5 text-xs text-black/45">
              提供正在发放天选/红包的直播间列表，可手动参与抽奖
            </p>
          </div>
          <svg
            className="ml-auto h-4 w-4 shrink-0 text-black/30"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>
      </button>

      {open && (
        <InAppWebViewer
          path="/red"
          title="B瓜 · 天选红包列表"
          displayUrl="bili-bili.icu/red"
          shareUrl="https://bili-bili.icu/red"
          onBack={() => setOpen(false)}
        />
      )}
    </>
  );
}
