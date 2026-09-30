"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToast, type Toast } from "@/lib/toast";

/** 淡出时长，与下面 `duration-200` 保持一致 */
const FADE_MS = 200;
/** 轻提示自动消失的时长 */
const AUTO_HIDE_MS = 5000;

/**
 * 全局轻提示宿主
 * 在布局中挂载一次，任何地方调用 showToast() 都会在此弹出。
 *
 * - `info`：黑底白字胶囊，5 秒后自动消失；
 * - `error`：浅色卡片，**不自动消失**，点一下才关，右上角可一键复制全文。
 */
export default function ToastHost() {
  /** 当前提示内容。淡出期间要留着，所以它比「可见」晚一步清空 */
  const [toast, setToast] = useState<Toast | null>(null);
  /** 是否可见（只控制透明度，做出淡入淡出） */
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const autoRef = useRef<number | null>(null);
  const fadeRef = useRef<number | null>(null);

  const dismiss = useCallback(() => {
    setShown(false);
    if (fadeRef.current) window.clearTimeout(fadeRef.current);
    // 等淡出走完再卸掉内容，否则卡片会"啪"地消失
    fadeRef.current = window.setTimeout(() => setToast(null), FADE_MS);
  }, []);

  useEffect(() => {
    const unsub = subscribeToast((t) => {
      if (autoRef.current) window.clearTimeout(autoRef.current);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
      autoRef.current = null;
      fadeRef.current = null;
      setToast(t);
      setCopied(false);
      setShown(true);
      // 只有轻提示自动消失；报错要等用户看过、点一下才关
      if (t.kind === "info") autoRef.current = window.setTimeout(dismiss, AUTO_HIDE_MS);
    });
    return () => {
      unsub();
      if (autoRef.current) window.clearTimeout(autoRef.current);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    };
  }, [dismiss]);

  const isError = toast?.kind === "error";

  return (
    <div
      className="fixed left-1/2 top-16 z-[99999] -translate-x-1/2 transition-opacity duration-200"
      style={{
        opacity: shown ? 1 : 0,
        // 轻提示不该拦住下面的点击；报错卡片要能点（关闭 / 复制）
        pointerEvents: isError && shown ? "auto" : "none",
      }}
    >
      {toast && isError ? (
        <div
          role="alert"
          onClick={() => {
            // 正在划选文字（想只复制其中一段）时别关掉
            if (window.getSelection()?.toString()) return;
            dismiss();
          }}
          title="点击关闭"
          className="max-h-[60vh] w-[min(560px,90vw)] cursor-pointer overflow-auto rounded-xl border border-red-300 bg-white/95 px-4 py-3 text-left text-sm leading-relaxed text-black/80 shadow-lg backdrop-blur"
        >
          <div className="flex items-start gap-3">
            <span className="flex-1 whitespace-pre-wrap break-words">{toast.message}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard
                  .writeText(toast.message)
                  .then(() => setCopied(true))
                  .catch(() => {});
              }}
              className="shrink-0 rounded-md border border-black/15 px-2 py-0.5 text-xs text-black/60 transition hover:bg-black/5"
            >
              {copied ? "已复制" : "复制"}
            </button>
          </div>
          <div className="mt-1.5 text-[11px] text-black/35">点击任意处关闭</div>
        </div>
      ) : null}

      {toast && !isError ? (
        <div className="rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}