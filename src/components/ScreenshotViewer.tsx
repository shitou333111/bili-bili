"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 复活曲截图查看器：在 APP 内（WebView）以 iframe 嵌入服务器页面，
 * 保持应用外壳与返回按钮，避免整页跳转时服务器不可达而出现丑陋的浏览器报错页。
 *
 * - 加载中：显示进度指示。
 * - 服务器可达：iframe 正常显示，内容随服务器实时更新。
 * - 服务器不可达（超时）：显示自绘的错误面板，提供"重试"与"返回首页"按钮。
 */
export default function ScreenshotViewer({
  url,
  onBack,
}: {
  url: string;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const timerRef = useRef<number | null>(null);

  const reset = () => {
    setStatus("loading");
    if (timerRef.current) window.clearTimeout(timerRef.current);
    // 10 秒内 iframe 未触发 onLoad 视为服务器不可达
    timerRef.current = window.setTimeout(() => {
      setStatus((s) => (s === "loading" ? "error" : s));
    }, 10000);
  };

  useEffect(() => {
    reset();
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* 顶栏：paddingTop 取全局 --safe-top —— 手机端避开状态栏/刘海（SafeAreaStyler 注入），
          PC 端避开自定义窗口标题栏（--safe-top = DESKTOP_TITLEBAR_H，否则返回栏被其遮住） */}
      <div
        className="flex items-center gap-3 px-3 pb-2 border-b border-black/5 bg-white/90 backdrop-blur"
        style={{ paddingTop: "calc(var(--safe-top, 0px) + 8px)" }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>
        <span className="text-sm font-semibold">复活曲截图</span>
        {status === "error" && (
          <span className="ml-auto text-xs text-red-500">网络异常</span>
        )}
      </div>

      {/* 内容区 */}
      <div className="relative flex-1">
        {/* 加载中 */}
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-black/10 border-t-black/50" />
            <div className="text-xs text-black/40">正在加载…</div>
          </div>
        )}

        {/* 服务器不可达：自绘错误面板，不显示浏览器报错页 */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white px-8">
            <div className="text-4xl">📡</div>
            <div className="text-center">
              <div className="text-base font-semibold text-black/80">无法访问页面</div>
              <div className="mt-1 text-xs text-black/45">
                服务器响应超时，可能未启动或网络异常
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={reset}
                className="rounded-lg border border-black/10 bg-white px-4 py-2 text-sm text-black/70 hover:bg-black/5 transition active:scale-95"
              >
                重试
              </button>
              <button
                onClick={onBack}
                className="rounded-lg bg-[#1f1c17] px-4 py-2 text-sm text-white font-medium hover:opacity-90 transition active:scale-95"
              >
                返回首页
              </button>
            </div>
          </div>
        )}

        {/* iframe：加载成功后覆盖加载层 */}
        <iframe
          src={url}
          title="复活曲截图"
          className={`h-full w-full border-0 bg-white ${status === "ok" ? "block" : "opacity-0 pointer-events-none absolute"}`}
          onLoad={() => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
            setStatus("ok");
          }}
        />
      </div>
    </div>
  );
}
