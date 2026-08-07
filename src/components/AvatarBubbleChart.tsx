"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { serverApiUrl } from "@/lib/server-api";
import { showToast } from "@/lib/toast";
import { saveMobileOrDownload } from "@/lib/save-image";
import { isMobileDevice } from "@/lib/device";

type FoamTreeCtor = any;
let FoamTreePromise: Promise<FoamTreeCtor> | null = null;
function loadFoamTree(): Promise<FoamTreeCtor> {
  if (!FoamTreePromise) {
    FoamTreePromise = import("@carrotsearch/foamtree").then((m: any) => m.FoamTree || m.default);
  }
  return FoamTreePromise;
}

export interface BubbleItem {
  id: number;
  name: string;
  value: number;
  face: string;
}

interface AvatarBubbleChartProps {
  items: BubbleItem[];
  title: string;
  loading?: boolean;
  loadingText?: string;
  onClose: () => void;
}

const DOWNLOAD_W = 1080;
const DOWNLOAD_H = 1920;
const MAX_DISPLAY = 300;

const PLACEHOLDER_COLORS = [
  "#e8ddd0", "#ddd2c5", "#e3d9cc", "#d4c9bc", "#ebe2d6",
  "#d9cfc2", "#e0d6ca", "#d1c7ba", "#e6ddd1", "#d6ccc0",
];

type FTInstance = any;

interface FTGroup {
  id: number;
  label: string;
  weight: number;
  color: string;
  face: string;
  name: string;
  value: number;
}

interface FTPoint { x: number; y: number; }

function polygonBBox(points: FTPoint[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function cleanBilibiliFaceUrl(url: string): string {
  if (!url) return "";
  let cleaned = url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
  cleaned = cleaned.replace(/@.*$/, "");
  return cleaned;
}

function proxyUrl(url: string): string {
  const cleaned = cleanBilibiliFaceUrl(url);
  // Tauri: 直接访问 B站 CDN（客户端直连，不经过服务器）
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return cleaned;
  }
  // Web: 通过服务器代理添加 CORS 头
  return `/api/proxy/image?url=${encodeURIComponent(cleaned)}`;
}

function formatValue(v: number): string {
  if (v >= 10000) return (v / 10000).toFixed(1) + "万";
  return String(v);
}

/** 初始尺寸计算（同步，避免首次渲染时尺寸不对） */
function computeInitialSize() {
  if (typeof window === "undefined") return { w: 360, h: 640 };
  const sideMargin = 16;
  const reserved = 160;
  const maxW = window.innerWidth - sideMargin;
  const maxH = window.innerHeight - reserved;
  let w = Math.min(maxW, 800);
  let h = w * DOWNLOAD_H / DOWNLOAD_W;
  if (h > maxH) { h = maxH; w = h * DOWNLOAD_W / DOWNLOAD_H; }
  return { w: Math.round(w), h: Math.round(h) };
}

export default function AvatarFoamTreeChart({ items, title, loading: externalLoading, loadingText, onClose }: AvatarBubbleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ftRef = useRef<FTInstance | null>(null);
  const imageMapRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const imageFailedRef = useRef<Set<number>>(new Set());
  const refreshAttemptedRef = useRef<Set<number>>(new Set());
  const refreshingRef = useRef<Set<number>>(new Set());
  const proxyAttemptedRef = useRef<Set<number>>(new Set());
  const loadingDoneRef = useRef(false);
  const progressRef = useRef({ loaded: 0, total: 0 });
  const groupsRef = useRef<FTGroup[]>([]);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);

  const [internalLoading, setInternalLoading] = useState(true);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; value: string } | null>(null);
  const [canvasDims, setCanvasDims] = useState(computeInitialSize);

  const isLoading = externalLoading || internalLoading;
  const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  const triggerRedraw = useCallback(() => {
    if (!ftRef.current) return;
    try { ftRef.current.redraw(); } catch (e) { /* ignore */ }
  }, []);

  const loadImageForGroup = useCallback((g: FTGroup) => {
    const imageMap = imageMapRef.current;
    const failedSet = imageFailedRef.current;

    if (!g.face) { failedSet.add(g.id); return; }
    if (imageMap.has(g.id)) return;
    if (failedSet.has(g.id)) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    const id = g.id;

    function done() {
      progressRef.current.loaded++;
      setProgress({ ...progressRef.current });
      triggerRedraw();
      if (progressRef.current.loaded >= progressRef.current.total && !loadingDoneRef.current) {
        loadingDoneRef.current = true;
        setTimeout(() => setInternalLoading(false), 300);
      }
    }

    img.onload = () => {
      clearTimeout(loadTimer);
      imageMap.set(id, img);
      done();
    };

    // 头像加载失败/超时后的降级路径：先刷 URL，再回退服务器代理
    let loadTimer: ReturnType<typeof setTimeout>;
    function handleFail() {
      if (!refreshAttemptedRef.current.has(id) && !refreshingRef.current.has(id)) {
        refreshingRef.current.add(id);
        refreshAttemptedRef.current.add(id);
        console.log(`[AvatarChart] 头像加载失败，尝试刷新URL: uid=${id}`);
        fetch(serverApiUrl(`/api/tools/user-info?uids=${id}&refresh=1`), { cache: "no-store" })
          .then(r => r.json())
          .then(data => {
            refreshingRef.current.delete(id);
            if (data.code === 0 && data.data?.[id]?.face) {
              const newFace = data.data[id].face;
              const newName = data.data[id].name;
              console.log(`[AvatarChart] 刷新URL成功: uid=${id}`);
              const group = groupsRef.current.find(gr => gr.id === id);
              if (group) {
                group.face = newFace;
                if (newName) group.name = newName;
              }
              failedSet.delete(id);
              imageMap.delete(id);
              const newImg = new Image();
              newImg.crossOrigin = "anonymous";
              newImg.onload = () => { imageMap.set(id, newImg); triggerRedraw(); done(); };
              newImg.onerror = () => { failedSet.add(id); triggerRedraw(); done(); };
              newImg.src = proxyUrl(newFace);
            } else {
              failedSet.add(id);
              triggerRedraw();
              done();
            }
          })
          .catch(() => {
            refreshingRef.current.delete(id);
            failedSet.add(id);
            triggerRedraw();
            done();
          });
      } else {
        // 直连失败且已尝试刷新 URL，回退到服务器代理加载一次（兼容 Tauri 直连 B站 CDN 失败的情况）
        if (!proxyAttemptedRef.current.has(id)) {
          proxyAttemptedRef.current.add(id);
          const proxied = serverApiUrl(`/api/proxy/image?url=${encodeURIComponent(cleanBilibiliFaceUrl(g.face))}`);
          const pimg = new Image();
          pimg.crossOrigin = "anonymous";
          pimg.onload = () => { imageMap.set(id, pimg); triggerRedraw(); done(); };
          pimg.onerror = () => { failedSet.add(id); triggerRedraw(); done(); };
          pimg.src = proxied;
        } else {
          failedSet.add(id);
          done();
        }
      }
    }

    img.onerror = handleFail;
    // 直连若长时间无响应（安卓上 B站 CDN 可能挂起而非报错），超时后同样走降级路径
    loadTimer = setTimeout(handleFail, 8000);
    img.src = proxyUrl(g.face);
  }, [triggerRedraw]);

  // 核心FoamTree初始化 - canvas固定1080×1920，CSS transform缩放显示，overlay拦截事件修正坐标
  useEffect(() => {
    let cancelled = false;

    if (externalLoading) {
      setInternalLoading(true);
      loadingDoneRef.current = false;
      return;
    }
    if (items.length === 0) {
      setInternalLoading(false);
      return;
    }

    loadingDoneRef.current = false;
    progressRef.current = { loaded: 0, total: 0 };

    const sorted = [...items].sort((a, b) => b.value - a.value);
    const displayItems = sorted.slice(0, MAX_DISPLAY);

    const groups: FTGroup[] = displayItems.map((item, i) => ({
      id: item.id,
      label: item.name,
      weight: Math.sqrt(item.value),
      color: PLACEHOLDER_COLORS[i % PLACEHOLDER_COLORS.length],
      face: item.face,
      name: item.name,
      value: item.value,
    }));
    groupsRef.current = groups;

    const imageMap = imageMapRef.current;
    const failedSet = imageFailedRef.current;

    const newIds = new Set(groups.map(g => g.id));
    for (const [gid] of imageMap) { if (!newIds.has(gid)) imageMap.delete(gid); }
    for (const gid of failedSet) { if (!newIds.has(gid)) failedSet.delete(gid); }
    refreshAttemptedRef.current.clear();
    refreshingRef.current.clear();

    let loadedCount = 0;
    let totalToLoad = 0;
    for (const g of groups) {
      if (!g.face) { failedSet.add(g.id); loadedCount++; continue; }
      if (imageMap.has(g.id)) { loadedCount++; continue; }
      if (failedSet.has(g.id)) { loadedCount++; continue; }
      totalToLoad++;
    }
    progressRef.current = { loaded: loadedCount, total: loadedCount + totalToLoad };
    setProgress({ ...progressRef.current });
    if (totalToLoad === 0) {
      setInternalLoading(false);
      loadingDoneRef.current = true;
    } else {
      setInternalLoading(true);
    }
    for (const g of groups) { loadImageForGroup(g); }

    const imageMapClosure = imageMap;
    const failedSetClosure = failedSet;

    console.log(
      "[AvatarChart] init: itemsTotal=" + items.length,
      "displayItems=" + displayItems.length,
      "canvas=" + DOWNLOAD_W + "x" + DOWNLOAD_H + " (fixed)",
      "displaySize=" + canvasDims.w + "x" + canvasDims.h,
    );

    // CSS像素坐标系下的边框宽度
    const WHITE_BORDER = 1.5;
    const SELECT_BORDER = 2.5;

    const containerDiv = containerRef.current;
    if (!containerDiv || containerDiv.clientWidth === 0 || containerDiv.clientHeight === 0) return;

    const ftOptions: any = {
      element: containerDiv,
      pixelRatio: 1,
      layout: "relaxed",
      stacking: "flattened",
      layoutByWeightOrder: true,
      relaxationInitializer: "fisheye",
      descriptionGroup: false,
      descriptionGroupSize: 0,
      descriptionGroupMinHeight: 0,
      groupLabelDecorator: () => void 0,
      groupLabelFontSize: 0,
      groupLabelMinFontSize: 0,
      groupBorderWidth: 0,
      groupBorderWidthScaling: 1,
      groupInsetWidth: 0,
      groupStrokeType: "none",
      groupStrokeWidth: 0,
      groupFillType: "plain",
      groupBorderRadius: 0,
      groupSelectionOutlineWidth: SELECT_BORDER,
      groupSelectionOutlineColor: "#000000",
      groupSelectionOutlineShadowSize: 0,
      groupHoverStrokeWidth: 0,
      groupHoverFillHueShift: 0,
      groupHoverFillSaturationShift: 0,
      groupHoverFillLightnessShift: 0,
      groupHoverStrokeHueShift: 0,
      groupHoverStrokeSaturationShift: 0,
      groupHoverStrokeLightnessShift: 0,
      groupExposureScale: 1,
      groupExposureShadowSize: 0,
      groupExposureZoomMargin: 0,
      groupUnexposureLightnessShift: 0,
      groupUnexposureSaturationShift: 0,
      rolloutDuration: 800,
      pullbackDuration: 600,
      wireframeDrawingTimeout: 0,
      wireframeLabelDrawingTimeout: 0,
      wireframeContentDecorationDrawing: "always",
      // 强制完整同步渲染（0=不限时）：避免在慢速设备（尤其安卓）上渐进式渲染
      // 把面积小、位于底部的大量单元格跳过未绘制，导致下方出现无法显示的空白。
      finalCompleteDrawMaxDuration: 0,
      finalIncrementalDrawMaxDuration: 0,
      fadeDuration: 300,
      zoomMouseWheelDuration: 300,
      groupContentDecoratorTriggering: "onSurfaceDirty",
      attributionWeight: 0,
      attributionText: "",
      // 用透明 1x1 GIF 强制不绘制 attribution 徽标：
      // 只设置 "" 时，导出原分辨率(1080×1920)的图片仍可能残留右下角 logo
      // （屏幕上因 CSS 缩放显得极小看不见，导出后即暴露），故必须用透明图替换。
      attributionLogo:
        "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      descriptionGroupPolygonDrawn: false,
      backgroundColor: "#f6f1e9",
      groupColorDecorator: (opts: any, props: any, vars: any) => {
        // 使用各格子自身的占位色（暖色系），避免未加载头像的区域呈现刺眼白色
        vars.groupColor = props.group.color || "#f6f1e9";
      },
      groupContentDecorator: (opts: any, props: any, vars: any) => {
        const ctx: CanvasRenderingContext2D = props.context;
        const polygon: FTPoint[] = props.polygon;
        const node: any = props.group;
        if (!polygon || polygon.length < 3) return;

        const origId: number = node.id;
        const origColor: string = node.color;
        const bbox = polygonBBox(polygon);

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(polygon[0].x, polygon[0].y);
        for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
        ctx.closePath();
        ctx.clip();

        const img = imageMapClosure.get(origId);
        if (img && img.complete && img.naturalWidth > 0) {
          const iw = img.naturalWidth;
          const ih = img.naturalHeight;
          const bw = bbox.w, bh = bbox.h;
          const sc = Math.max(bw / iw, bh / ih);
          const dw = iw * sc, dh = ih * sc;
          const dx = bbox.minX + (bw - dw) / 2;
          const dy = bbox.minY + (bh - dh) / 2;
          ctx.drawImage(img, dx, dy, dw, dh);
        } else {
          // 头像缺失/失败时填充浅暖色占位色，避免区域呈现刺眼白色
          ctx.fillStyle = failedSetClosure.has(origId) ? "#d8c9b4" : (origColor || "#d8c9b4");
          ctx.beginPath();
          ctx.moveTo(polygon[0].x, polygon[0].y);
          for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(polygon[0].x, polygon[0].y);
        for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y);
        ctx.closePath();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = WHITE_BORDER;
        ctx.lineJoin = "miter";
        ctx.stroke();
        ctx.restore();
      },
      onGroupHover: (e: any) => {
        // 移动端不使用 hover（触碰/滑动不会清除 hover 状态，导致昵称气泡固定显示），
        // 移动端仅通过点击(点按)显示提示框；桌面端保留 hover。
        if (isMobileDevice()) return;
        if (e.group) {
          setTooltip({
            x: mousePosRef.current.x, y: mousePosRef.current.y,
            name: e.group.name || e.group.label, value: formatValue(e.group.value),
          });
        } else { setTooltip(null); }
      },
      onGroupClick: (e: any) => {
        if (e.group) {
          setTooltip({
            x: mousePosRef.current.x, y: mousePosRef.current.y,
            name: e.group.name || e.group.label, value: formatValue(e.group.value),
          });
        }
      },
      onGroupDoubleClick: (e: any) => { e.preventDefault(); },
      onGroupDragStart: (e: any) => { e.preventDefault(); },
      onGroupDrag: (e: any) => { e.preventDefault(); },
      onGroupDragEnd: (e: any) => { e.preventDefault(); },
      onBackgroundClick: () => {
        ftRef.current?.set("selection", { groups: [], keepCurrentSelection: false });
        setTooltip(null);
      },
      dataObject: { groups: groups.map(g => ({ ...g })) },
    };

    loadFoamTree().then((FoamTreeCtor) => {
      if (cancelled) return;
      const cd = containerRef.current;
      if (!cd || cd.clientWidth === 0 || cd.clientHeight === 0) return;
      if (ftRef.current) {
        try { ftRef.current.dispose(); } catch (_) { /* ignore */ }
        ftRef.current = null;
      }
      ftRef.current = new FoamTreeCtor(ftOptions);
    });

    const timeout = setTimeout(() => {
      if (!loadingDoneRef.current) {
        loadingDoneRef.current = true;
        setInternalLoading(false);
      }
    }, 30000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      if (ftRef.current) {
        try { ftRef.current.dispose(); } catch (_) { /* ignore */ }
        ftRef.current = null;
      }
    };
  }, [items, externalLoading, triggerRedraw, loadImageForGroup]);

  // overlay拦截鼠标/触摸事件，修正坐标后转发给canvas，解决CSS transform导致的坐标偏移
  useEffect(() => {
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!overlay || !container) return;

    const scaleX = DOWNLOAD_W / canvasDims.w;
    const scaleY = DOWNLOAD_H / canvasDims.h;

    function getCanvas(): HTMLCanvasElement | null {
      return container?.querySelector("canvas") as HTMLCanvasElement | null;
    }

    function dispatchCorrected(e: MouseEvent) {
      const canvas = getCanvas();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + (e.clientX - rect.left) * scaleX;
      const cy = rect.top + (e.clientY - rect.top) * scaleY;
      const ev = new MouseEvent(e.type, {
        clientX: cx, clientY: cy,
        screenX: e.screenX, screenY: e.screenY,
        button: e.button, buttons: e.buttons,
        bubbles: true, cancelable: true,
      });
      canvas.dispatchEvent(ev);
    }

    function dispatchCorrectedTouch(e: TouchEvent, type: string) {
      const canvas = getCanvas();
      if (!canvas || e.touches.length === 0) return;
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + (t.clientX - rect.left) * scaleX;
      const cy = rect.top + (t.clientY - rect.top) * scaleY;
      const ev = new MouseEvent(type, {
        clientX: cx, clientY: cy,
        screenX: t.screenX, screenY: t.screenY,
        button: 0, buttons: 1,
        bubbles: true, cancelable: true,
      });
      canvas.dispatchEvent(ev);
    }

    const onMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
      dispatchCorrected(e);
    };
    const onMouseDown = (e: MouseEvent) => { dispatchCorrected(e); };
    const onMouseUp = (e: MouseEvent) => { dispatchCorrected(e); };
    const onClick = (e: MouseEvent) => { dispatchCorrected(e); };
    const onMouseLeave = () => setTooltip(null);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 0) mousePosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      dispatchCorrectedTouch(e, "mousedown");
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) mousePosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      dispatchCorrectedTouch(e, "mousemove");
    };
    const onTouchEnd = (e: TouchEvent) => {
      dispatchCorrectedTouch(e, "mouseup");
    };

    overlay.addEventListener("mousemove", onMouseMove);
    overlay.addEventListener("mousedown", onMouseDown);
    overlay.addEventListener("mouseup", onMouseUp);
    overlay.addEventListener("click", onClick);
    overlay.addEventListener("mouseleave", onMouseLeave);
    overlay.addEventListener("touchstart", onTouchStart, { passive: true });
    overlay.addEventListener("touchmove", onTouchMove, { passive: true });
    overlay.addEventListener("touchend", onTouchEnd);

    return () => {
      overlay.removeEventListener("mousemove", onMouseMove);
      overlay.removeEventListener("mousedown", onMouseDown);
      overlay.removeEventListener("mouseup", onMouseUp);
      overlay.removeEventListener("click", onClick);
      overlay.removeEventListener("mouseleave", onMouseLeave);
      overlay.removeEventListener("touchstart", onTouchStart);
      overlay.removeEventListener("touchmove", onTouchMove);
      overlay.removeEventListener("touchend", onTouchEnd);
    };
  }, [canvasDims.w, canvasDims.h]);

  useEffect(() => {
    return () => {
      if (ftRef.current) { try { ftRef.current.dispose(); } catch (e) { /* ignore */ } ftRef.current = null; }
    };
  }, []);

  // 响应式尺寸
  useEffect(() => {
    function updateSize() {
      const sideMargin = 16;
      const reserved = 160;
      const maxW = window.innerWidth - sideMargin;
      const maxH = window.innerHeight - reserved;
      let w = Math.min(maxW, 800);
      let h = w * DOWNLOAD_H / DOWNLOAD_W;
      if (h > maxH) { h = maxH; w = h * DOWNLOAD_W / DOWNLOAD_H; }
      setCanvasDims({ w: Math.round(w), h: Math.round(h) });
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  function generateImageDataUrl(): string | null {
    if (!containerRef.current) return null;
    try {
      const canvas = containerRef.current.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      // canvas固定渲染1080×1920，直接toDataURL导出原生分辨率，无缩放损失
      return canvas.toDataURL("image/png");
    } catch (err) {
      console.error("生成图片失败:", err);
      return null;
    }
  }

  function downloadImage() {
    const dataUrl = generateImageDataUrl();
    if (!dataUrl) {
      console.warn("[AvatarChart] 下载失败：无法生成图片，请等待头像加载完成");
      return;
    }
    // 移动端 Tauri 直接保存到相册（系统分享），桌面/Web 直接下载
    saveMobileOrDownload(dataUrl, `${title}_头像分布.png`).then(res => {
      if (res === "fallback") showToast("未保存到相册，请长按图片保存");
    });
  }

  const displayCount = Math.min(items.length, MAX_DISPLAY);
  const noteText = title.includes("主播")
    ? `单元格面积代表贡献度，共显示 ${displayCount} 个主播`
    : `单元格面积代表消费额，共显示 ${displayCount} 个粉丝`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative mx-auto flex flex-col items-center max-h-screen overflow-y-auto"
        style={{ width: canvasDims.w + 32, paddingTop: "calc(16px + var(--safe-top, 0px))", paddingBottom: "calc(88px + env(safe-area-inset-bottom, 0px))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-white/80 text-sm mb-1 w-full text-center truncate px-2" title={title}>{title}</p>
        <p className="text-white/40 text-xs mb-2">{noteText}</p>
        <div className="relative rounded-lg shadow-2xl overflow-hidden bg-[#f6f1e9]" style={{ width: canvasDims.w, height: canvasDims.h }}>
          <div
            ref={containerRef}
            style={{ width: DOWNLOAD_W, height: DOWNLOAD_H, transform: `scale(${canvasDims.w / DOWNLOAD_W})`, transformOrigin: "top left" }}
          />
          <div
            ref={overlayRef}
            className="absolute inset-0 z-[5]"
          />
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg bg-white">
              <div className="w-10 h-10 border-[3px] border-[#b8a99a] border-t-transparent rounded-full animate-spin"></div>
              <p className="text-sm text-[#6b5f52]">
                {externalLoading ? (loadingText || "正在获取数据...") : "正在加载头像图片..."}
              </p>
              {!externalLoading && progress.total > 0 && (
                <div className="w-48 mt-1">
                  <div className="w-full bg-[#e0d6c8] rounded-full h-1.5">
                    <div className="bg-[#8b7d6e] rounded-full h-1.5 transition-all duration-200" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="text-xs text-[#a09284] text-center mt-1">{progress.loaded}/{progress.total} ({percent}%)</p>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex gap-2.5 mt-4 w-full justify-center">
          <button onClick={downloadImage} disabled={isLoading} className="modal-action-btn modal-action-primary">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            下载图片
          </button>
          <button onClick={onClose} className="modal-action-btn modal-action-light">
            关闭
          </button>
        </div>

        {tooltip && !isLoading && (
          <div
            className="fixed z-[60] pointer-events-none px-3 py-2 bg-black/80 text-white text-xs rounded-lg shadow-lg"
            style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
          >
            <div className="font-medium">{tooltip.name}</div>
            <div className="text-white/70 mt-0.5">{tooltip.value} 电池</div>
          </div>
        )}

      </div>
    </div>
  );
}
