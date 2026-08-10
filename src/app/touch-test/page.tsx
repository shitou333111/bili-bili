"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 触摸诊断页 v2（/touch-test）
 * 1) 视口 HUD：显示 innerWidth/outerWidth/screen.width/visualViewport.width/clientWidth/DPR，
 *    用于判断布局视口是否被设成固定 600（PAGE_MAX_WIDTH）而 > 屏幕宽。
 * 2) 精确窄列（每列 40px）：从左到右逐列点击，找到死区结束的确切 x 边界(px)。
 * 3) 实时坐标 + 日志：确认左侧是否触发 JS 事件。
 */
export default function TouchTestPage() {
  const [log, setLog] = useState<string[]>([]);
  const [last, setLast] = useState<{ x: number; y: number; src: string } | null>(
    null
  );
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const logRef = useRef<string[]>([]);

  const readMetrics = () => {
    const vv = window.visualViewport;
    setMetrics({
      innerWidth: window.innerWidth,
      outerWidth: window.outerWidth,
      screenWidth: window.screen.width,
      clientWidth: document.documentElement.clientWidth,
      vvWidth: vv ? vv.width : -1,
      dpr: window.devicePixelRatio,
    });
  };

  const push = (msg: string, x: number, y: number, src: string) => {
    const line = `${src} x=${Math.round(x)} y=${Math.round(y)}`;
    logRef.current = [line, ...logRef.current].slice(0, 20);
    setLog([...logRef.current]);
    setLast({ x, y, src });
  };

  useEffect(() => {
    readMetrics();
    window.addEventListener("resize", readMetrics);
    window.visualViewport?.addEventListener("resize", readMetrics);
    const onTouch = (e: TouchEvent) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      if (t) push("touch", t.clientX, t.clientY, "TOUCH");
    };
    const onMouse = (e: MouseEvent) => {
      push("click", e.clientX, e.clientY, "CLICK");
    };
    document.addEventListener("touchstart", onTouch, { passive: false });
    document.addEventListener("click", onMouse);
    return () => {
      window.removeEventListener("resize", readMetrics);
      window.visualViewport?.removeEventListener("resize", readMetrics);
      document.removeEventListener("touchstart", onTouch);
      document.removeEventListener("click", onMouse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窄列，每列 40px，便于精确测量死区边界；共 24 列=960px（可横向溢出，无碍测量）
  const COL_W = 40;
  const colCount = 24;
  const cells = Array.from({ length: colCount }, (_, i) => i);

  const m = metrics;
  const is600 = m.innerWidth !== undefined && Math.abs(m.innerWidth - 600) < 1;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100dvh",
        background: "#f4f4f4",
        display: "flex",
        flexDirection: "column",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        overflow: "auto",
      }}
    >
      {/* 视口 HUD */}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 12,
          fontFamily: "monospace",
          background: "#fff",
          borderBottom: "1px solid #ccc",
        }}
      >
        <div>视口 HUD（判断布局视口是否=600）：</div>
        <div>
          innerWidth={m.innerWidth} · outerWidth={m.outerWidth} · screen.width=
          {m.screenWidth} · clientWidth={m.clientWidth} · vvWidth={m.vvWidth} · DPR=
          {m.dpr}
        </div>
        <div style={{ color: is600 ? "#c00" : "#080", fontWeight: 700 }}>
          {is600
            ? "⚠ innerWidth === 600 → 布局视口被设成 600（推测A命中，来自 PAGE_MAX_WIDTH/set_size）"
            : "innerWidth ≠ 600（布局视口≈屏幕宽，推测A不成立）"}
        </div>
      </div>

      {/* 精确窄列网格 */}
      <div style={{ padding: "6px 4px" }}>
        <div style={{ fontSize: 12, color: "#333", marginBottom: 4 }}>
          每列 40px（列号×40 = 该列左边界px）。从左往右逐列点，找出死区结束在哪一列：
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${colCount}, ${COL_W}px)`,
            gap: 2,
          }}
        >
          {cells.map((i) => (
            <div
              key={i}
              style={{
                width: COL_W,
                height: 52,
                background: i < 6 ? "#ffd7d7" : "#d7ecff",
                border: "1px solid #bbb",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: "#333",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>{i * COL_W}</span>
              <span>px</span>
            </div>
          ))}
        </div>
      </div>

      {/* 实时坐标 + 日志 */}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 12,
          color: "#111",
          fontFamily: "monospace",
          background: "#fff",
          borderTop: "1px solid #ccc",
        }}
      >
        <div>
          最近一次：
          {last ? `${last.src} (${Math.round(last.x)}, ${Math.round(last.y)})` : "（无）"}
        </div>
        {log.length === 0 ? (
          <div style={{ color: "#999" }}>暂无触摸事件……</div>
        ) : (
          log.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>
    </div>
  );
}
