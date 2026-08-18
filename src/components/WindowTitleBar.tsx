"use client";

import { useEffect, useState } from "react";
import { DESKTOP_TITLEBAR_H } from "@/lib/layout";

/**
 * PC 端自定义窗口标题栏（仅 Tauri 桌面环境显示，移动端/浏览器不显示）。
 *
 * 配合 tauri.conf.json 的 "decorations": false 使用：
 * 移除系统标题栏后，由本组件渲染窗口控制按钮（置顶 / 最小化 / 关闭）。
 *
 * 全部使用 Tauri 官方 @tauri-apps/api/window：
 *   - setAlwaysOnTop / isAlwaysOnTop：窗口置顶
 *   - minimize / close             ：窗口控制
 * 标题栏区域通过官方 data-tauri-drag-region 属性实现窗口拖动。
 * 对应 Rust 命令需在 capabilities 中授权。
 */
export default function WindowTitleBar() {
  const [supported, setSupported] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (!isTauri) return;

    // 移动端（iOS/Android）为全屏窗口，无系统标题栏，不渲染本组件
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod|Android/.test(ua)) return;

    let disposed = false;
    import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (disposed) return;
        const win = getCurrentWindow();
        setSupported(true);
        try {
          setPinned(await win.isAlwaysOnTop());
        } catch {
          // 权限不足时按默认状态处理
        }
      })
      .catch(() => {
        // API 不可用时保持不显示
      });

    return () => {
      disposed = true;
    };
  }, []);

  if (!supported) return null;

  const control = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch {
      // 操作失败（如权限未授权）静默忽略
    }
  };

  const getWindow = () =>
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow());

  return (
    <div
      data-tauri-drag-region
      className="fixed inset-x-0 top-0 z-[99999] flex select-none items-center border-b border-black/10 bg-[#eab308] text-white"
      style={{ height: DESKTOP_TITLEBAR_H }}
    >
      {/* 左侧：应用图标 + 标题（可拖拽区域） */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pl-2.5">
        <img src="/orig_icon.png" alt="" width={16} height={16} className="h-4 w-4" draggable={false} />
        <span className="text-[13px] font-medium text-white">B瓜</span>
      </div>

      {/* 右侧：窗口控制按钮，置顶在最左侧（紧邻最小化） */}
      <div data-tauri-drag-region className="ml-auto flex h-full items-center">
        {/* 置顶按钮 */}
        <button
          type="button"
          aria-pressed={pinned}
          title={pinned ? "取消窗口置顶" : "窗口置顶"}
          onClick={control(async () => {
            const win = await getWindow();
            await win.setAlwaysOnTop(!pinned);
            setPinned((v) => !v);
          })}
          className={`flex h-full w-10 items-center justify-center transition-colors ${
            pinned ? "bg-white text-[#1f1c17]" : "text-white/60 hover:bg-white/10 hover:text-white"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: pinned ? "rotate(45deg)" : "none", transition: "transform 0.2s ease" }}
            aria-hidden="true"
          >
            <path d="M9 4h6v6l2 2v2H7v-2l2-2V4Z" />
            <path d="M12 14v6" />
          </svg>
        </button>

        {/* 最小化 */}
        <button
          type="button"
          title="最小化"
          onClick={control(async () => {
            const win = await getWindow();
            await win.minimize();
          })}
          className="flex h-full w-10 items-center justify-center text-white/60 hover:bg-white/10 hover:text-white"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        </button>

        {/* 关闭 */}
        <button
          type="button"
          title="关闭"
          onClick={control(async () => {
            const win = await getWindow();
            await win.close();
          })}
          className="flex h-full w-10 items-center justify-center text-white/60 hover:bg-[#e81123] hover:text-white"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
