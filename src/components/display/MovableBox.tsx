"use client";

/**
 * 可拖拽 / 等比缩放的画布元素框（展示画布用）：
 *  - 元素周围显示虚线边框（元素存在期间可见，元素移除后随组件一并消失）
 *  - 按住框内任意位置拖动可移动位置
 *  - 右下角手柄按住拖动可等比缩放（始终保持比例）
 *  - hover 到边框/手柄时鼠标形状变化
 *  - 位置/缩放持久化到 localStorage，重启展示窗口后保留
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";

export interface MovableRect {
  /** 元素左上角 X（画布坐标） */
  x: number;
  /** 元素左上角 Y（画布坐标） */
  y: number;
  /** 缩放系数（1=原始大小） */
  scale: number;
}

const STORAGE_KEY_PREFIX = "display-canvas-layout-v1";
const MIN_SCALE = 0.3;
const MAX_SCALE = 3;

/** 布局存储键：横屏 / 竖屏各存一套参数（横竖屏切换时各自读取/保存互不覆盖）。 */
function storageKey(orientation: string): string {
  return `${STORAGE_KEY_PREFIX}-${orientation}`;
}

function loadRect(id: string, orientation: string, fallback: MovableRect): MovableRect {
  try {
    const raw = localStorage.getItem(storageKey(orientation));
    if (raw) {
      const all = JSON.parse(raw) as Record<string, MovableRect>;
      const r = all?.[id];
      if (r && typeof r.x === "number" && typeof r.y === "number" && typeof r.scale === "number") {
        return { x: r.x, y: r.y, scale: r.scale };
      }
    }
  } catch {
    /* 读取失败用默认位置 */
  }
  return fallback;
}

function saveRect(id: string, orientation: string, rect: MovableRect) {
  try {
    const key = storageKey(orientation);
    const raw = localStorage.getItem(key);
    const all = raw ? (JSON.parse(raw) as Record<string, MovableRect>) : {};
    all[id] = rect;
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* 保存失败忽略 */
  }
}

export default function MovableBox({
  id,
  defaultRect,
  children,
  className = "",
  editable = false,
  orientation = "landscape",
}: {
  id: string;
  defaultRect: MovableRect;
  children: ReactNode;
  className?: string;
  /** 可编辑（调整位置/大小）：仅测试模式为 true。非测试时无虚线边框、不可拖动/缩放 */
  editable?: boolean;
  /** 画布朝向：横屏 / 竖屏各存一套布局，切换时读取对应朝向已保存的位置 */
  orientation?: "landscape" | "portrait";
}) {
  // 初始用默认位置渲染；挂载后再从 localStorage 加载已保存的位置/缩放。
  // 不能在 useState 初始化器里读 localStorage：SSR 首帧拿不到（返回默认值），
  // 客户端水合时又读到已保存值 → 造成 hydration mismatch（React 不修补该子树，
  // 导致保存的位置/缩放始终不生效）。改到 useEffect 读取则两端首帧一致，保存值再补上。
  const [rect, setRect] = useState<MovableRect>(defaultRect);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  useEffect(() => {
    const saved = loadRect(id, orientation, defaultRect);
    setRect(saved);
    rectRef.current = saved;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, orientation]);

  const dragRef = useRef<{
    mode: "move" | "resize";
    startX: number;
    startY: number;
    startRect: MovableRect;
    anchorDist: number;
  } | null>(null);

  const update = useCallback(
    (next: MovableRect) => {
      setRect(next);
      saveRect(id, orientation, next);
    },
    [id, orientation],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startRect: rectRef.current,
      anchorDist: Math.max(
        1,
        Math.hypot(e.clientX - rectRef.current.x, e.clientY - rectRef.current.y),
      ),
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.mode === "move") {
      update({
        x: Math.round(d.startRect.x + dx),
        y: Math.round(d.startRect.y + dy),
        scale: d.startRect.scale,
      });
    } else {
      // 等比缩放：以元素左上角为锚点，按拖拽距离与初始距离的比例调整 scale
      const dist = Math.hypot(e.clientX - d.startRect.x, e.clientY - d.startRect.y);
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, (d.startRect.scale * dist) / d.anchorDist),
      );
      update({ x: d.startRect.x, y: d.startRect.y, scale: Math.round(scale * 100) / 100 });
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放忽略 */
    }
  };

  return (
    <div
      className={`absolute z-[3] ${editable ? "cursor-move" : ""} ${className}`}
      data-window-movable
      style={{ left: rect.x, top: rect.y, touchAction: "none" }}
      onPointerDown={editable ? (e) => onPointerDown(e, "move") : undefined}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? onPointerUp : undefined}
      onPointerCancel={editable ? onPointerUp : undefined}
    >
      <div style={{ transform: `scale(${rect.scale})`, transformOrigin: "top left", width: "max-content" }}>
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
