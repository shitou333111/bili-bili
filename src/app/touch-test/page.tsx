"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 触摸诊断页（/touch-test）
 * 整屏网格，实时显示触摸/点击坐标与命中的单元格。
 * 用于判断 iOS 竖屏下"左侧约 1/4 无响应"到底是 WebView 吞掉了触摸
 * （JS 事件根本不触发），还是事件触发了但被上层 UI 拦截。
 */
export default function TouchTestPage() {
  const [log, setLog] = useState<string[]>([]);
  const [last, setLast] = useState<{ x: number; y: number; src: string } | null>(
    null
  );
  const logRef = useRef<string[]>([]);

  const push = (msg: string, x: number, y: number, src: string) => {
    const line = `${src} x=${Math.round(x)} y=${Math.round(y)}`;
    logRef.current = [line, ...logRef.current].slice(0, 12);
    setLog([...logRef.current]);
    setLast({ x, y, src });
  };

  useEffect(() => {
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
      document.removeEventListener("touchstart", onTouch);
      document.removeEventListener("click", onMouse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cols = 4;
  const rows = 10;
  const cells = Array.from({ length: cols * rows }, (_, i) => i);

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
      }}
    >
      <div style={{ padding: "8px 10px", fontSize: 13, color: "#222" }}>
        触摸诊断 /touch-test —— 请从屏幕最左边到最右边依次点一遍，看左侧是否有日志
      </div>

      {/* 网格 */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 2,
          padding: 2,
        }}
      >
        {cells.map((i) => {
          const col = i % cols;
          const isLeft = col === 0;
          return (
            <div
              key={i}
              style={{
                background: isLeft ? "#ffd7d7" : "#d7ecff",
                border: "1px solid #bbb",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
                fontWeight: 700,
                color: "#333",
              }}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      {/* 实时坐标 + 日志 */}
      <div
        style={{
          padding: "8px 10px",
          fontSize: 12,
          color: "#111",
          fontFamily: "monospace",
          minHeight: 120,
          background: "#fff",
          borderTop: "1px solid #ccc",
        }}
      >
        <div>
          最近一次：{last ? `${last.src} (${Math.round(last.x)}, ${Math.round(last.y)})` : "（无）"}
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
