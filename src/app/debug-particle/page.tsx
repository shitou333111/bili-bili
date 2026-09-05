"use client";

/**
 * 临时调试页：真实浏览器中逐帧检测粒子入场 badge 的闪现。
 * 复刻 EntryBadge 时序（60ms 延迟 → 聚合 → 停留 3s → 消散 → onDone），按周期重挂载。
 * 每帧读取 wrapper 的 computed visibility 与 content 相对 wrapper 的可见重叠宽度 ol，
 * 检测"前帧隐藏/裁剪、本帧瞬间完整可见"的闪现帧，并打印 showing 起始帧细节。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ParticleButton from "react-particle-effect-button";

const COLOR = "#003ff1";

function BadgeCycle({ n, onLog }: { n: number; onLog: (ev: string) => void }) {
  const [hidden, setHidden] = useState(true);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setHidden(false), 60);
    return () => clearTimeout(t);
  }, [n]);

  const handleComplete = useCallback(() => {
    if (!hiddenRef.current) {
      if (holdTimer.current) return;
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setHidden(true);
      }, 3000);
    } else {
      onLog(`cycle${n} DONE`);
    }
  }, [n, onLog]);

  return (
    <ParticleButton
      hidden={hidden}
      onComplete={handleComplete}
      color={COLOR}
      duration={1300}
      easing="easeInExpo"
      size={() => Math.floor(Math.random() * 4 + 3)}
      speed={() => Math.random() * 4 - 2}
      particlesAmountCoefficient={15}
      oscillationCoefficient={1}
      className="pointer-events-none"
    >
      <div
        className="inline-flex items-center gap-3 rounded-full py-[1px] border border-white/30"
        style={{
          background: "linear-gradient(90deg,hsl(0,90%,60%),hsl(30,90%,60%),hsl(60,90%,60%))",
          paddingLeft: "8px",
          paddingRight: "24px",
          color: "#fff",
          fontSize: 14,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        测试用户
      </div>
    </ParticleButton>
  );
}

export default function DebugParticlePage() {
  const [cycle, setCycle] = useState(0);
  const [flashes, setFlashes] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef(0);

  const log = useCallback((ev: string) => {
    setLogs((l) => [...l, `${(performance.now() / 1000).toFixed(2)}s ${ev}`]);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setCycle((c) => c + 1), 11500);
    return () => clearTimeout(t);
  }, [cycle]);

  useEffect(() => {
    let raf = 0;
    let prevOl = -1;
    let prevVis = "";
    let showingStarts = 0;
    const check = () => {
      const el = wrapRef.current?.firstElementChild as HTMLElement | null;
      if (el) {
        const wrapper = el.firstElementChild as HTMLElement | null;
        const content = wrapper?.firstElementChild as HTMLElement | null;
        const canvas = el.lastElementChild as HTMLCanvasElement | null;
        if (wrapper && content && canvas) {
          const vis = getComputedStyle(wrapper).visibility;
          const wb = wrapper.getBoundingClientRect();
          const cb = content.getBoundingClientRect();
          const ol = Math.max(0, Math.min(cb.right, wb.right) - Math.max(cb.left, wb.left));
          const olR = Math.round(ol);
          const cw = Math.round(cb.width);
          // canvas 尺寸信息：属性分辨率 / CSS 样式宽 / 视觉宽（缩放后）
          const cAttr = Math.round(canvas.width);
          const cCss = Math.round(parseFloat(canvas.style.width) || canvas.width);
          const cVis = Math.round(canvas.getBoundingClientRect().width);

          // 记录每次显著变化
          if (vis !== prevVis || Math.abs(olR - prevOl) > 25) {
            log(`vis=${vis} ol=${olR} cw=${cw} canvas[attr=${cAttr} css=${cCss} vis=${cVis}]`);
          }
          // showing 起始帧（vis 从 hidden 变 visible）单独标记
          if (prevVis === "hidden" && vis === "visible") {
            showingStarts++;
            log(`>> showing#${showingStarts} START: ol=${olR} cw=${cw} canvas[attr=${cAttr} css=${cCss} vis=${cVis}]`);
          }
          // 闪现检测：前帧隐藏/裁剪，本帧瞬间完整可见（ol 接近 cw 即完整可见=闪现）
          if ((prevVis === "hidden" || prevOl <= 2) && vis === "visible" && olR >= cw - 2 && olR > 2) {
            flashRef.current++;
            setFlashes(flashRef.current);
            log(`!!! FLASH#${flashRef.current}: prev(vis=${prevVis} ol=${prevOl}) -> ol=${olR} cw=${cw}`);
          }
          prevOl = olR;
          prevVis = vis;
        }
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [log]);

  return (
    <div style={{ background: "#111", minHeight: "100vh", color: "#fff", padding: 20, fontFamily: "monospace" }}>
      <h1 style={{ fontSize: 18 }}>粒子闪现检测 cycle={cycle} FLASHES={flashes}</h1>
      {/* 缩放复合场景（验证视觉缩放补丁）：zoom:0.5（编辑 iframe 960 视口看 1920 画布）
          + scale(2)（编辑布局放大），任意 _vs 下粒子与 badge 应等比一致 */}
      <div style={{ zoom: 0.5, margin: "10px 0" }}>
        <div style={{ transform: "scale(2)", transformOrigin: "top left", display: "inline-block" }}>
          <div ref={wrapRef} style={{ display: "inline-block" }}>
            <BadgeCycle key={cycle} n={cycle} onLog={log} />
          </div>
        </div>
      </div>
      <h2 style={{ fontSize: 14 }}>帧日志</h2>
      <pre style={{ fontSize: 12, maxHeight: "55vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
        {logs.slice(-200).join("\n")}
      </pre>
    </div>
  );
}
