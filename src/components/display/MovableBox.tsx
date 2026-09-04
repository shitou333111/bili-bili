"use client";

/**
 * 可拖拽 / 等比缩放的画布元素框（展示画布用）：
 *  - 元素周围显示虚线边框（元素存在期间可见，元素移除后随组件一并消失）
 *  - 按住框内任意位置拖动可移动位置
 *  - 右下角手柄按住拖动可等比缩放（始终保持比例）
 *  - hover 到边框/手柄时鼠标形状变化
 *
 * 半受控组件：拖动前用外部 rect（props）渲染；拖动期间用内部 state 即时反馈，
 * 抬起（onPointerUp）时把最终的 rect 交给 onCommit（由父级经 WS 持久化并广播）。
 * 父级 rect 变化（如服务端回放 layout）且不在拖动时，同步回推到内部 state。
 * 位置/缩放的持久化不再依赖 localStorage（直播姬 CEF 与 APP iframe 不同存储域），
 * 统一由主进程维护 .data/display-config.json，WS 下发。
 */
import { useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";
import type { MovableRect } from "@/lib/display/types";

const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

export default function MovableBox({
  rect,
  onCommit,
  children,
  className = "",
  editable = false,
}: {
  id: string;
  /** 当前位置/缩放（受控，来自主进程下发并随拖动提交更新） */
  rect: MovableRect;
  /** 用户完成一次拖动/缩放后提交（父级转发到主进程持久化 + 广播） */
  onCommit: (rect: MovableRect) => void;
  children: ReactNode;
  className?: string;
  /** 可编辑（调整位置/大小）：仅编辑模式为 true。非编辑时无虚线边框、不可拖动/缩放 */
  editable?: boolean;
}) {
  // 拖动中的即时显示值；未拖动态时与受控 rect 保持一致
  const [dragRect, setDragRect] = useState<MovableRect>(rect);
  const draggingRef = useRef(false);
  const dragRectRef = useRef(rect);
  const propRectRef = useRef(rect);
  useEffect(() => {
    propRectRef.current = rect;
  }, [rect]);
  // 外部 rect 变化且当前不在拖动时，同步回内部状态
  useEffect(() => {
    if (!draggingRef.current) {
      setDragRect(rect);
      dragRectRef.current = rect;
    }
  }, [rect]);

  const display = draggingRef.current ? dragRect : rect;

  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startRect: MovableRect;
    anchorDist: number;
  } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    const start = propRectRef.current;
    draggingRef.current = true;
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startRect: start,
      anchorDist: Math.max(1, Math.hypot(e.clientX - start.x, e.clientY - start.y)),
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    let next: MovableRect;
    if (d.mode === "move") {
      next = {
        x: Math.round(d.startRect.x + dx),
        y: Math.round(d.startRect.y + dy),
        scale: d.startRect.scale,
      };
    } else {
      // 等比缩放：以元素左上角为锚点，按拖拽距离与初始距离的比例调整 scale
      const dist = Math.hypot(e.clientX - d.startRect.x, e.clientY - d.startRect.y);
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, (d.startRect.scale * dist) / d.anchorDist),
      );
      next = { x: d.startRect.x, y: d.startRect.y, scale: Math.round(scale * 100) / 100 };
    }
    setDragRect(next);
    dragRectRef.current = next;
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放忽略 */
    }
    const final = dragRectRef.current;
    setDragRect(final);
    onCommit(final);
    dragRef.current = null;
  };

  return (
    <div
      className={`absolute z-[3] ${editable ? "cursor-move" : ""} ${className}`}
      data-window-movable
      style={{ left: display.x, top: display.y, touchAction: "none" }}
      onPointerDown={editable ? (e) => onPointerDown(e, "move") : undefined}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? onPointerUp : undefined}
      onPointerCancel={editable ? onPointerUp : undefined}
    >
      <div style={{ transform: `scale(${display.scale})`, transformOrigin: "top left", width: "max-content" }}>
        {editable ? (
          <div className="relative border-2 border-dashed border-black/40 rounded-lg">
            {children}
            {/* 等比缩放手柄：右下角（仅编辑模式可见） */}
            <div
              className="absolute -right-1.5 -bottom-1.5 w-4 h-4 rounded-full bg-white border-2 border-[#007aff] cursor-nwse-resize shadow-md"
              onPointerDown={(e) => onPointerDown(e, "resize")}
            />
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}