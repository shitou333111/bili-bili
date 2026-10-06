"use client";

/**
 * 展示页面（/display）：1920x1080 / 1080x1920 画布，供直播软件「浏览器源」透明叠加到直播画面，
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
    // 每 500ms 把缓冲批量转发到 WS。
    // WS 未就绪（懒连接的 CONNECTING 期 / 连接失败）时必须把批次放回缓冲重试——
    // 旧逻辑 splice 后直接 return，该批日志永久丢失，正是"console 有输出但主窗口/落盘
    // 日志里什么都没有"的成因之一。缓冲加 500 条上限防 WS 长期不通时无限增长。
    const flush = setInterval(() => {
      if (!buf.length) return;
      const batch = buf.splice(0, buf.length);
      const requeue = () => {
        buf.unshift(...batch);
        if (buf.length > 500) buf.splice(0, buf.length - 500);
      };
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        try {
          ensureWs();
        } catch {
          requeue();
          return;
        }
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          requeue();
          return;
        }
      }
      try {
        ws.send(JSON.stringify({ type: "log", level: "log", text: batch.join("\n") }));
      } catch {
        requeue();
      }
    }, 500);
    return () => {
      clearInterval(flush);
      orig.forEach(([l, fn]) => {
        (console as any)[l] = fn;
      });
      if (ws) ws.close();
    };
  }, []);

  // ?diag=1 性能探针（仅诊断模式启用）：**每次进场特效（入场提示/入场动画）开始播放时**
  // 开启一个 8s 采样窗口（而非页面打开就采——那样采到的全是无特效的空闲画面，测不到有效数据）。
  // 采样内容：rAF 节拍分布（均值/P50/P95/max、>50ms 长帧数、实际 FPS）、每帧 canvas.arc 调用峰值
  // （≈同屏粒子数，圆形粒子每粒子每帧 1 次 arc）、主线程 longtask、dpr/视口/画布 zoom/各 canvas
  // 尺寸与 UA。归因探针（_diagAttr24）：另记长帧明细（t/gap/前帧粒子量）、5ms 主线程任务节拍
  // （长帧期间节拍照常=帧没产出来，合成/GPU/OSR 层；节拍也断=主线程被非 JS 工作堵住）、
  // visibility 变化（排查 OSR 可见性闪烁限流 rAF）。每窗口结果 console 输出，经上方 WS 转发回主窗口（[画布] 前缀）——直播姬浏览器源
  // 访问 /display?diag=1，触发几次进场特效即可取到该环境（CEF OSR）特效播放中的实测数，
  // 与 Chrome 对照定位卡顿根因。特效触发经 display-effect-play 事件通知（DisplayCanvas 派发）。
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("diag")) return;
    const SAMPLE_MS = 8000; // 每窗口采样时长
    const MAX_WINDOWS = 4; // 最多采样窗口数（每次特效触发开一窗，用尽即整体停止）
    let windowNo = 0;
    let triggerKind = ""; // 当前窗口对应的特效触发类型（entry/anime）
    const intervals: number[] = [];
    const longTasks: number[] = [];
    // 归因数据（补丁 _diagAttr24）：长帧明细 + 主线程任务节拍 + visibility 变化。
    // 修复后 longtask 已大降但长帧仍在（实测 19 个 / max 266.7ms / 仅 1 个 56ms longtask）
    // → 停顿大概率不在主线程 JS。此三组数据把长帧归因到：
    // ① 粒子/光晕动画期（blur 重光栅）② 常驻逐帧重绘（跑马灯/渐变滚动/动画图解码）
    // ③ 合成/GPU/OSR 帧投递（直播姬环境）——三者修复手段不同，先取证再改。
    const longFrames: { t: number; gap: number; arc: number }[] = [];
    const tickGaps: number[] = [];
    const visChanges: string[] = [];
    let winStart = 0;
    let visAtStart = "";
    let arcThisFrame = 0; // 当前帧 arc 调用数
    let arcPeak = 0; // 单帧 arc 峰值 ≈ 粒子数峰值
    // 粒子库逐帧耗时基线（补丁 _diagDraw24 累加到 window，窗口开始时记读数、结束取增量）
    let pebUpd0 = 0;
    let pebRender0 = 0;
    let pebLoop0 = 0;
    let frames = 0;
    let rafId = 0;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let onVis: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let po: PerformanceObserver | null = null;
    let stopped = false;

    // 计数桩：包装 arc()（仅采样期间生效，全部结束即还原）
    const proto = CanvasRenderingContext2D.prototype;
    const origArc = proto.arc;
    proto.arc = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      arcThisFrame++;
      return (origArc as any).apply(this, args);
    };

    // 可观测性：探针启用瞬间即输出一行，让"探针到底跑没跑"一眼可判。
    // （旧版唯一输出点是 report，要等首次触发后 8s 才打印；触发被忽略时全程零输出，无法区分
    //  "探针没启用 / 触发没派发 / 窗口用尽静默停止"三种情况。）
    console.info(
      `[diag] 浏览器源环境探针已就绪（?diag=1）：每次进场特效触发开 1 个 ${SAMPLE_MS / 1000}s 采样窗口，最多 ${MAX_WINDOWS} 个`,
    );

    /** 开启一个采样窗口：rAF 节拍 + 每帧 arc 计数 + longtask + 归因（长帧明细/主线程节拍/visibility） */
    const startWindow = () => {
      windowNo++;
      intervals.length = 0;
      longTasks.length = 0;
      longFrames.length = 0;
      tickGaps.length = 0;
      visChanges.length = 0;
      arcPeak = 0;
      // 必须清零：窗口间隙（report 后到下次触发前）探针 rAF 已停，粒子库若仍在绘制，
      // arc 会持续累加到 arcThisFrame——不清零则新窗口首帧把整个间隙的 arc 记成峰值
      // （实测窗口 2~4 峰值虚报 15.7万~16.9万，实际同屏仅 ~2000）
      arcThisFrame = 0;
      frames = 0;
      winStart = performance.now();
      visAtStart = document.visibilityState;
      pebUpd0 = (window as any).__pebUpdMs || 0;
      pebRender0 = (window as any).__pebRenderMs || 0;
      pebLoop0 = (window as any).__pebLoopN || 0;
      let last = performance.now();
      rafId = requestAnimationFrame(function loop(now: number) {
        const gap = now - last;
        intervals.push(gap);
        // 长帧明细：t=窗口内时刻、arc≈前一帧粒子绘制量（探针回调先于库绘制回调执行）
        if (gap > 50) longFrames.push({ t: now - winStart, gap, arc: arcThisFrame });
        last = now;
        frames++;
        if (arcThisFrame > arcPeak) arcPeak = arcThisFrame;
        arcThisFrame = 0;
        if (!stopped) rafId = requestAnimationFrame(loop);
      });
      // 主线程任务节拍（5ms 定时器）：与 rAF 对照归因长帧——
      // 长帧期间节拍照常 → 主线程空闲、帧没产出来（合成/GPU/OSR 帧投递层）；
      // 长帧期间节拍也断 → 主线程被非 JS 工作（样式/布局/绘制/图片解码/GC）堵住
      let lastTick = performance.now();
      tickTimer = setInterval(() => {
        const t = performance.now();
        tickGaps.push(t - lastTick);
        lastTick = t;
      }, 5);
      onVis = () => {
        visChanges.push(`${Math.round(performance.now() - winStart)}ms:${document.visibilityState}`);
      };
      document.addEventListener("visibilitychange", onVis);
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(e.duration);
        });
        po.observe({ entryTypes: ["longtask"] });
      } catch {
        po = null;
      }
      timer = setTimeout(report, SAMPLE_MS);
    };

    /** 结算当前窗口并输出（窗口数用尽则整体收尾；否则等下一次特效触发再开窗） */
    const report = () => {
      timer = null;
      cancelAnimationFrame(rafId);
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = null;
      if (onVis) document.removeEventListener("visibilitychange", onVis);
      onVis = null;
      po?.disconnect();
      po = null;
      // 统计（区间按升序取分位）
      const sorted = [...intervals].sort((a, b) => a - b);
      const pct = (p: number) =>
        sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
      const mean = intervals.length ? intervals.reduce((s, v) => s + v, 0) / intervals.length : 0;
      const long = intervals.filter((v) => v > 50).length;
      // 归因结算：主线程任务节拍 vs 长帧
      const tickMax = tickGaps.length ? Math.max(...tickGaps) : 0;
      const tickLong = tickGaps.filter((v) => v > 50).length;
      const verdict =
        long === 0
          ? ""
          : tickLong === 0
            ? " → 长帧期间主线程空闲 = 帧没产出来（合成/GPU/OSR 帧投递层，非 JS）"
            : " → 长帧期间主线程也被堵（非 JS 工作：样式/布局/绘制/图片解码/GC）";
      // 归因结算：粒子库逐帧实测耗时增量（补丁 _diagDraw24）
      // render 大 → canvas 状态切换/arc/fill 是主嫌；update 大 → JS 数学；两者都小 → 嫌疑在
      // 粒子 canvas 之外（EntryBadge blur 光晕 / gift-bar 渐变 / 合成与 OSR 帧投递）
      const pebUpd = ((window as any).__pebUpdMs || 0) - pebUpd0;
      const pebRender = ((window as any).__pebRenderMs || 0) - pebRender0;
      const pebLoop = ((window as any).__pebLoopN || 0) - pebLoop0;
      const info = [
        `窗口 ${windowNo}/${MAX_WINDOWS}（${triggerKind}触发）：采样 ${SAMPLE_MS}ms / ${frames} 帧 → 实际 FPS ${(frames / (SAMPLE_MS / 1000)).toFixed(1)}`,
        `rAF 间隔 ms：均值 ${mean.toFixed(1)} | P50 ${pct(50).toFixed(1)} | P95 ${pct(95).toFixed(1)} | max ${pct(100).toFixed(1)} | >50ms 长帧 ${long}`,
        `长帧明细（t=窗口内ms / gap / arc≈前帧粒子量）：${
          longFrames.map((f) => `${Math.round(f.t)}/${f.gap.toFixed(0)}/a${f.arc}`).join(" ") || "无"
        }`,
        `主线程任务节拍（5ms 定时器）：均值 ${(tickGaps.length ? tickGaps.reduce((s, v) => s + v, 0) / tickGaps.length : 0).toFixed(1)}ms | max ${tickMax.toFixed(0)}ms | >50ms ${tickLong} 次${verdict}`,
        `visibility：起始 ${visAtStart}${visChanges.length ? `，变化 ${visChanges.join(" ")}` : "（窗口内无变化）"}`,
        `粒子绘制峰值：单帧 arc=${arcPeak}（≈同屏粒子数）`,
        `粒子库逐帧实测：${pebLoop} 帧 | update JS ${pebUpd.toFixed(0)}ms + render ${pebRender.toFixed(0)}ms（均 ${(pebLoop ? pebRender / pebLoop : 0).toFixed(2)}ms/帧，占窗口 ${((pebRender / SAMPLE_MS) * 100).toFixed(1)}%）`,
        `longtask ${longTasks.length} 个${longTasks.length ? `，总 ${longTasks.reduce((s, v) => s + v, 0).toFixed(0)}ms，max ${Math.max(...longTasks).toFixed(0)}ms` : ""}`,
        ...(windowNo === 1
          ? [
              `dpr=${window.devicePixelRatio} 视口=${window.innerWidth}x${window.innerHeight} zoom=${(() => {
                const el = Array.from(document.querySelectorAll<HTMLDivElement>("div")).find(
                  (d) => d.style.zoom && d.style.zoom !== "normal",
                );
                return el?.style.zoom || "?";
              })()} canvas=[${Array.from(document.querySelectorAll("canvas"))
                .map((c) => `${c.width}x${c.height}px(${Math.round(c.getBoundingClientRect().width)}css)`)
                .join(", ") || "无"}]`,
              `UA=${navigator.userAgent}`,
            ]
          : []),
      ];
      console.info(`[diag] 浏览器源环境探针 ${info.join("\n")}`);
      if (windowNo >= MAX_WINDOWS) {
        stopped = true;
        proto.arc = origArc;
      }
    };

    /** 进场特效开始播放（DisplayCanvas 派发 display-effect-play）→ 开启采样窗口；
     *  窗口采样中忽略（不覆盖正在采样的数据）；窗口数用尽时明示已停止（不再静默） */
    const onEffectPlay = (e: Event) => {
      if (stopped || windowNo >= MAX_WINDOWS) {
        console.info(
          `[diag] 进场特效已触发，但窗口数已用尽（${windowNo}/${MAX_WINDOWS}），探针停止采样——刷新 /display?diag=1 页面可重新启用`,
        );
        return;
      }
      if (timer) return; // 本窗口仍在采样（8s 内的重复触发），静默忽略属正常
      triggerKind = (e as CustomEvent).detail?.kind === "anime" ? "入场动画" : "入场提示";
      startWindow();
      // 触发即输出心跳：即使 8s 后的 report 没来，也能证明"事件已派发、窗口已开启"
      console.info(
        `[diag] 窗口 ${windowNo}/${MAX_WINDOWS} 开启（${triggerKind}触发），${SAMPLE_MS / 1000}s 后输出采样结果`,
      );
    };
    window.addEventListener("display-effect-play", onEffectPlay);
    return () => {
      stopped = true;
      window.removeEventListener("display-effect-play", onEffectPlay);
      cancelAnimationFrame(rafId);
      if (timer) clearTimeout(timer);
      if (tickTimer) clearInterval(tickTimer);
      if (onVis) document.removeEventListener("visibilitychange", onVis);
      po?.disconnect();
      proto.arc = origArc;
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