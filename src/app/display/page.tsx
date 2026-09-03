"use client";

/**
 * 展示窗口页面（/display）：1080x720 画布，供直播软件"窗口捕捉"叠加到直播画面。
 *
 * 注意：该页面只加载画布（不含主应用导航/头部），画布自适应缩放铺满窗口。
 *
 * 窗口无系统标题栏（decorations:false），因此点击画布空白区域按住时可拖动窗口；
 * 两个可拖动元素（礼物/入场提示）带 data-window-movable 标记，点击它们交给元素自身拖动，
 * 不触发窗口拖动（实现细节见页面底部的 onPointerDown）。
 */
import { useCallback, useEffect } from "react";
import DisplayCanvas from "@/components/display/DisplayCanvas";

export default function DisplayPage() {
  // 展示画布与主窗口同进程（独立窗口）：允许真实关闭，不拦截（任务栏红叉 / Alt+F4 /
  // 标题栏 × 都发 WM_CLOSE → close-requested）。关闭后窗口即销毁；总开关再次开启时
  // 主进程重新 show 出一个全新画布，直播姬按类名自动重新捕捉。不 preventDefault，
  // 仅顺手经 Tauri emitTo("main",...) 通知主面板"画布已关"，让总开关置为关（兜底同步状态）。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(() => {
          import("@tauri-apps/api/event").then(({ emitTo }) => {
            emitTo("main", "display-window-closed");
          });
        });
      } catch {
        /* 非 Tauri（如浏览器预览）下无窗口，忽略 */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // 调试辅助：把本窗口（/display 画布）的 console 日志转发到主窗口（label=main）。
  // 逐条异步 emit 在高频时易丢，这里用内存缓冲 + 定时批量 flush，保证阶段性日志零丢失地
  // 送达主窗口（emitTo "display-console"），供主面板打印（[画布] 前缀）。
  useEffect(() => {
    const levels = ["log", "info", "warn", "error"] as const;
    const orig = levels.map((l) => [l, (console as any)[l]] as const);
    const safeString = (v: unknown) => {
      if (typeof v === "string") return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    };
    const buf: string[] = [];
    const forward = (level: string) => (...args: unknown[]) => {
      buf.push(`[${level}] ${args.map(safeString).join(" ")}`);
      const origFn = (orig.find(([l]) => l === level)?.[1] as (...a: unknown[]) => void) ?? console.log;
      origFn.apply(console, args);
    };
    (console as any).log = forward("log");
    (console as any).info = forward("info");
    (console as any).warn = forward("warn");
    (console as any).error = forward("error");
    // 每 500ms 把缓冲一次性批量转发
    const flush = setInterval(() => {
      if (!buf.length) return;
      const batch = buf.splice(0, buf.length);
      const text = batch.join("\n");
      import("@tauri-apps/api/event").then(({ emitTo }) => {
        emitTo("main", "display-console", { level: "log", text });
      });
    }, 500);
    return () => {
      clearInterval(flush);
      orig.forEach(([l, fn]) => {
        (console as any)[l] = fn;
      });
    };
  }, []);

  // 无标题栏窗口的空白区域拖动：点中可拖动元素（带 data-window-movable）时跳过，
  // 其余位置按住即调用 Tauri 的 startDragging 移动窗口。
  const onPointerDown = useCallback(async (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 点中礼物/入场提示等可拖动元素时不做窗口拖动
    const target = e.target as HTMLElement;
    if (target.closest && target.closest("[data-window-movable]")) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch {
      /* 非 Tauri / Web 模式下无拖窗能力，忽略 */
    }
  }, []);

  return (
    <div
      className="w-screen h-screen bg-[#B7EBA4] overflow-hidden flex items-center justify-center select-none"
      onPointerDown={onPointerDown}
    >
      <DisplayCanvas />
    </div>
  );
}