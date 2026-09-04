"use client";

/**
 * 展示页面（/display）：960x540 / 540x960 画布，供直播软件「浏览器源」透明叠加到直播画面，
 * 或由 APP 内「编辑布局」模态框 iframe（?mode=edit）加载做编排。
 *
 * 与旧「独立 Tauri 窗口 + 窗口捕捉」不同：本页面不再有任何窗口逻辑（无标题栏拖动、
 * 无关闭事件、无 convertFileSrc），浏览器源通过 http://127.0.0.1:<port>/display 访问，
 * 直播姬设置透明背景后直接叠加即可，无需窗口捕捉。
 *
 * 容器背景完全透明（bg-transparent）：浏览器源一键抠除透明背景叠加到直播画面。
 *
 * 调试辅助：把画布/浏览器源的 console 日志兜底转发到 WS（{type:"log"}），由主进程
 * 侧打印（[画布] 前缀）。仅在 WS 已连接时发送，避免页面就绪前或服务未启动时误发。
 */
import { useEffect } from "react";
import DisplayCanvas from "@/components/display/DisplayCanvas";

export default function DisplayPage() {
  // 调试辅助：把本页面（浏览器源画布）的 console 日志转发到主进程（经 WS）。
  // 逐条高频日志易丢，这里内存缓冲 + 定时批量 flush，保证阶段性日志零丢失地送达。
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
    let ws: WebSocket | null = null;
    // 懒连 WS：首次有日志时才建立，且只在同源提供服务时可用
    const ensureWs = () => {
      if (ws && ws.readyState <= WebSocket.OPEN) return;
      try {
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      } catch {
        ws = null;
      }
    };
    const forward = (level: string) => (...args: unknown[]) => {
      const text = args.map(safeString).join(" ");
      buf.push(`[${level}] ${text}`);
      const origFn = (orig.find(([l]) => l === level)?.[1] as (...a: unknown[]) => void) ?? console.log;
      origFn.apply(console, args);
    };
    (console as any).log = forward("log");
    (console as any).info = forward("info");
    (console as any).warn = forward("warn");
    (console as any).error = forward("error");
    // 每 500ms 把缓冲批量转发到 WS
    const flush = setInterval(() => {
      if (!buf.length) return;
      const batch = buf.splice(0, buf.length);
      const text = batch.join("\n");
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        try {
          ensureWs();
        } catch {
          return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
      }
      ws.send(JSON.stringify({ type: "log", level: "log", text }));
    }, 500);
    return () => {
      clearInterval(flush);
      orig.forEach(([l, fn]) => {
        (console as any)[l] = fn;
      });
      if (ws) ws.close();
    };
  }, []);

  // 画布需完全透明（浏览器源抠底叠加）：全局样式把 html/body 背景设为 #f5f5f5，
  // 直播姬浏览器源会把这层不透明近白底显示出来（纯白画面）无法抠除，
  // 这里在 /display 页面上强制把文档背景改为透明，让元素之外全部为 alpha=0。
  useEffect(() => {
    const de = document.documentElement;
    const body = document.body;
    const prevHtml = de.style.background;
    const prevBody = body.style.background;
    de.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      de.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  return (
    <div className="w-screen h-screen bg-transparent overflow-hidden flex items-center justify-center select-none">
      <DisplayCanvas />
    </div>
  );
}