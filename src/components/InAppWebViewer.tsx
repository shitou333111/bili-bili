"use client";

import { useEffect, useRef, useState } from "react";
import { serverApiUrl } from "@/lib/server-api";

/**
 * APP 内嵌网页查看器：全屏 iframe 打开站内页面，
 * 顶栏提供返回、外链地址（点击交给系统浏览器打开）与「复制网址分享」。
 */
export default function InAppWebViewer({
  path,
  title,
  displayUrl,
  shareUrl,
  onBack,
}: {
  /** 站内页面路径（可带查询参数，如 /hbb?mode=user-blind） */
  path: string;
  /** iframe 标题（无障碍用） */
  title: string;
  /** 顶栏中间展示的地址文案，如 bili-bili.icu/red */
  displayUrl: string;
  /** 点击外开 / 复制分享使用的完整地址 */
  shareUrl: string;
  onBack: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // 剪贴板 API 不可用时降级
      const el = document.createElement("textarea");
      el.value = shareUrl;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* 顶栏：paddingTop 取全局 --safe-top，避开桌面窗口标题栏 / 手机状态栏 */}
      <div
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-black/5 bg-white/90 px-3 pb-2 backdrop-blur"
        style={{ paddingTop: "calc(var(--safe-top, 0px) + 8px)" }}
      >
        <button
          onClick={onBack}
          className="-ml-1 flex items-center gap-1.5 justify-self-start rounded-lg px-2.5 py-1.5 text-sm text-black/60 transition hover:bg-black/5 hover:text-black/90 active:scale-95"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>

        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm font-semibold text-[#5b3fa8] underline decoration-[#c9b8ee] underline-offset-2"
        >
          {displayUrl}
        </a>

        <button
          onClick={copyShare}
          className="justify-self-end rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-sm text-black/60 transition hover:bg-black/5 hover:text-black/90 active:scale-95"
        >
          {copied ? <span className="text-[#2e9e6b]">已复制</span> : "复制网址分享"}
        </button>
      </div>

      {/* 内容：直接展示站内页面；Tauri 内取服务器地址，Web/PWA 为相对路径 */}
      <iframe
        src={serverApiUrl(path)}
        title={title}
        className="h-full w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
