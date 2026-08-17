"use client";

import { useEffect } from "react";
import WindowTitleBar from "@/components/WindowTitleBar";
import SafeAreaStyler from "@/components/SafeAreaStyler";

/**
 * 页面级错误边界（Next.js error.tsx）。
 *
 * 与 not-found 同理：Tauri 桌面下必须渲染 WindowTitleBar，避免错误页全屏覆盖自绘标题栏导致无法操作。
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("页面渲染错误:", error);
  }, [error]);

  return (
    <div
      className="min-h-screen flex flex-col bg-[#faf9f6] text-[#1f1c17]"
      style={{ paddingTop: "var(--safe-top, 0px)" }}
    >
      <SafeAreaStyler />
      <WindowTitleBar />
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="text-4xl font-bold mb-3">页面出错了</div>
        <p className="text-sm text-black/55 mb-6">页面渲染发生异常，请尝试重新加载</p>
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-[#1f1c17] px-5 py-2 text-sm text-white transition hover:opacity-90"
        >
          重新加载
        </button>
      </div>
    </div>
  );
}
