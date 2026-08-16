"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useCallback } from "react";
import { serverApiUrl } from "@/lib/server-api";
import { dataFetch } from "@/lib/client-fetch";
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

// 下载导出分辨率：桌面端 1080×1920 保证高清；移动端减半避免 Android GPU 纹理限制
// 导致 canvas 下半截被硬件裁剪（点击/导出数据完整，仅视觉渲染被截断）。
const DOWNLOAD_W = typeof window !== "undefined" && /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ? 720 : 1080;
const DOWNLOAD_H = typeof window !== "undefined" && /Android|iPhone|iPad|iPod/.test(navigator.userAgent) ? 1280 : 1920;
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

/** 统一使用 400x400 缩略图。
 *  原始 face 是全尺寸大图（约 200~300KB），400w 缩略图约 7KB（全图 1/38）：
 *  - 大幅加快首屏加载（300 张从 ~90MB 降到 ~2MB）
 *  - 避免并发下载被 8s 超时误判为"加载失败"，从而消除"失败→刷新"的无谓往返
 *  - 400px 在 1080x1920 导出图上放大到最大格子(~800px)也仅 2 倍，清晰度可接受
 */
function displayFaceUrl(url: string): string {
  return cleanBilibiliFaceUrl(url) + "@400w_400h_1c_1s.webp";
}

function proxyUrl(url: string): string {
  // Tauri: 直连 B站 CDN 缩略图（WebView 请求不带被拒绝的 Referer 时最快）
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    return displayFaceUrl(url);
  }
  // Web: 通过服务器代理（服务器带 bilibili Referer 抓取，规避 CDN 403）
  return `/api/proxy/image?url=${encodeURIComponent(displayFaceUrl(url))}`;
}

/** 服务器代理回退地址：始终走服务器（服务器带 bilibili Referer 抓取）。
 *  hdslb.com CDN 会对"非 bilibili 来源的 Referer"返回 403（实测验证），
 *  浏览器/WebView 的 <img> 会带应用自身 origin 作为 Referer，直连会被拒；
 *  服务器代理用 bilibili Referer 请求，规避该 403。 */
function proxyFallbackUrl(url: string): string {
  return serverApiUrl(`/api/proxy/image?url=${encodeURIComponent(displayFaceUrl(url))}`);
}

function formatValue(v: number): string {
  if (v >= 10000) return (v / 10000).toFixed(1) + "万";
  return String(v);
}

/** 计算让"标题栏+头像图+底部两个按钮"整体不滚动地放进屏幕的图表尺寸 */
function computeInitialSize() {
  if (typeof window === "undefined") return { w: 340, h: 600 };
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  // 顶部安全区（--safe-top 已由 SafeAreaStyler 注入，解析其数值）
  let topPad = 0;
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--safe-top").trim();
    const n = parseFloat(v);
    if (!isNaN(n)) topPad = n;
  } catch { /* ignore */ }
  // 底部安全区：用探针元素读取 env(safe-area-inset-bottom) 的实际像素
  let bottomPad = 0;
  try {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;bottom:0;width:100%;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    bottomPad = probe.offsetHeight || 0;
    document.body.removeChild(probe);
  } catch { /* ignore */ }
  const sideMargin = 32; // 左右留边（内容两侧各 16px）
  // 标题 + 说明文字 + 底部两个按钮 + 外边距 + 模态框 padding 的固定垂直开销
  const overhead = 200;
  const maxW = Math.max(200, viewW - sideMargin);
  const maxH = Math.max(200, viewH - topPad - bottomPad - overhead);
  let w = Math.min(maxW, 800);
  let h = Math.round(w * DOWNLOAD_H / DOWNLOAD_W);
  if (h > maxH) { h = Math.round(maxH); w = Math.round(h * DOWNLOAD_W / DOWNLOAD_H); }
  return { w: Math.round(w), h };
}

export default function AvatarFoamTreeChart({ items, title, loading: externalLoading, loadingText, onClose }: AvatarBubbleChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ftRef = useRef<FTInstance | null>(null);
  const imageMapRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const imageFailedRef = useRef<Set<number>>(new Set());
  const loadingDoneRef = useRef(false);
  const progressRef = useRef({ loaded: 0, total: 0 });
  const groupsRef = useRef<FTGroup[]>([]);
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);
  // 图片并发池与合并重绘状态
  const loadQueueRef = useRef<Array<() => void>>([]);
  const activeLoadsRef = useRef(0);
  const redrawScheduledRef = useRef(false);
  // 已结算(成功或失败)的头像 id，保证每个 id 只结算一次
  const settledRef = useRef<Set<number>>(new Set());
  // 同时进行中的头像图片下载数。太小则慢，太大在移动端会因连接数受限而排队超时。
  const MAX_CONCURRENT_LOADS = 12;

  const [internalLoading, setInternalLoading] = useState(true);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; name: string; value: string } | null>(null);
  const [canvasDims, setCanvasDims] = useState(computeInitialSize);

  const isLoading = externalLoading || internalLoading;
  const percent = progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : 0;

  // 合并重绘：多次图片完成/进度更新只调度一次真正重绘（下一帧执行）。
  // 避免移动端慢CPU上每张图片完成都触发一次 1080x1920 全量重绘造成卡顿/渐进感。
  const triggerRedraw = useCallback(() => {
    if (redrawScheduledRef.current) return;
    redrawScheduledRef.current = true;
    requestAnimationFrame(() => {
      redrawScheduledRef.current = false;
      if (ftRef.current) {
        try { ftRef.current.redraw(); } catch (e) { /* ignore */ }
      }
    });
  }, []);

  /** 从并发池中弹出下一个待加载任务（只用稳定 ref，定义一次即可） */
  const pumpQueue = useCallback(() => {
    while (activeLoadsRef.current < MAX_CONCURRENT_LOADS && loadQueueRef.current.length > 0) {
      const start = loadQueueRef.current.shift()!;
      activeLoadsRef.current++;
      start();
    }
  }, []);

  const loadImageForGroup = useCallback((g: FTGroup) => {
    const imageMap = imageMapRef.current;
    const failedSet = imageFailedRef.current;

    if (!g.face) { failedSet.add(g.id); return; }
    if (imageMap.has(g.id)) return;
    if (failedSet.has(g.id)) return;

    const id = g.id;

    function done() {
      // 每个 id 只结算一次：成功/失败/刷新/代理等路径可能重复触发同一 id 的 done()，
      // 必须去重，否则 loaded 会超过 total、并发池槽位被重复释放、loadingDone 提前置位，
      // 进而导致下载时头像尚未画全。
      if (settledRef.current.has(id)) return;
      settledRef.current.add(id);
      progressRef.current.loaded++;
      setProgress({ ...progressRef.current });
      triggerRedraw();
      if (progressRef.current.loaded >= progressRef.current.total && !loadingDoneRef.current) {
        loadingDoneRef.current = true;
        setTimeout(() => setInternalLoading(false), 300);
      }
      // 释放并发池槽位，继续加载下一张
      activeLoadsRef.current--;
      pumpQueue();
    }

    function start() {
      // 头像解码完成后再视为加载完成，确保本次重绘能真正画出头像
      // （否则 onload 后立即重绘可能因尚未解码而没画出来，造成"加载了但没显示"的渐进感）
      const commitImage = (target: HTMLImageElement) => {
        const commit = () => { imageMap.set(id, target); done(); };
        if (typeof target.decode === "function") {
          target.decode().then(commit).catch(commit);
        } else {
          commit();
        }
      };

      // 失败降级链：
      //   0 直连(Web 即服务器代理) → 1 服务器代理(带 bilibili Referer，解决直连 403/挂起)
      //   → 2 刷新URL(解决缓存 face 过期) → 3 占位
      let stage = 0;

      // 单次尝试：onload 成功提交；onerror / 超时 只触发一次，进入下一层
      function attempt(src: string, tag: string, timeoutMs: number, onFail?: () => void) {
        const a = new Image();
        a.crossOrigin = "anonymous";
        let fired = false;
        const settle = (fn: () => void) => {
          if (fired) return;
          fired = true;
          clearTimeout(t);
          fn();
        };
        const t = setTimeout(() => {
          console.warn(`[AvatarChart] ${tag} 超时(uid=${id})`);
          settle(onFail || (() => nextStage()));
        }, timeoutMs);
        a.onload = () => settle(() => commitImage(a));
        a.onerror = () => {
          console.warn(`[AvatarChart] ${tag} 失败(uid=${id})`);
          settle(onFail || (() => nextStage()));
        };
        a.src = src;
      }

      function nextStage() {
        if (stage === 0) {
          stage = 1;
          console.log(`[AvatarChart] 直连失败(uid=${id})，回退服务器代理`);
          attempt(proxyFallbackUrl(g.face), "服务器代理", 10000);
        } else if (stage === 1) {
          stage = 2;
          console.log(`[AvatarChart] 代理失败(uid=${id})，刷新URL`);
          refreshThenLoad();
        } else {
          console.warn(`[AvatarChart] 头像最终加载失败(uid=${id})，显示占位`);
          failedSet.add(id);
          done();
        }
      }

      // 第 2 层：从 B站 API 重新拉一次 face（可能拿到新头像 URL）再加载
      function refreshThenLoad() {
        dataFetch(`/api/tools/user-info?uids=${id}&refresh=1`, { cache: "no-store" })
          .then(r => r.json())
          .then(data => {
            if (data.code === 0 && data.data?.[id]?.face) {
              const newFace = data.data[id].face;
              const group = groupsRef.current.find(gr => gr.id === id);
              if (group) group.face = newFace;
              attempt(proxyUrl(newFace), "刷新加载", 8000, () => {
                failedSet.add(id);
                done();
              });
            } else {
              failedSet.add(id);
              done();
            }
          })
          .catch(() => {
            failedSet.add(id);
            done();
          });
      }

      // 首层：直连（Web 下就是服务器代理；Tauri 下直连 CDN 缩略图）
      attempt(proxyUrl(g.face), "直连", 8000);
    }

    loadQueueRef.current.push(start);
    pumpQueue();
  }, [triggerRedraw, pumpQueue]);

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
    for (const gid of settledRef.current) { if (!newIds.has(gid)) settledRef.current.delete(gid); }

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
      groupLabelDecorator: (opts: any, props: any, vars: any) => {
        // 移动端和桌面端都隐藏直接显示的昵称标签，仅通过点击/hover 气泡框展示
        vars.labelText = "";
      },
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
      // 移除右下角"Carrot Search FoamTree"公司 logo。
      // attributionWeight=0 + attributionText="" 使 attribution 组多边形退化为空，
      // logo 与白色底块没有可绘制区域，全平台（含移动端 WebView）都不会渲染。
      // 实证(area-test.html)：attributionWeight=0 时布局面积严格正比于权重；
      // 而 attributionDistanceFromCenter=2 会把锚点推出画布外、破坏 Voronoi 松弛，
      // 导致各 cell 面积几乎相等、大额不再居中（曾误改导致回归，勿再引入）。
      // 因此不需要任何右下角遮盖层（盖住真实格子会形成可见白色块），导出图也无需兜底。
      attributionWeight: 0,
      attributionText: "",
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

    // 不设置"固定时长后强制解锁 loading"的超时：每张头像图片都有 8s 级超时，
    // 成功或失败都必然调用 done() 结算，因此 loading 一定会在全部头像结算后结束。
    // 若再加 30s 全局超时，慢速网络首次加载时会提前解锁下载按钮，
    // 用户在头像未画全时即可导出 → 下载图缺失大量头像（曾出现的 bug）。
    return () => {
      cancelled = true;
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

    // 从触摸事件中取坐标：touches 在 touchend 时为空，需退回 changedTouches
    function touchPoint(e: TouchEvent): { clientX: number; clientY: number; screenX: number; screenY: number } | null {
      if (e.touches.length > 0) {
        const t = e.touches[0];
        return { clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY };
      }
      if (e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        return { clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY };
      }
      return null;
    }

    function dispatchCorrectedTouch(e: TouchEvent, type: string) {
      const canvas = getCanvas();
      const pt = touchPoint(e);
      if (!canvas || !pt) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + (pt.clientX - rect.left) * scaleX;
      const cy = rect.top + (pt.clientY - rect.top) * scaleY;
      const ev = new MouseEvent(type, {
        clientX: cx, clientY: cy,
        screenX: pt.screenX, screenY: pt.screenY,
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

  // 响应式尺寸（随窗口/旋转变化重算，确保整体不滚动地放进屏幕）
  useEffect(() => {
    function updateSize() {
      setCanvasDims(computeInitialSize());
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    window.addEventListener("orientationchange", updateSize);
    return () => {
      window.removeEventListener("resize", updateSize);
      window.removeEventListener("orientationchange", updateSize);
    };
  }, []);

  function generateImageDataUrl(): string | null {
    if (!containerRef.current) return null;
    try {
      const canvas = containerRef.current.querySelector("canvas") as HTMLCanvasElement | null;
      if (!canvas) return null;
      // attribution 组在 attributionWeight=0 时多边形退化为空、logo 不会绘制，
      // 直接导出画布即可。不需要右下角覆盖层——那会盖住真实格子（曾导致下载图出现白色块）。
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

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4 touch-none overscroll-contain" onClick={onClose}>
      <div
        className="relative flex flex-col items-center"
        style={{ width: canvasDims.w + 32 }}
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
              <p className="text-sm text-[#6b5f52] whitespace-pre-line text-center">
                {(externalLoading ? (loadingText || "正在获取数据...") : "正在加载头像图片...")
                  .split(/<br\s*\/?>/i)
                  .join("\n")}
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
    </div>,
    document.body,
  );
}
