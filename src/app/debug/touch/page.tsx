"use client";

import { useState, useCallback, useEffect, useRef } from "react";

const COLS = 10;
const ROWS = 16;

export default function TouchDebugPage() {
  const [tappedCells, setTappedCells] = useState<Record<string, number>>({});
  const [lastEvent, setLastEvent] = useState<{
    type: string;
    x: number;
    y: number;
    cell: string;
    timestamp: number;
  } | null>(null);
  const [dimensions, setDimensions] = useState({ w: 0, h: 0 });
  const [allTouches, setAllTouches] = useState<Array<{ x: number; y: number; hit: string | null }>>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function updateSize() {
      setDimensions({
        w: window.innerWidth,
        h: window.innerHeight,
      });
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const getCell = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    const col = Math.floor((relX / rect.width) * COLS);
    const row = Math.floor((relY / rect.height) * ROWS);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
    return `${col},${row}`;
  }, []);

  const handleInteraction = useCallback(
    (type: string, clientX: number, clientY: number) => {
      const cell = getCell(clientX, clientY);
      setLastEvent({ type, x: clientX, y: clientY, cell: cell || "none", timestamp: Date.now() });
      setAllTouches((prev) => [...prev.slice(-50), { x: clientX, y: clientY, hit: cell }]);
      if (cell) {
        setTappedCells((prev) => ({ ...prev, [cell]: (prev[cell] || 0) + 1 }));
      }
    },
    [getCell],
  );

  // 全局 touch 事件监听（捕获阶段，不依赖特定元素）
  useEffect(() => {
    const onTouch = (e: TouchEvent) => {
      const touch = e.touches[0] || e.changedTouches[0];
      if (touch) {
        handleInteraction(e.type, touch.clientX, touch.clientY);
      }
    };
    window.addEventListener("touchstart", onTouch, { capture: true });
    window.addEventListener("touchmove", onTouch, { capture: true });
    window.addEventListener("touchend", onTouch, { capture: true });
    return () => {
      window.removeEventListener("touchstart", onTouch, { capture: true });
      window.removeEventListener("touchmove", onTouch, { capture: true });
      window.removeEventListener("touchend", onTouch, { capture: true });
    };
  }, [handleInteraction]);

  const cellW = dimensions.w / COLS;
  const cellH = dimensions.h / ROWS;

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        gridTemplateColumns: `repeat(${COLS}, 1fr)`,
        gridTemplateRows: `repeat(${ROWS}, 1fr)`,
        zIndex: 0,
        touchAction: "none",
      }}
    >
      {Array.from({ length: COLS * ROWS }, (_, i) => {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        const key = `${col},${row}`;
        const count = tappedCells[key] || 0;
        const hue = (col / COLS) * 360;
        const alpha = Math.min(0.3 + count * 0.2, 1);
        return (
          <div
            key={key}
            onClick={(e) => handleInteraction("click", e.clientX, e.clientY)}
            style={{
              background: count > 0
                ? `hsla(${hue}, 80%, 50%, ${alpha})`
                : `hsla(${hue}, 0%, 90%, 0.3)`,
              border: "0.5px solid rgba(0,0,0,0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: Math.min(10, Math.max(6, cellW / 4)),
              color: count > 0 ? "#fff" : "rgba(0,0,0,0.3)",
              cursor: "pointer",
              userSelect: "none",
              WebkitUserSelect: "none",
              overflow: "hidden",
              transition: "background 0.15s",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {count > 0 ? count : ""}
          </div>
        );
      })}

      {/* 调试信息浮层 */}
      <div
        style={{
          position: "fixed",
          bottom: 8,
          left: 8,
          right: 8,
          zIndex: 99999,
          background: "rgba(0,0,0,0.85)",
          color: "#0f0",
          padding: "8px 12px",
          borderRadius: 8,
          fontFamily: "monospace",
          fontSize: 11,
          lineHeight: 1.4,
          pointerEvents: "none",
          maxHeight: "30vh",
          overflow: "hidden",
        }}
      >
        <div>viewport: {dimensions.w}x{dimensions.h}</div>
        <div>grid: {COLS}x{ROWS} (cell: {cellW.toFixed(0)}x{cellH.toFixed(0)}px)</div>
        {lastEvent && (
          <div>
            last: {lastEvent.type} @ ({lastEvent.x},{lastEvent.y}) → [{lastEvent.cell}]
          </div>
        )}
        <div style={{ marginTop: 4, maxHeight: 80, overflow: "hidden" }}>
          {allTouches.slice(-10).map((t, i) => (
            <div key={i} style={{ opacity: 0.7 }}>
              ({t.x},{t.y}) → {t.hit || "none"}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}