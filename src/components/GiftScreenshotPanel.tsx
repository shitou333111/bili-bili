"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { isMobileDevice } from "@/lib/device";
import { serverApiUrl } from "@/lib/server-api";
import { fetchGiftEffects } from "@/lib/gift-effects-client";
import { showToast } from "@/lib/toast";
import { saveMobileOrDownload } from "@/lib/save-image";

// ==================== 类型定义 ====================

type AnchorGiftRecord = {
  uid: number;
  uname: string;
  time: string;
  goods_id: number;
  gift_id: number;
  name: string;
  num: number;
  hamster: number;
  receive_title: string;
  room_id: number;
};

type EffectConfig = {
  info: {
    aFrame: [number, number, number, number];
    rgbFrame: [number, number, number, number];
    f: number;
    fps: number;
    videoW: number;
    videoH: number;
    w: number;
    h: number;
    scale: number;
  };
};

type GiftEffectData = {
  found: boolean;
  web_mp4?: string;
  web_mp4_json?: string;
  effect_config?: EffectConfig | null;
};

type GiftAggregation = {
  gift_id: number;
  name: string;
  img: string;
  num: number;
  price: number; // 电池 = hamster * 2 / 100
  fanUid: number;
  fanName: string;
};

type SelectedGift = {
  gift_id: number;
  name: string;
  num: number;
  fanUid: number;
  fanName: string;
  fanFace: string;
  frameIndex: number; // 0=40%, 1=50%, 2=60%, 3=70%
};

type Layout = { x: number; y: number; w: number; h: number };

// ==================== 常量 ====================

const CARD_W = 1080;
const CARD_H = 1920;
const HEADER_H = 280;

const DATE_OPTIONS = [
  { key: "lastWeek", label: "上周" },
  { key: "thisWeek", label: "本周" },
  { key: "yesterday", label: "昨日" },
] as const;

const PRICE_OPTIONS = [
  { value: 30000, label: "≥30000电池" },
  { value: 10000, label: "≥10000电池" },
  { value: 2000, label: "≥2000电池" },
] as const;

const FAN_COLORS = [
  "#FFE0B2", "#BBDEFB", "#C8E6C9", "#F8BBD9", "#D1C4E9",
  "#B2EBF2", "#FFECB3", "#D7CCC8", "#DCEDC8", "#B3E5FC",
  "#FFCCBC", "#CFD8DC", "#F0F4C3", "#E1BEE7", "#B2DFDB",
];

/** 礼物名称 badge 背景色——鲜艳饱和，适合深色卡片 */
const GIFT_BADGE_COLORS = [
  "#E53935", "#D81B60", "#8E24AA", "#5E35B1", "#3949AB",
  "#1E88E5", "#039BE5", "#00ACC1", "#00897B", "#43A047",
  "#7CB342", "#C0CA33", "#FDD835", "#FFB300", "#FB8C00",
  "#F4511E", "#6D4C41", "#546E7A",
];

const FRAME_RATIOS = [0.4, 0.5, 0.6, 0.7];

// ==================== 工具函数 ====================

function fixImageUrl(url: string): string {
  if (!url) return "";
  return url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
}

/** 根据 gift_id 哈希返回一个 badge 颜色 */
function badgeColorFromGiftId(giftId: number): string {
  let h = 0;
  const s = String(giftId);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return GIFT_BADGE_COLORS[Math.abs(h) % GIFT_BADGE_COLORS.length];
}

function getDateRangeFilter(type: string): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (type) {
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayEnd = new Date(today);
      return { start: yesterday, end: yesterdayEnd };
    }
    case "thisWeek": {
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }
    case "lastWeek": {
      const dayOfWeek = today.getDay();
      const thisMonday = new Date(today);
      thisMonday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const lastMonday = new Date(thisMonday);
      lastMonday.setDate(lastMonday.getDate() - 7);
      return { start: lastMonday, end: thisMonday };
    }
    default: {
      // 默认本周
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      const nextMonday = new Date(monday);
      nextMonday.setDate(nextMonday.getDate() + 7);
      return { start: monday, end: nextMonday };
    }
  }
}

function formatDateDisplay(dateStr: string): string {
  return dateStr.replace(/-/g, ".");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = fixImageUrl(src);
  });
}

// ==================== 椭圆羽化遮罩提取（基于 aFrame 定位 + 固定轴比径向渐变） ====================

/** aFrame 扫描得到的内容边界信息（4 帧共用，与椭圆轴比无关） */
type ContentBounds = {
  outW: number;
  outH: number;
  cx: number;
  cy: number;
  contentH: number; // 识别出的内容矩形高度
};

/** 预计算的遮罩数据（包含椭圆参数和裁切信息，按 aspectRatio 缓存） */
type MaskData = {
  outW: number;
  outH: number;
  cx: number;
  cy: number;
  erx: number;
  ery: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
};

/** 计算好的椭圆参数 */
type EllipseParams = {
  cx: number;
  cy: number;
  erx: number;
  ery: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
};

/**
 * 根据内容边界和固定轴比计算椭圆参数。
 * 规则：椭圆高度填满内容矩形的高，宽度由 aspectRatio（高/宽）决定；
 * 若宽度超出画布或高度超出画布边界，按比例缩小以适应。
 */
function computeEllipseForRatio(
  bounds: ContentBounds,
  aspectRatio: number, // ery / erx
): EllipseParams {
  const { outW, outH, cx, cy, contentH } = bounds;

  // 椭圆高填满内容矩形：ery = contentH/2
  let ery = contentH / 2;
  if (ery <= 0 || !isFinite(ery)) ery = outH / 2;

  let erx = ery / aspectRatio;

  // 检查是否超出边界，计算需要的缩放比例
  let scale = 1;

  // 上下边界限制
  const maxEryTop = cy;
  const maxEryBottom = outH - cy;
  const maxEry = Math.min(maxEryTop, maxEryBottom);
  if (ery > maxEry) {
    scale = Math.min(scale, maxEry / ery);
  }

  // 左右边界限制
  const maxErx = outW / 2;
  if (erx > maxErx) {
    scale = Math.min(scale, maxErx / erx);
  }

  // 应用缩放
  ery *= scale;
  erx *= scale;

  // 防御
  if (!isFinite(erx) || erx <= 0) erx = outW / 2;
  if (!isFinite(ery) || ery <= 0) ery = outH / 2;

  // 紧凑裁切区域（含羽化边距）
  const featherMargin = Math.max(erx, ery) * 0.08;
  const cropX = Math.max(0, Math.floor(cx - erx - featherMargin));
  const cropY = Math.max(0, Math.floor(cy - ery - featherMargin));
  const cropW = Math.min(outW - cropX, Math.ceil(erx * 2 + featherMargin * 2));
  const cropH = Math.min(outH - cropY, Math.ceil(ery * 2 + featherMargin * 2));

  return { cx, cy, erx, ery, cropX, cropY, cropW, cropH };
}

/**
 * 快速获取 aFrame 灰度图像的有效上下边界
 */
function getVerticalBounds(
  imageData: ImageData,
  width: number,
  height: number,
  step = 8,
  threshold = 10,
): { y: number; h: number } {
  const data = imageData.data;
  let minY = 0;
  let maxY = height;

  const isSolid = (x: number, y: number) =>
    data[(y * width + x) * 4] > threshold;

  topLoop: for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (isSolid(x, y)) {
        minY = Math.max(0, y - step);
        break topLoop;
      }
    }
  }

  bottomLoop: for (let y = height - 1; y >= 0; y -= step) {
    for (let x = 0; x < width; x += step) {
      if (isSolid(x, y)) {
        maxY = Math.min(height, y + step);
        break bottomLoop;
      }
    }
  }

  return { y: minY, h: maxY - minY };
}

/**
 * 从视频当前帧提取 aFrame，定位主体上下边界，然后根据固定轴比计算椭圆参数。
 * 调用前需确保 video 已 seek 到一个有代表性的帧（如 50%）。
 */
function prepareMaskFromVideo(
  video: HTMLVideoElement,
  config: EffectConfig,
  aspectRatio: number,
): MaskData {
  const info = config.info;
  const [ax, ay, aw, ah] = info.aFrame;
  const scale = info.scale || 1;

  const outW = Math.max(1, Math.round(info.w * scale));
  const outH = Math.max(1, Math.round(info.h * scale));

  // 提取 aFrame 灰度图（aw×ah 与输出尺寸一致，无需坐标映射）
  const aCanvas = document.createElement("canvas");
  aCanvas.width = Math.max(1, aw);
  aCanvas.height = Math.max(1, ah);
  const aCtx = aCanvas.getContext("2d");
  if (aCtx) {
    try {
      aCtx.drawImage(video, ax, ay, aw, ah, 0, 0, aCanvas.width, aCanvas.height);
    } catch {
      // 跨域等问题导致无法绘制
    }
  }

  // 扫描上下边界
  let aData: ImageData | null = null;
  if (aCtx && aCanvas.width > 0 && aCanvas.height > 0) {
    try {
      aData = aCtx.getImageData(0, 0, aCanvas.width, aCanvas.height);
    } catch {
      // 跨域等问题
    }
  }

  let contentY = 0;
  let contentH = outH;
  if (aData) {
    const bounds = getVerticalBounds(aData, aCanvas.width, aCanvas.height, 8, 20);
    contentY = bounds.y;
    contentH = bounds.h;
  }

  // 边界检测失败时回退到全高居中
  let cx = outW / 2;
  let cy = contentY + contentH / 2;
  let effectiveContentH = contentH;

  if (contentH <= 0 || contentH > outH * 1.2) {
    cy = outH / 2;
    effectiveContentH = outH;
  }
  if (cy - effectiveContentH / 2 < 0) cy = effectiveContentH / 2;
  if (cy + effectiveContentH / 2 > outH) cy = outH - effectiveContentH / 2;

  const contentBounds: ContentBounds = { outW, outH, cx, cy, contentH: effectiveContentH };
  const ellipse = computeEllipseForRatio(contentBounds, aspectRatio);
  return { outW, outH, ...ellipse };
}

/**
 * 假设 video 已 seek 到目标帧位置，用预计算的 MaskData 渲染一帧。
 * 椭圆外为透明背景，椭圆内保留视频内容（含视频本身的黑色背景）。
 */
function renderFrameWithMask(
  video: HTMLVideoElement,
  config: EffectConfig,
  mask: MaskData,
): HTMLCanvasElement | null {
  const info = config.info;
  const [rx, ry, rw, rh] = info.rgbFrame;
  const { outW, outH, cx, cy, erx, ery, cropX, cropY, cropW, cropH } = mask;

  if (outW < 1 || outH < 1 || erx < 1 || ery < 1) return null;

  // 1. 创建画布，先填充黑色背景（视频本身背景也是黑色），再绘制 RGB 帧
  const rgbCanvas = document.createElement("canvas");
  rgbCanvas.width = outW;
  rgbCanvas.height = outH;
  const ctx = rgbCanvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(video, rx, ry, rw, rh, 0, 0, outW, outH);

  // 2. 创建 alpha 遮罩画布：白色椭圆（中心不透，边缘羽化到透明）
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = outW;
  maskCanvas.height = outH;
  const mctx = maskCanvas.getContext("2d");
  if (!mctx) return null;

  const maxAxis = Math.max(erx, ery);
  const feather = maxAxis * 0.15;
  let innerR = 1 - feather / maxAxis;
  if (!isFinite(innerR) || innerR < 0) innerR = 0.6;
  if (innerR > 1) innerR = 1;

  mctx.save();
  mctx.translate(cx, cy);
  mctx.scale(erx, ery);

  const grad = mctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(innerR, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");

  mctx.fillStyle = grad;
  const pad = Math.max(outW / erx, outH / ery) + 2;
  mctx.fillRect(-pad, -pad, pad * 2, pad * 2);
  mctx.restore();

  // 3. 将遮罩作为 alpha 通道应用：destination-in 保留椭圆内内容
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";

  // 4. 裁切到紧凑区域
  const result = document.createElement("canvas");
  result.width = cropW;
  result.height = cropH;
  const rctx = result.getContext("2d");
  if (!rctx) return null;
  rctx.drawImage(rgbCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  return result;
}

/** Seek 到指定比例，返回 Promise */
function seekTo(video: HTMLVideoElement, ratio: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const onSeeked = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = video.duration * ratio;
    setTimeout(() => {
      if (!settled) {
        settled = true;
        video.removeEventListener("seeked", onSeeked);
        resolve();
      }
    }, 10000);
  });
}

// ==================== 组件 ====================

export default function GiftScreenshotPanel({
  records,
  anchorName,
  anchorFace,
  giftDb,
  fanFaces: parentFanFaces,
  yesterdayAvailable,
  mid = 0,
  uname = "",
}: {
  records: AnchorGiftRecord[];
  anchorName: string;
  anchorFace: string;
  giftDb: Record<number, { img: string }>;
  fanFaces: Record<number, string>;
  yesterdayAvailable?: boolean;
  mid?: number;
  uname?: string;
}) {
  // 筛选状态
  const [dateFilter, setDateFilter] = useState<string>("thisWeek");
  const [priceFilter, setPriceFilter] = useState<number>(10000);
  const [fanFilter, setFanFilter] = useState<string>("");
  const [showToast, setShowToast] = useState<string>("");

  // 选中的礼物
  const [selectedGifts, setSelectedGifts] = useState<SelectedGift[]>([]);

  // 特效数据
  const [effectDataMap, setEffectDataMap] = useState<Record<number, GiftEffectData>>({});
  const [loadingEffects, setLoadingEffects] = useState(false);

  // 视频帧缓存：key = `${mp4Url}_${frameIndex}_${aspectRatio}`
  const frameCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  // 椭圆遮罩缓存：key = `${mp4Url}_${aspectRatio}`，4 帧共用
  const maskCacheRef = useRef<Map<string, MaskData>>(new Map());

  // Canvas 预览
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 卡片中礼物布局（用于点击检测）
  const giftLayoutsRef = useRef<(Layout & { giftKey: string })[]>([]);
  const renderCardRef = useRef<() => Promise<void>>(async () => {});

  // 帧选择弹窗
  const [framePicker, setFramePicker] = useState<{
    giftKey: string;
    giftName: string;
    effect: GiftEffectData;
  } | null>(null);
  const [framePickerFrames, setFramePickerFrames] = useState<HTMLCanvasElement[]>([]);
  const [framePickerLoading, setFramePickerLoading] = useState(false);

  // 粉丝头像：先查 send-fans-list，再 API
  const [localFaces, setLocalFaces] = useState<Record<number, string>>({});
  const mergedFaces = { ...localFaces, ...parentFanFaces };

  // 加载 send-fans-list.json
  const [anchorFacesJson, setAnchorFacesJson] = useState<Record<string, string>>({});
  useEffect(() => {
    if (mid <= 0) return;
    fetch(serverApiUrl(`/api/faces?mid=${mid}&uname=${encodeURIComponent(uname)}`))
      .then(r => r.json())
      .then(data => {
        if (data.code === 0 && data.data) {
          // 转换 { uid: { name, face } } 为 { uid: faceUrl } 格式
          const faceMap: Record<string, string> = {};
          for (const [k, v] of Object.entries(data.data)) {
            const entry = v as { name?: string; face?: string };
            if (entry.face) faceMap[k] = entry.face;
          }
          setAnchorFacesJson(faceMap);
        }
      })
      .catch(() => {});
  }, [mid, uname]);

  // Toast 自动消失
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(""), 2000);
      return () => clearTimeout(timer);
    }
  }, [showToast]);

  // ==================== 筛选逻辑 ====================

  // 所有符合条件的礼物（扁平列表，不按粉丝分组）
  const allGifts = (() => {
    const dateRange = getDateRangeFilter(dateFilter);
    const filtered = records.filter(r => {
      const t = new Date(r.time).getTime();
      return t >= dateRange.start.getTime() && t < dateRange.end.getTime();
    });

    // 按粉丝+礼物聚合
    const fanMap = new Map<number, {
      uname: string;
      gifts: Map<number, { name: string; hamster: number; num: number }>;
    }>();

    for (const r of filtered) {
      const unitHamster = r.num > 0 ? r.hamster / r.num : r.hamster; // 单个礼物的主播收益
      const unitPriceBattery = (unitHamster * 2) / 100; // 主播收益 * 2 = 礼物单价(金仓鼠)，再 / 100 转电池
      if (unitPriceBattery < priceFilter) continue;

      let fan = fanMap.get(r.uid);
      if (!fan) {
        fan = { uname: r.uname, gifts: new Map() };
        fanMap.set(r.uid, fan);
      }

      const existing = fan.gifts.get(r.gift_id);
      if (existing) {
        existing.num += r.num;
        existing.hamster += r.hamster;
      } else {
        fan.gifts.set(r.gift_id, { name: r.name, hamster: r.hamster, num: r.num });
      }
    }

    // 扁平化为礼物列表
    const gifts: GiftAggregation[] = [];
    for (const [uid, fan] of fanMap) {
      for (const [giftId, g] of fan.gifts) {
        gifts.push({
          gift_id: giftId,
          name: g.name,
          img: giftDb[giftId]?.img ?? "",
          num: g.num,
          price: ((g.num > 0 ? g.hamster / g.num : g.hamster) * 2) / 100, // 单价(电池)
          fanUid: uid,
          fanName: fan.uname,
        });
      }
    }
    // 按粉丝分组排序，组内按价格降序
    gifts.sort((a, b) => {
      if (a.fanUid !== b.fanUid) return a.fanUid - b.fanUid;
      return b.price - a.price;
    });

    return gifts;
  })();

  // 粉丝列表（用于下拉框）
  const fanList = (() => {
    const seen = new Set<number>();
    const result: { uid: number; uname: string }[] = [];
    for (const g of allGifts) {
      if (!seen.has(g.fanUid)) {
        seen.add(g.fanUid);
        result.push({ uid: g.fanUid, uname: g.fanName });
      }
    }
    return result;
  })();

  // 按粉丝筛选
  const filteredGifts = fanFilter
    ? allGifts.filter(g => g.fanUid === Number(fanFilter))
    : allGifts;

  // 为每个粉丝分配颜色（基于 uid 哈希，跨日期筛选保持一致）
  function getFanColor(uid: number): string {
    // 简单字符串哈希
    let h = 0;
    const s = String(uid);
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return FAN_COLORS[Math.abs(h) % FAN_COLORS.length];
  }
  const fanColorMap = (() => {
    const map = new Map<number, string>();
    for (const g of allGifts) {
      if (!map.has(g.fanUid)) {
        map.set(g.fanUid, getFanColor(g.fanUid));
      }
    }
    return map;
  })();

  // 自动获取粉丝头像：先查 send-fans-list，再 API
  useEffect(() => {
    const neededUids = allGifts.map(g => g.fanUid);
    const missingUids = neededUids.filter(uid => !mergedFaces[uid]);

    if (missingUids.length === 0) return;

    const newFaces: Record<number, string> = {};
    const apiUids: number[] = [];

    // 先查 send-fans-list
    for (const uid of missingUids) {
      const face = anchorFacesJson[String(uid)];
      if (face) {
        newFaces[uid] = face;
      } else {
        apiUids.push(uid);
      }
    }

    // 立即应用已找到的
    if (Object.keys(newFaces).length > 0) {
      setLocalFaces(prev => ({ ...prev, ...newFaces }));
    }

    // 剩余通过 API 获取
    if (apiUids.length === 0) return;

    const batchSize = 50;
    const fetchBatch = async () => {
      const apiFaces: Record<number, string> = {};
      for (let i = 0; i < apiUids.length; i += batchSize) {
        const batch = apiUids.slice(i, i + batchSize);
        try {
          const res = await fetch(serverApiUrl(`/api/tools/user-info?uids=${batch.join(",")}`));
          const data = await res.json();
          if (data.code === 0 && data.data) {
            for (const [uidStr, info] of Object.entries(data.data)) {
              apiFaces[Number(uidStr)] = (info as any).face || "";
            }
          }
        } catch { /* ignore */ }
      }
      setLocalFaces(prev => ({ ...prev, ...apiFaces }));
    };
    fetchBatch();
  }, [allGifts.map(g => g.fanUid).join(","), Object.keys(anchorFacesJson).length]);

  // ==================== 礼物选择逻辑 ====================

  function handleGiftClick(gift: GiftAggregation) {
    const giftKey = `${gift.fanUid}_${gift.gift_id}`;
    const isSelected = selectedGifts.some(
      s => `${s.fanUid}_${s.gift_id}` === giftKey,
    );

    if (isSelected) {
      setSelectedGifts(prev =>
        prev.filter(s => `${s.fanUid}_${s.gift_id}` !== giftKey),
      );
      return;
    }

    if (selectedGifts.length > 0 && selectedGifts[0].fanUid !== gift.fanUid) {
      setShowToast("一次只能制作一个粉丝的礼物卡片，不同粉丝的礼物用颜色区分，请先取消已选礼物");
      return;
    }

    if (selectedGifts.length >= 6) {
      setShowToast("最多只能选择6种礼物");
      return;
    }

    const newSelected: SelectedGift = {
      gift_id: gift.gift_id,
      name: gift.name,
      num: gift.num,
      fanUid: gift.fanUid,
      fanName: gift.fanName,
      fanFace: mergedFaces[gift.fanUid] || "",
      frameIndex: 1, // 默认50%
    };
    setSelectedGifts(prev => [...prev, newSelected]);
  }

  // 当选中的礼物变化时，加载特效数据
  useEffect(() => {
    if (selectedGifts.length === 0) {
      setEffectDataMap({});
      return;
    }

    const giftIds = selectedGifts.map(s => s.gift_id);
    const uniqueIds = [...new Set(giftIds)];
    const missingIds = uniqueIds.filter(id => {
      const existing = effectDataMap[id];
      // 需要重新请求的情况：
      // 1. 完全没有记录
      // 2. 有记录但 found=false（特效列表里没找到，可能是本地缓存过期）
      // 3. 有记录 found=true 但 effect_config 为 null（上次 JSON 拉取失败，需要重试）
      return !existing || !existing.found || (existing.found && !existing.effect_config);
    });

    if (missingIds.length === 0) return;

    setLoadingEffects(true);
    fetchGiftEffects(missingIds)
      .then(data => {
        setEffectDataMap(prev => ({ ...prev, ...data }));
      })
      .catch(err => console.error("获取礼物特效失败:", err))
      .finally(() => setLoadingEffects(false));
  }, [selectedGifts.map(s => s.gift_id).join(",")]);

  // ==================== 视频帧提取（基于 aFrame 定位 + 椭圆径向渐变遮罩） ====================

  async function extractFrame(
    mp4Url: string,
    effectConfig: EffectConfig,
    frameIndex: number,
    aspectRatio: number,
  ): Promise<HTMLCanvasElement | null> {
    const cacheKey = `${mp4Url}_${frameIndex}_${aspectRatio}`;
    const cached = frameCacheRef.current.get(cacheKey);
    if (cached) return cached;

    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = mp4Url;

      const timeout = setTimeout(() => {
        console.warn(`视频加载超时: ${mp4Url}`);
        resolve(null);
      }, 15000);

      let settled = false;
      const done = (canvas: HTMLCanvasElement | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (canvas) frameCacheRef.current.set(cacheKey, canvas);
        resolve(canvas);
      };

      video.onloadedmetadata = async () => {
        try {
          // 1. 准备遮罩（若缓存中没有，先 seek 到 50% 帧计算）
          const maskKey = `${mp4Url}_${aspectRatio}`;
          let mask = maskCacheRef.current.get(maskKey);
          if (!mask) {
            await seekTo(video, 0.5);
            mask = prepareMaskFromVideo(video, effectConfig, aspectRatio);
            maskCacheRef.current.set(maskKey, mask);
          }

          // 2. Seek 到目标帧
          await seekTo(video, FRAME_RATIOS[frameIndex]);

          // 3. 渲染帧
          const canvas = renderFrameWithMask(video, effectConfig, mask);
          done(canvas);
        } catch (e) {
          console.error("提取帧失败:", e);
          done(null);
        }
      };

      video.onerror = () => {
        console.warn(`视频加载失败: ${mp4Url}`);
        done(null);
      };

      video.load();
    });
  }

  async function loadAllFrames(
    mp4Url: string,
    effectConfig: EffectConfig,
    aspectRatio: number,
  ): Promise<(HTMLCanvasElement | null)[]> {
    // 检查缓存，全部命中则直接返回
    const cached = FRAME_RATIOS.map((_, i) => frameCacheRef.current.get(`${mp4Url}_${i}_${aspectRatio}`));
    if (cached.every(Boolean)) return cached as HTMLCanvasElement[];

    return new Promise((resolve) => {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = mp4Url;

      const timeout = setTimeout(() => {
        console.warn(`视频加载超时: ${mp4Url}`);
        resolve(FRAME_RATIOS.map((_, i) => frameCacheRef.current.get(`${mp4Url}_${i}_${aspectRatio}`) || null));
      }, 20000);

      let settled = false;
      const finish = (frames: (HTMLCanvasElement | null)[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(frames);
      };

      video.onloadedmetadata = async () => {
        try {
          // 1. 准备遮罩（seek 到 50% 计算，4 帧共用）
          const maskKey = `${mp4Url}_${aspectRatio}`;
          let mask = maskCacheRef.current.get(maskKey);
          if (!mask) {
            await seekTo(video, 0.5);
            mask = prepareMaskFromVideo(video, effectConfig, aspectRatio);
            maskCacheRef.current.set(maskKey, mask);
          }

          // 2. 依次提取 4 帧（只 seek 到未缓存的帧）
          const results: (HTMLCanvasElement | null)[] = [];
          for (let i = 0; i < FRAME_RATIOS.length; i++) {
            const fKey = `${mp4Url}_${i}_${aspectRatio}`;
            let frame: HTMLCanvasElement | null = frameCacheRef.current.get(fKey) ?? null;
            if (!frame) {
              await seekTo(video, FRAME_RATIOS[i]);
              frame = renderFrameWithMask(video, effectConfig, mask);
              if (frame) frameCacheRef.current.set(fKey, frame);
            }
            results.push(frame || null);
          }

          finish(results);
        } catch (e) {
          console.error("批量提取帧失败:", e);
          finish(FRAME_RATIOS.map((_, i) => frameCacheRef.current.get(`${mp4Url}_${i}_${aspectRatio}`) || null));
        }
      };

      video.onerror = () => {
        console.warn(`视频加载失败: ${mp4Url}`);
        finish(FRAME_RATIOS.map((_, i) => frameCacheRef.current.get(`${mp4Url}_${i}_${aspectRatio}`) || null));
      };

      video.load();
    });
  }

  // ==================== Canvas 卡片渲染 ====================

  const renderCard = useCallback(async () => {
    const canvas = previewCanvasRef.current;
    if (!canvas || selectedGifts.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    console.log("[GiftScreenshot] renderCard: anchorName=", JSON.stringify(anchorName), "anchorFace=", JSON.stringify(anchorFace?.substring(0, 80)));

    canvas.width = CARD_W;
    canvas.height = CARD_H;

    // 整张卡片统一使用标题栏深色背景
    ctx.fillStyle = "#1a1815";
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // ===== 标题栏（无分隔，背景与整体统一） =====
    const headerY = 0;

    // ===== 标题栏内容 =====
    const fan = selectedGifts[0];
    const fanFace = mergedFaces[fan.fanUid] || fan.fanFace;
    const avatarSize = 120;
    // 整体下移：顶部留更多空间，内容靠标题栏下半部分
    const headerCenterY = headerY + HEADER_H * 0.62;

    // 粉丝头像（左侧）
    const fanAvatarX = CARD_W * 0.22 - avatarSize / 2;
    const fanAvatarY = headerCenterY - avatarSize / 2;

    if (fanFace) {
      try {
        const img = await loadImage(fanFace);
        ctx.save();
        ctx.beginPath();
        ctx.arc(fanAvatarX + avatarSize / 2, fanAvatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, fanAvatarX, fanAvatarY, avatarSize, avatarSize);
        ctx.restore();
      } catch { /* ignore */ }
    } else {
      ctx.beginPath();
      ctx.arc(fanAvatarX + avatarSize / 2, fanAvatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fill();
    }

    // 粉丝名（距离底部更多空间）
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fan.fanName, fanAvatarX + avatarSize / 2, fanAvatarY + avatarSize + 34);

    // 主播头像（右侧）
    const anchorAvatarX = CARD_W * 0.78 - avatarSize / 2;
    const anchorAvatarY = headerCenterY - avatarSize / 2;

    if (anchorFace) {
      try {
        const img = await loadImage(anchorFace);
        console.log("[GiftScreenshot] 主播头像加载成功:", anchorFace.substring(0, 80));
        ctx.save();
        ctx.beginPath();
        ctx.arc(anchorAvatarX + avatarSize / 2, anchorAvatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(img, anchorAvatarX, anchorAvatarY, avatarSize, avatarSize);
        ctx.restore();
      } catch (e) {
        console.error("[GiftScreenshot] 主播头像加载失败:", anchorFace?.substring(0, 80), e);
      }
    } else {
      console.log("[GiftScreenshot] 主播头像URL为空，跳过加载");
      ctx.beginPath();
      ctx.arc(anchorAvatarX + avatarSize / 2, anchorAvatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fill();
    }

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(anchorName || "主播", anchorAvatarX + avatarSize / 2, anchorAvatarY + avatarSize + 34);

    // 中间：彩虹实线 + 心形（送礼物主题）
    const centerX = CARD_W / 2;
    const arrowY = headerCenterY;

    ctx.save();
    const arrowLen = 200;
    const arrowStartX = centerX - arrowLen / 2;
    const heartSize = 28;
    const arrowEndX = centerX + arrowLen / 2 - heartSize; // 为心形留出空间

    // 彩虹渐变：左蓝→紫→绿→黄→右粉红，过渡到红心自然衔接
    const lineGrad = ctx.createLinearGradient(arrowStartX, arrowY, arrowEndX, arrowY);
    lineGrad.addColorStop(0, "#00BFFF");   // 电光蓝
    lineGrad.addColorStop(0.25, "#8B00FF"); // 紫罗兰
    lineGrad.addColorStop(0.5, "#39FF14");  // 霓虹绿
    lineGrad.addColorStop(0.75, "#FFD700"); // 亮黄
    lineGrad.addColorStop(1, "#FF1493");    // 桃红（右端，与红心衔接）

    // 实线主干（彩虹色）
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(arrowStartX, arrowY);
    ctx.lineTo(arrowEndX, arrowY);
    ctx.stroke();

    // 起点装饰圆点
    const dotGrad = ctx.createRadialGradient(arrowStartX, arrowY, 0, arrowStartX, arrowY, 8);
    dotGrad.addColorStop(0, "#00BFFF");
    dotGrad.addColorStop(1, "#8B00FF");
    ctx.fillStyle = dotGrad;
    ctx.beginPath();
    ctx.arc(arrowStartX, arrowY, 7, 0, Math.PI * 2);
    ctx.fill();

    // 红色心形（尖部朝右指向主播）：标准心形路径 + 旋转90° + 横向拉伸
    const heartCx = arrowEndX; // 心形左边缘紧贴箭身末端，无缝隙
    const heartCy = arrowY;
    ctx.save();
    ctx.translate(heartCx, heartCy);
    ctx.rotate(-Math.PI / 2); // 旋转90°使心形尖部指向右
    ctx.scale(1, 1.55);       // Y轴拉伸使心形左右更宽更扁
    const hs = heartSize;
    ctx.fillStyle = "#FF2D55"; // 红心
    ctx.beginPath();
    // 标准爱心路径（尖部朝下，旋转后朝右）——4段贝塞尔曲线
    const topH = hs * 0.3;
    ctx.moveTo(0, topH);
    ctx.bezierCurveTo(0, 0, -hs / 2, 0, -hs / 2, topH);                    // 左上弧
    ctx.bezierCurveTo(-hs / 2, (hs + topH) / 2, 0, (hs + topH) / 2, 0, hs); // 左下弧→尖端
    ctx.bezierCurveTo(0, (hs + topH) / 2, hs / 2, (hs + topH) / 2, hs / 2, topH); // 右下弧
    ctx.bezierCurveTo(hs / 2, 0, 0, 0, 0, topH);                            // 右上弧
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // 日期：从所有选中礼物的记录中取最近的日期
    let latestTime = 0;
    for (const g of selectedGifts) {
      for (const r of records) {
        if (r.uid === g.fanUid && r.gift_id === g.gift_id) {
          const t = new Date(r.time).getTime();
          if (t > latestTime) latestTime = t;
        }
      }
    }
    const dateText = latestTime > 0
      ? formatDateDisplay(new Date(latestTime).toISOString().split("T")[0])
      : "";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "bold 32px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(dateText, centerX, arrowY + 55);

    // ===== 主体区域 =====
    const mainY = HEADER_H + 20;
    const mainH = CARD_H - mainY - 60;
    const mainW = CARD_W - 40;

    const count = selectedGifts.length;
    const padding = 20;

    const layouts: Layout[] = [];

    if (count === 1) {
      // 单礼物：截图向上移动，为下方名称留出更多空间
      layouts.push({ x: 20, y: mainY - 25, w: mainW, h: mainH });
    } else if (count === 2) {
      // 上下各占一半（等大）
      const h = (mainH - padding) / 2;
      layouts.push({ x: 20, y: mainY, w: mainW, h });
      layouts.push({ x: 20, y: mainY + h + padding, w: mainW, h });
    } else if (count === 3) {
      // 上1大图（满宽），下2等大
      const topH = (mainH - padding) * 0.52;
      const bottomH = (mainH - padding) * 0.48;
      const bottomW = (mainW - padding) / 2;
      layouts.push({ x: 20, y: mainY, w: mainW, h: topH });
      layouts.push({ x: 20, y: mainY + topH + padding, w: bottomW, h: bottomH });
      layouts.push({ x: 20 + bottomW + padding, y: mainY + topH + padding, w: bottomW, h: bottomH });
    } else if (count === 4) {
      // 2×2 等大撑满
      const cellW = (mainW - padding) / 2;
      const cellH = (mainH - padding) / 2;
      for (let i = 0; i < 4; i++) {
        layouts.push({
          x: 20 + (i % 2) * (cellW + padding),
          y: mainY + Math.floor(i / 2) * (cellH + padding),
          w: cellW,
          h: cellH,
        });
      }
    } else if (count === 5) {
      // 中心大 + 四角（角落缩小，给中心留出更多空间）
      const cornerW = mainW * 0.45;
      const cornerH = mainH * 0.4;
      const centerW = mainW * 0.45;
      const centerH = mainH * 0.45;
      const gap = 0;
      // 中心
      layouts.push({ x: (CARD_W - centerW) / 2, y: mainY + (mainH - centerH) / 2, w: centerW, h: centerH });
      // 左上
      layouts.push({ x: 20, y: mainY, w: cornerW, h: cornerH });
      // 右上
      layouts.push({ x: CARD_W - 20 - cornerW, y: mainY, w: cornerW, h: cornerH });
      // 左下
      layouts.push({ x: 20, y: mainY + mainH - cornerH, w: cornerW, h: cornerH });
      // 右下
      layouts.push({ x: CARD_W - 20 - cornerW, y: mainY + mainH - cornerH, w: cornerW, h: cornerH });
    } else if (count === 6) {
      // 3×2 等大撑满（3行2列）
      const cellW = (mainW - padding) / 2;
      const cellH = (mainH - padding * 2) / 3;
      for (let i = 0; i < 6; i++) {
        layouts.push({
          x: 20 + (i % 2) * (cellW + padding),
          y: mainY + Math.floor(i / 2) * (cellH + padding),
          w: cellW,
          h: cellH,
        });
      }
    } else {
      // 超过6个礼物：自动按列数=ceil(sqrt(n*ratio))，行数=ceil(n/cols)
      const ratio = mainW / mainH;
      let cols = Math.max(2, Math.ceil(Math.sqrt(count * ratio)));
      let rows = Math.ceil(count / cols);
      const cellW = (mainW - padding * (cols - 1)) / cols;
      const cellH = (mainH - padding * (rows - 1)) / rows;
      for (let i = 0; i < count; i++) {
        layouts.push({
          x: 20 + (i % cols) * (cellW + padding),
          y: mainY + Math.floor(i / cols) * (cellH + padding),
          w: cellW,
          h: cellH,
        });
      }
    }

    // 确定当前椭圆轴比：1个礼物时1.5（高大于宽），其余1.1
    const aspectRatio = count === 1 ? 1.5 : 1.1;

    // 保存布局用于点击检测
    giftLayoutsRef.current = selectedGifts.map((g, i) => ({
      ...layouts[i],
      giftKey: `${g.fanUid}_${g.gift_id}`,
    }));

    // 渲染每个礼物
    // 3个礼物时缓存底部两个单元格，用于统一尺寸
    const bottomRowCache: Array<{
      frameCanvas: HTMLCanvasElement | null;
      layout: (typeof layouts)[0];
      gift: (typeof selectedGifts)[0];
      badgeColor: string;
      badgeH: number;
      badgeGap: number;
      imgAreaY: number;
      imgAreaH: number;
      drawX: number;
      drawY: number;
      drawW: number;
      drawH: number;
    }> = [];

    for (let i = 0; i < selectedGifts.length; i++) {
      const gift = selectedGifts[i];
      const layout = layouts[i];
      const effect = effectDataMap[gift.gift_id];

      // 礼物名称 badge 区域
      const badgePadX = 24;
      const badgePadY = 10;
      const badgeGap = -10; // 紧贴截图底部的固定间距
      const fontSize = Math.max(22, Math.min(layout.w * 0.06, 38));
      const badgeH = fontSize + badgePadY * 2;
      const imgAreaY = layout.y;
      const imgAreaH = layout.h - badgeH;

      // 计算该礼物 badge 颜色（按 gift_id 哈希）
      const badgeColor = badgeColorFromGiftId(gift.gift_id);

      /** 绘制带 badge 的名称 */
      const drawNameBadge = (nameCenterX: number, nameBaselineY: number) => {
        ctx.save();
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const textW = ctx.measureText(gift.name).width;
        const bw = textW + badgePadX * 2;
        const bh = badgeH;
        const bx = nameCenterX - bw / 2;
        const by = nameBaselineY - bh / 2;
        const radius = bh / 2;
        // badge 背景（圆角 pill）
        ctx.fillStyle = badgeColor;
        ctx.beginPath();
        ctx.moveTo(bx + radius, by);
        ctx.lineTo(bx + bw - radius, by);
        ctx.arc(bx + bw - radius, by + radius, radius, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(bx + radius, by + bh);
        ctx.arc(bx + radius, by + radius, radius, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();
        // 文字
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 2;
        ctx.fillText(gift.name, nameCenterX, nameBaselineY);
        ctx.restore();
      };

      if (!effect?.found || !effect.effect_config) {
        // 构造与真实帧完全相同的椭圆占位：crop 尺寸、椭圆形状、羽化边缘均一致
        const dataH = imgAreaH;
        const ery = dataH / 2;
        const erx = ery / aspectRatio;
        const maxAxis = Math.max(erx, ery);
        const featherMargin = maxAxis * 0.08;
        const cropW = Math.ceil(erx * 2 + featherMargin * 2);
        const cropH = Math.ceil(ery * 2 + featherMargin * 2);

        // 创建占位帧 canvas（与真实帧完全相同的 crop 尺寸）
        const phCanvas = document.createElement("canvas");
        phCanvas.width = cropW;
        phCanvas.height = cropH;
        const phCtx = phCanvas.getContext("2d");
        if (!phCtx) {
          drawNameBadge(layout.x + layout.w / 2, imgAreaY + imgAreaH + badgeGap + badgeH / 2);
          continue;
        }

        const phCx = cropW / 2;
        const phCy = cropH / 2;

        // 椭圆填充（与真实帧相同的羽化渐变，深色背景）
        const phInnerR = 1 - (maxAxis * 0.15) / maxAxis; // 0.85
        phCtx.save();
        phCtx.translate(phCx, phCy);
        phCtx.scale(erx, ery);
        const phGrad = phCtx.createRadialGradient(0, 0, 0, 0, 0, 1);
        phGrad.addColorStop(0, "rgba(40,36,30,1)");
        phGrad.addColorStop(phInnerR, "rgba(40,36,30,1)");
        phGrad.addColorStop(1, "rgba(40,36,30,0)");
        phCtx.fillStyle = phGrad;
        const phPad = Math.max(cropW / erx, cropH / ery) + 2;
        phCtx.fillRect(-phPad, -phPad, phPad * 2, phPad * 2);
        phCtx.restore();

        // 文字（更大）
        const nameFontSize = Math.max(32, Math.min(cropW * 0.18, 55));
        phCtx.fillStyle = "rgba(255,255,255,0.5)";
        phCtx.font = `bold ${nameFontSize}px sans-serif`;
        phCtx.textAlign = "center";
        phCtx.textBaseline = "middle";
        phCtx.fillText(gift.name, phCx, phCy - nameFontSize * 0.4);
        phCtx.fillStyle = "rgba(255,255,255,0.3)";
        phCtx.font = `${nameFontSize * 0.55}px sans-serif`;
        phCtx.fillText("(暂无动画)", phCx, phCy + nameFontSize * 0.6);

        // 按真实帧相同方式缩放绘制到主画布
        const s = Math.min(layout.w / cropW, imgAreaH / cropH);
        const drawW = cropW * s;
        const drawH = cropH * s;
        const drawX = layout.x + (layout.w - drawW) / 2;
        const drawY = imgAreaY + (imgAreaH - drawH) / 2;
        ctx.drawImage(phCanvas, drawX, drawY, drawW, drawH);

        // 名称 badge（紧贴截图底部）
        drawNameBadge(layout.x + layout.w / 2, drawY + drawH + badgeGap + badgeH / 2);
        continue;
      }

      const frameCanvas = await extractFrame(
        effect.web_mp4!,
        effect.effect_config,
        gift.frameIndex,
        aspectRatio,
      );

      // 记录截图实际绘制位置（供数量标签使用）
      let drawX = layout.x;
      let drawY = imgAreaY;
      let drawW = layout.w;
      let drawH = imgAreaH;

      if (frameCanvas) {
        const fw = frameCanvas.width;
        const fh = frameCanvas.height;
        const s = Math.min(layout.w / fw, imgAreaH / fh);
        drawW = fw * s;
        drawH = fh * s;
        drawX = layout.x + (layout.w - drawW) / 2;
        drawY = imgAreaY + (imgAreaH - drawH) / 2;

        // 3个礼物时，底部两个先缓存不绘制，等统一尺寸后再绘制
        if (count === 3 && i >= 1) {
          bottomRowCache.push({
            frameCanvas, layout, gift, badgeColor, badgeH, badgeGap,
            imgAreaY, imgAreaH, drawX, drawY, drawW, drawH,
          });
          continue;
        }

        ctx.drawImage(frameCanvas, drawX, drawY, drawW, drawH);
      }

      // 礼物名称 badge（紧贴截图底部）
      drawNameBadge(layout.x + layout.w / 2, drawY + drawH + badgeGap + badgeH / 2);

      // 数量标签（右下角，在 badge 之后绘制避免被覆盖）
      if (frameCanvas && gift.num > 1) {
        const labelX = drawX + drawW - 16;
        const labelY = drawY + drawH - 16;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.7)";
        ctx.shadowBlur = 10;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        const numFontSize = Math.min(Math.max(drawH * 0.16, 32), 60);
        ctx.font = `bold ${numFontSize}px 'Arial Black', 'Impact', sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        const numText = `x${gift.num}`;
        const grad = ctx.createLinearGradient(labelX - 80, labelY - numFontSize, labelX, labelY);
        grad.addColorStop(0, badgeColor);
        grad.addColorStop(1, "#FFFFFF");
        ctx.fillStyle = grad;
        ctx.fillText(numText, labelX, labelY);
        ctx.restore();
      }
    }

    // 3个礼物时，统一底部两个截图的尺寸，确保对称
    if (count === 3 && bottomRowCache.length === 2) {
      const [info1, info2] = bottomRowCache;
      const commonDrawW = Math.min(info1.drawW, info2.drawW);
      const commonDrawH = Math.min(info1.drawH, info2.drawH);

      for (const info of bottomRowCache) {
        const { frameCanvas, layout, gift, badgeColor, badgeH, badgeGap, imgAreaY, imgAreaH } = info;
        if (!frameCanvas) continue;

        // 清除该单元格区域
        ctx.fillStyle = "#1a1815";
        ctx.fillRect(layout.x, layout.y, layout.w, layout.h);

        // 居中绘制统一尺寸的截图
        const dX = layout.x + (layout.w - commonDrawW) / 2;
        const dY = imgAreaY + (imgAreaH - commonDrawH) / 2;
        ctx.drawImage(frameCanvas, dX, dY, commonDrawW, commonDrawH);

        // 重新绘制 badge
        const fontSize = Math.max(22, Math.min(layout.w * 0.06, 38));
        const _badgeH = fontSize + 20;
        const badgePadX = 24;
        ctx.save();
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const textW = ctx.measureText(gift.name).width;
        const bw = textW + badgePadX * 2;
        const bh = _badgeH;
        const badgeCenterX = layout.x + layout.w / 2;
        const badgeCenterY = dY + commonDrawH + badgeGap + _badgeH / 2;
        const bx = badgeCenterX - bw / 2;
        const by = badgeCenterY - bh / 2;
        const radius = bh / 2;
        ctx.fillStyle = badgeColor;
        ctx.beginPath();
        ctx.moveTo(bx + radius, by);
        ctx.lineTo(bx + bw - radius, by);
        ctx.arc(bx + bw - radius, by + radius, radius, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(bx + radius, by + bh);
        ctx.arc(bx + radius, by + radius, radius, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "rgba(0,0,0,0.3)";
        ctx.shadowBlur = 2;
        ctx.fillText(gift.name, badgeCenterX, badgeCenterY);
        ctx.restore();

        // 重新绘制数量标签
        if (gift.num > 1) {
          const labelX = dX + commonDrawW - 16;
          const labelY = dY + commonDrawH - 16;
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.7)";
          ctx.shadowBlur = 10;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
          const numFontSize = Math.min(Math.max(commonDrawH * 0.16, 32), 60);
          ctx.font = `bold ${numFontSize}px 'Arial Black', 'Impact', sans-serif`;
          ctx.textAlign = "right";
          ctx.textBaseline = "bottom";
          const numGrad = ctx.createLinearGradient(labelX - 80, labelY - numFontSize, labelX, labelY);
          numGrad.addColorStop(0, badgeColor);
          numGrad.addColorStop(1, "#FFFFFF");
          ctx.fillStyle = numGrad;
          ctx.fillText(`x${gift.num}`, labelX, labelY);
          ctx.restore();
        }
      }
    }

    // ===== 霓虹渐变边框（极细、圆角、彩虹色，内外双向辐射光晕） =====
    const borderRadius = 30;
    const borderWidth = 10;

    // 圆角矩形路径
    const r = borderRadius;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(CARD_W - r, 0);
    ctx.quadraticCurveTo(CARD_W, 0, CARD_W, r);
    ctx.lineTo(CARD_W, CARD_H - r);
    ctx.quadraticCurveTo(CARD_W, CARD_H, CARD_W - r, CARD_H);
    ctx.lineTo(r, CARD_H);
    ctx.quadraticCurveTo(0, CARD_H, 0, CARD_H - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();

    // 彩虹渐变：电光蓝 → 紫罗兰 → 桃红 → 亮黄 → 霓虹绿
    const neonGrad = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
    neonGrad.addColorStop(0, "#00BFFF");    // 电光蓝
    neonGrad.addColorStop(0.25, "#8B00FF");  // 紫罗兰
    neonGrad.addColorStop(0.5, "#FF1493");   // 桃红
    neonGrad.addColorStop(0.75, "#FFD700");  // 亮黄
    neonGrad.addColorStop(1, "#39FF14");     // 霓虹绿

    ctx.save();
    // 多层光晕，内外双向辐射
    const glowLayers = [
      { blur: 30, alpha: 0.10, width: 14 },
      { blur: 20, alpha: 0.18, width: 10 },
      { blur: 10, alpha: 0.30, width: 6 },
    ];
    for (const layer of glowLayers) {
      ctx.save();
      ctx.shadowColor = "rgba(139,0,255,0.5)";
      ctx.shadowBlur = layer.blur;
      ctx.globalAlpha = layer.alpha;
      ctx.strokeStyle = neonGrad;
      ctx.lineWidth = layer.width;
      ctx.stroke();
      ctx.restore();
    }

    // 最外层细边框
    ctx.shadowColor = "rgba(139,0,255,0.6)";
    ctx.shadowBlur = 6;
    ctx.strokeStyle = neonGrad;
    ctx.lineWidth = borderWidth;
    ctx.stroke();
    ctx.restore();

    setPreviewUrl(canvas.toDataURL("image/png"));
  }, [selectedGifts, effectDataMap, anchorName, anchorFace, records, mergedFaces]);

  // 保持 ref 指向最新 renderCard，避免 useEffect 因 renderCard 变化而频繁触发
  renderCardRef.current = renderCard;

  // 当选中的礼物或特效数据变化时重新渲染
  useEffect(() => {
    if (selectedGifts.length > 0) {
      const allReady = selectedGifts.every(g => {
        const effect = effectDataMap[g.gift_id];
        return effect?.found;
      });
      if (allReady || Object.keys(effectDataMap).length > 0) {
        renderCardRef.current();
      }
    }
  }, [selectedGifts, effectDataMap]);

  // ==================== 帧选择器 ====================

  async function openFramePicker(giftKey: string) {
    const gift = selectedGifts.find(
      s => `${s.fanUid}_${s.gift_id}` === giftKey,
    );
    if (!gift) return;

    const effect = effectDataMap[gift.gift_id];
    if (!effect?.found || !effect.effect_config || !effect.web_mp4) return;

    // 使用与画布一致的轴比
    const aspectRatio = selectedGifts.length === 1 ? 1.5 : 1.1;

    setFramePicker({ giftKey, giftName: gift.name, effect });
    setFramePickerFrames([]);
    setFramePickerLoading(true);

    const frames = await loadAllFrames(effect.web_mp4, effect.effect_config, aspectRatio);
    setFramePickerFrames(frames.filter(Boolean) as HTMLCanvasElement[]);
    setFramePickerLoading(false);
  }

  function selectFrame(frameIndex: number) {
    if (!framePicker) return;
    setSelectedGifts(prev =>
      prev.map(s => {
        if (`${s.fanUid}_${s.gift_id}` === framePicker.giftKey) {
          return { ...s, frameIndex };
        }
        return s;
      }),
    );
    setFramePicker(null);
  }

  // 卡片预览区点击处理
  function handlePreviewClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / rect.width * CARD_W;
    const clickY = (e.clientY - rect.top) / rect.height * CARD_H;

    for (const layout of giftLayoutsRef.current) {
      if (
        clickX >= layout.x &&
        clickX <= layout.x + layout.w &&
        clickY >= layout.y &&
        clickY <= layout.y + layout.h
      ) {
        openFramePicker(layout.giftKey);
        return;
      }
    }
  }

  // ==================== 下载 ====================

  async function handleDownload() {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    setDownloading(true);
    try {
      await renderCard();

      if (isMobileDevice()) {
        // 移动端：直接保存到相册（系统分享面板）
        const url = canvas.toDataURL("image/png");
        const res = await saveMobileOrDownload(url, `gift_screenshot_${Date.now()}.png`);
        // 分享被取消/不可用时，展示预览供长按保存，避免误以为已保存
        if (res === "fallback") {
          setPreviewUrl(url);
          setShowDownloadModal(true);
        }
      } else {
        canvas.toBlob(blob => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `gift_screenshot_${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);
          setShowToast("图片已保存");
        }, "image/png");
      }
    } catch (err) {
      console.error("下载失败:", err);
    } finally {
      setDownloading(false);
    }
  }

  // 移动端：监听窗口焦点变化，用户长按保存后返回页面时自动关闭弹窗
  // 手机长按图片触发系统分享菜单时，页面不会进入 hidden 状态（visibilitychange 不触发），
  // 但浏览器窗口会失去焦点。分享菜单关闭后窗口重新获得焦点，此时自动关闭弹窗。
  useEffect(() => {
    if (!showDownloadModal) return;

    const handleReturn = () => {
      setShowDownloadModal(false);
      setPreviewUrl("");
    };

    // visibilitychange：iOS 部分场景下会触发
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) handleReturn();
    });
    // focus：Android 和 iOS 分享菜单关闭后窗口重新获得焦点，最可靠
    window.addEventListener("focus", handleReturn);

    return () => {
      document.removeEventListener("visibilitychange", handleReturn);
      window.removeEventListener("focus", handleReturn);
    };
  }, [showDownloadModal]);

  // ==================== 渲染 ====================

  return (
    <div className="space-y-4">
      {/* Toast */}
      {showToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[9999] bg-black/85 text-white px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity">
          {showToast}
        </div>
      )}

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* 日期按钮组 */}
        <div className="flex border border-black/10 rounded-lg overflow-hidden">
          {DATE_OPTIONS.map(opt => {
            const isYesterday = opt.key === "yesterday";
            const disabled = isYesterday && yesterdayAvailable === false;
            return (
            <button
              key={opt.key}
              disabled={disabled}
              title={disabled ? "昨日数据官方尚未更新，预计12点前更新" : undefined}
              onClick={() => setDateFilter(opt.key)}
              className={`px-3 py-1.5 text-xs whitespace-nowrap transition ${
                dateFilter === opt.key
                  ? "bg-[#1f1c17] text-white"
                  : disabled
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : "bg-white text-black/65 hover:bg-black/5"
              }`}
            >
              {opt.label}
            </button>
            );
          })}
        </div>

        {/* 价格筛选下拉 */}
        <select
          value={priceFilter}
          onChange={e => setPriceFilter(Number(e.target.value))}
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-black/65 outline-none"
        >
          {PRICE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {/* 粉丝下拉 */}
        <select
          value={fanFilter}
          onChange={e => setFanFilter(e.target.value)}
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-black/65 outline-none"
        >
          <option value="">全部粉丝</option>
          {fanList.map(f => (
            <option key={f.uid} value={f.uid}>{f.uname}</option>
          ))}
        </select>

        {selectedGifts.length > 0 && (
          <button
            onClick={() => setSelectedGifts([])}
            className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-500 hover:bg-red-600 transition"
          >
            清除选择
          </button>
        )}
      </div>

      {/* 礼物按钮区（扁平排列，按钮背景色区分粉丝） */}
      {filteredGifts.length === 0 ? (
        <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4 text-center">
          <div className="text-sm text-black/35">暂无符合条件的礼物</div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {filteredGifts.map(gift => {
            const giftKey = `${gift.fanUid}_${gift.gift_id}`;
            const isSelected = selectedGifts.some(
              s => `${s.fanUid}_${s.gift_id}` === giftKey,
            );
            const bgColor = fanColorMap.get(gift.fanUid) || "#e0e0e0";
            return (
              <button
                key={giftKey}
                onClick={() => handleGiftClick(gift)}
                className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-xs transition border ${
                  isSelected
                    ? "border-[#1f1c17] bg-[#1f1c17] text-white shadow-md"
                    : "border-black/10 text-black/75 hover:opacity-80"
                }`}
                style={isSelected ? {} : { backgroundColor: bgColor }}
              >
                {gift.img && (
                  <img src={fixImageUrl(gift.img)} alt="" className="w-4 h-4 rounded" />
                )}
                <span className="font-medium">{gift.name}</span>
                <span className={isSelected ? "text-white/70" : "text-black/40"}>
                  x{gift.num}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Canvas 预览区 */}
      {selectedGifts.length > 0 && (
        <div className="rounded-xl border border-black/10 bg-white/80 p-4 shadow-[0_20px_80px_rgba(31,28,23,0.08)]">
          <h3 className="text-sm font-semibold mb-3">卡片预览</h3>

          <div className="flex justify-center">
            <div className="relative" style={{ width: "270px", height: "480px" }}>
              <canvas
                ref={previewCanvasRef}
                className="w-full h-full rounded-lg shadow-lg cursor-pointer"
                onClick={handlePreviewClick}
                title="点击礼物画面切换截图帧"
              />
            </div>
          </div>

          {/* 下载按钮 */}
          <div className="flex justify-center mt-4">
            <button
              onClick={handleDownload}
              disabled={downloading || loadingEffects}
              className="modal-action-btn modal-action-primary"
            >
              {downloading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  生成中...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  下载保存图片
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* 帧选择弹窗（漂浮样式） */}
      {framePicker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setFramePicker(null)}
        >
          <div className="flex flex-col items-center" onClick={e => e.stopPropagation()}>
            <span className="text-white/90 text-sm font-medium mb-4">
              {framePicker.giftName} — 选择截图帧
            </span>
            {framePickerLoading ? (
              <div className="flex items-center gap-2 text-white/70">
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span className="text-sm">加载中...</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {framePickerFrames.map((frameCanvas, idx) => (
                  <button
                    key={idx}
                    onClick={() => selectFrame(idx)}
                    className="relative rounded-xl overflow-hidden shadow-2xl hover:scale-105 transition-transform"
                    style={{ width: "160px" }}
                  >
                    <img
                      src={frameCanvas.toDataURL("image/png")}
                      alt={`${Math.round(FRAME_RATIOS[idx] * 100)}%`}
                      className="w-full"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs py-1 text-center">
                      {Math.round(FRAME_RATIOS[idx] * 100)}%
                    </div>
                  </button>
                ))}
                {framePickerFrames.length === 0 && !framePickerLoading && (
                  <div className="col-span-2 text-center text-sm text-white/70 py-4">
                    无法加载视频帧，可能视频跨域被阻止
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setFramePicker(null)}
              className="mt-5 modal-action-btn modal-action-light"
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 移动端下载弹窗 */}
      {showDownloadModal && previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => { setShowDownloadModal(false); setPreviewUrl(""); }}
        >
          <div className="relative mx-auto w-full max-w-sm flex flex-col items-center" onClick={e => e.stopPropagation()}>
            <span className="text-center text-white/80 text-base font-medium mb-2 block">长按图片保存到相册</span>
            <img src={previewUrl} alt="大礼物截图" className="max-w-full max-h-[70vh] rounded-lg shadow-2xl" />
            <button
              onClick={() => { setShowDownloadModal(false); setPreviewUrl(""); }}
              className="mt-3 modal-action-btn modal-action-light"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}