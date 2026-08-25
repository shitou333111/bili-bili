"use client";

/**
 * 礼物录屏模块（主播 → 大礼物 页面上方的新增区块）
 *
 * 功能：
 * 1. 拉取 7 天内全部直播场次（GetHistoryLiveStreamRecordListNew），多选下拉（默认全选）
 * 2. 按场次拉取礼物（GetLiveRecordInfos 翻页），仅保留 gift_value ≥ 筛选档位 的礼物
 * 3. 电池数下拉（≥2000/≥10000/≥30000）、粉丝下拉筛选，礼物按粉丝着色
 * 4. 多选礼物后点击“生成录屏”：切割 2s 短视频，把所有选中片段按日期时间先后拼接成一个视频
 *    （合并 m3u8 + hls 顺序播放）；通过 720×1280 canvas 把礼物特效（rgbFrame/aFrame 裁剪+透明）
 *    叠加在直播画面之上；点击播放/暂停、循环播放；可一键保存视频到相册/下载
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Hls from "hls.js";
import { dataFetch } from "@/lib/client-fetch";
import { getPlatform } from "@/lib/platform";
import { ensureGiftCatalogLoaded, getGiftList } from "@/lib/gift-catalog-client";
import { fetchGiftEffects } from "@/lib/gift-effects-client";
import { saveVideoFile, saveVideoFileFromPath, isTauriMobile } from "@/lib/save-image";
import { open, remove, type FileHandle } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { showToast } from "@/lib/toast";
import Dropdown from "@/components/Dropdown";

// ==================== 常量 ====================

const FAN_COLORS = [
  "#FFE0B2", "#BBDEFB", "#C8E6C9", "#F8BBD9", "#D1C4E9",
  "#B2EBF2", "#FFECB3", "#D7CCC8", "#DCEDC8", "#B3E5FC",
  "#FFCCBC", "#CFD8DC", "#F0F4C3", "#E1BEE7", "#B2DFDB",
];

const PRICE_OPTIONS = [
  { value: 30000, label: "≥30000电池" },
  { value: 10000, label: "≥10000电池" },
  { value: 2000, label: "≥2000电池" },
] as const;

const BEFORE_SECONDS = 2; // 礼物时刻前 2s
const AFTER_SECONDS = 12; // 礼物时刻后 12s
// 礼物实际送出的时刻比记录时间晚约 1s（网络/上屏延迟），用于在录播时间线上后移礼物出现位置以对齐内容
const GIFT_DELAY_SECONDS = 1;
const SEG_SECONDS = 2; // 每段 2s
function safeStartPos(el?: HTMLVideoElement | null, fallback = 0): number {
  try {
    if (!el || !el.buffered || el.buffered.length === 0) return fallback;
    const s = el.buffered.start(0);
    return Number.isFinite(s) && s >= 0 ? Math.max(fallback, s) : fallback;
  } catch {
    return fallback;
  }
}
const CANVAS_W = 720; // 画布固定 720×1280
const CANVAS_H = 1280;
// 竖屏判定阈值（与模拟器一致）：高/宽 > 1.2 视为竖屏，铺满整个画布
const PORTRAIT_RATIO = 1.2;

function fanColorFromNick(nickname: string): string {
  let h = 0;
  const s = nickname;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return FAN_COLORS[Math.abs(h) % FAN_COLORS.length];
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ==================== 类型定义 ====================

type ReplaySession = {
  start_time: number;
  end_time: number;
  title: string;
  live_id: string;
  duration: number;
  area: string;
};

type GiftGroup = {
  key: string;
  session: ReplaySession;
  nickname: string;
  giftName: string;
  giftValue: number;
  count: number;
  times: number[];
  icon: string;
  fanColor: string;
  /** 送礼用户 UID（用于获取头像；部分接口无该字段时为 undefined） */
  uid?: number;
  /** 每次送礼时刻 → 该次数目（横幅显示用，key 为秒级时间戳） */
  timeCounts?: Record<number, number>;
};

type EffectConfig = {
  info?: {
    aFrame?: [number, number, number, number];
    rgbFrame?: [number, number, number, number];
    videoW?: number;
    videoH?: number;
    w?: number;
    h?: number;
    scale?: number;
  };
};

type ClipData = {
  id: string;
  group: GiftGroup;
  playlist: string;
  giftTime: number;
  /** 该次送礼的礼物数目（横幅显示，礼物数目为 1 时不显示"x数目"） */
  count: number;
  effectVideoUrl: string;
  effectConfig: EffectConfig | null;
  /** 是否播放礼物动画：同一礼物 10s 内连续赠送时，仅第一次播放动画 */
  showFx: boolean;
  /** 10 段 2s 片段的 Blob URL；由父级在 clip 移除（关闭/替换）时统一吊销，播放器不在 effect cleanup 中吊销 */
  blobUrls?: string[];
  error?: string;
};

/** B站 GetLiveRecordInfos 单条礼物记录（gifts 接口返回原始字段） */
type RawGiftRecord = {
  nickname?: string;
  gift_name?: string;
  send_gift_time?: number;
  gift_count?: number;
  gift_value?: number;
  gift_icon?: string;
  /** 送礼用户 UID（部分接口返回，用于获取横幅头像） */
  uid?: number;
};

// ==================== 场次多选下拉 ====================

function SessionsSelect({
  sessions,
  selected,
  onToggle,
  onSelectAll,
  visible,
  onToggleOpen,
  containerRef,
  loading,
  counts,
}: {
  sessions: ReplaySession[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  visible: boolean;
  onToggleOpen: () => void;
  containerRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  counts: Record<string, number>;
}) {
  const label =
    loading ? "场次加载中..."
    : sessions.length === 0 ? "无直播场次"
    : selected.size === sessions.length ? `全部场次(${sessions.length})`
    : `已选${selected.size}场`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-black/65 outline-none flex items-center gap-1"
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <svg className="w-3 h-3 flex-shrink-0 text-black/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {visible && (
        <div className="fixed z-[60] max-h-[300px] overflow-y-auto rounded-lg border border-black/10 bg-white shadow-xl min-w-[170px] p-1" style={{ top: -9999, left: -9999 }}>
          { /* 运行时通过 transform 定位，见 useEffect 修正 */}
          <div className="flex items-center justify-between px-2 py-1 border-b border-black/10 mb-1">
            <span className="text-xs text-black/45">直播场次</span>
            <button
              type="button"
              onClick={onSelectAll}
              className="text-xs text-blue-500 font-medium"
            >
              {selected.size === sessions.length ? "全不选" : "全选"}
            </button>
          </div>
          {sessions.map((s) => {
            const checked = selected.has(s.live_id);
            const cnt = counts[s.live_id] ?? 0;
            return (
              <label
                key={s.live_id}
                className="flex items-center gap-2 px-2 py-1.5 hover:bg-black/5 rounded cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(s.live_id)}
                  className="accent-[#1f1c17] w-3.5 h-3.5"
                />
                <span className="text-xs text-black/75 truncate">{fmtTime(s.start_time)}</span>
                {cnt > 0 && (
                  <span className="ml-auto flex-shrink-0 min-w-[18px] px-1.5 py-0.5 rounded-full bg-[#1f1c17] text-white text-[10px] text-center leading-none">
                    {cnt}
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ==================== 特效合成（参考模拟器 AlphaVideoPlayer） ====================

// 复用画布，避免每帧 new canvas
let fxWorkCanvas: HTMLCanvasElement | null = null;
let fxAlphaCanvas: HTMLCanvasElement | null = null;

/**
 * 把礼物特效按 JSON 配置裁剪有效区域（rgbFrame）并应用 alpha 通道（aFrame）后，
 * 绘制到目标画布。逻辑完全参考模拟器 AlphaVideoPlayer：
 *  - outW/outH = round(w*scale)（特效原尺寸）
 *  - 先取 rgbFrame 区域画到 work 画布，再取 aFrame 区域采样 R 通道写入 work 的 alpha
 *  - 最后按"宽度铺满、高度封顶"（同模拟器 w-full + max-height）定位到目标区域
 */
function drawEffect(
  ctx: CanvasRenderingContext2D,
  fx: HTMLVideoElement,
  config: EffectConfig | null,
  destW: number,
  destH: number,
) {
  if (!fx.videoWidth || !fx.videoHeight) return;
  const info = config?.info;
  if (!info) {
    // 无配置：整段绘制
    ctx.drawImage(fx, 0, 0, destW, destH);
    return;
  }
  const [rx, ry, rw, rh] = info.rgbFrame ?? [0, 0, fx.videoWidth, fx.videoHeight];
  const [ax, ay, aw, ah] = info.aFrame ?? [0, 0, fx.videoWidth, fx.videoHeight];
  const outW = Math.max(1, Math.round((info.w ?? fx.videoWidth) * (info.scale || 1)));
  const outH = Math.max(1, Math.round((info.h ?? fx.videoHeight) * (info.scale || 1)));

  if (!fxWorkCanvas) fxWorkCanvas = document.createElement("canvas");
  const work = fxWorkCanvas;
  work.width = outW;
  work.height = outH;
  const wctx = work.getContext("2d");
  if (!wctx) return;

  // 1. 绘制 RGB 帧（裁剪有效区域）
  wctx.clearRect(0, 0, outW, outH);
  wctx.drawImage(fx, rx, ry, rw, rh, 0, 0, outW, outH);

  // 2. 应用 alpha 通道
  try {
    if (!fxAlphaCanvas) fxAlphaCanvas = document.createElement("canvas");
    const alphaCanvas = fxAlphaCanvas;
    alphaCanvas.width = aw;
    alphaCanvas.height = ah;
    const aCtx = alphaCanvas.getContext("2d");
    if (aCtx) {
      aCtx.drawImage(fx, ax, ay, aw, ah, 0, 0, aw, ah);
      const alphaData = aCtx.getImageData(0, 0, aw, ah);
      const frameData = wctx.getImageData(0, 0, outW, outH);
      for (let y = 0; y < outH; y++) {
        for (let x = 0; x < outW; x++) {
          const srcX = Math.floor((x / outW) * aw);
          const srcY = Math.floor((y / outH) * ah);
          const srcIdx = (srcY * aw + srcX) * 4;
          const dstIdx = (y * outW + x) * 4;
          frameData.data[dstIdx + 3] = alphaData.data[srcIdx]; // 取 R 通道作 alpha
        }
      }
      wctx.putImageData(frameData, 0, 0);
    }
  } catch {
    // 跨域等问题导致无法读取像素，保持 RGB 绘制
  }

  // 3. 定位：宽度铺满、高度按比例（超过画布高度则封顶），水平垂直居中
  const scale = destW / outW;
  const effW = destW;
  let effH = outH * scale;
  if (effH > destH) effH = destH;
  const x = (destW - effW) / 2;
  const y = (destH - effH) / 2;
  ctx.drawImage(work, x, y, effW, effH);
}

/** 从 clip 的播放列表文本提取片段 URL（Tauri 为 blob:，Web 为 http(s):），兼容两种模式 */
function extractSegments(playlist: string): string[] {
  const out: string[] = [];
  for (const line of playlist.split(/\r?\n/)) {
    const t = line.trim();
    if (t && /^(blob:|https?:)/i.test(t)) out.push(t);
  }
  return out;
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtFileTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ==================== 合并播放器（多段按时间拼接成一个视频） ====================

/**
 * 把所有选中的礼物片段按日期时间先后拼接为"一个"视频顺序播放：
 *  - 各 clip 的 2s 片段 URL 汇总成一条合并 m3u8（片段间加 EXT-X-DISCONTINUITY 处理时间戳跳变）
 *  - hls 一次性顺序播放，用当前播放时间定位所属 clip，叠加对应礼物的特效
 *  - 画布固定 720×1280；竖屏视频铺满画布，横屏宽度铺满、高度等比缩放（参考模拟器）
 *  - 点击播放/暂停，播到结尾自动从头循环
 *  - 下方"保存视频"按钮：MediaRecorder 录制 canvas 流 → 保存到相册/下载
 */

/** 一个 run：真实时间上连续、不重叠、无重复视频的片段组合 */
type RunPlan = {
  segStart: number;
  segEnd: number;
  runStartReal: number;
  /** 该 run 内 clip 下标（按礼物时刻升序） */
  clipIdx: number[];
};

type MergedPlan = {
  playlist: string;
  totalSeg: number;
  runs: RunPlan[];
  /** 每个 clip（对应 sorted 下标）的礼物在合并视频中的绝对位置（秒） */
  giftPosAbs: number[];
};

/**
 * 把所有 clip 按礼物时刻排序后，把"时间窗口 [giftTime-5, giftTime+15] 重叠"的片段
 * 合并成连续 run，实现"无缝无重叠拼接"：
 *  - 每个 clip 的 2s 片段按近似真实时间 giftTime-5+2*j 定位
 *  - run 内按真实时间排序，只保留尚未覆盖的片段（最早的 clip 覆盖共享时段，
 *    后续 clip 只贡献超出覆盖范围的尾部），避免重复播放相同的一段
 *  - 不同 run 之间用 EXT-X-DISCONTINUITY 分隔（不同场次/时间戳跳变）
 *  - 顺带计算每个 clip 的礼物在合并视频中的绝对秒位置（用于动画叠加与排队）
 */
function buildMergedPlan(sorted: ClipData[]): MergedPlan {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:2",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  const runs: RunPlan[] = [];
  const giftPosAbs: number[] = [];
  let totalSeg = 0;
  let runStartReal = 0;
  let runEndReal = 0;
  let runClipIdx: number[] = [];
  let runSegs: { url: string; real: number }[] = [];
  let segCursor = 0;

  const flushRun = () => {
    if (runSegs.length === 0) return;
    runSegs.sort((a, b) => a.real - b.real);
    const kept: string[] = [];
    let coveredUntil = -Infinity;
    for (const s of runSegs) {
      // 仅保留未覆盖（或仅超出覆盖边缘，避免出现空洞）的片段
      if (s.real >= coveredUntil - 1.0) {
        kept.push(s.url);
        coveredUntil = Math.max(coveredUntil, s.real + SEG_SECONDS);
      }
    }
    const run: RunPlan = { segStart: segCursor, segEnd: segCursor + kept.length, runStartReal, clipIdx: runClipIdx };
    runs.push(run);
    if (runs.length > 1) lines.push("#EXT-X-DISCONTINUITY");
    for (const u of kept) {
      lines.push("#EXTINF:2.00,");
      lines.push(u);
    }
    segCursor += kept.length;
    totalSeg += kept.length;
    for (const ci of runClipIdx) {
      giftPosAbs[ci] = run.segStart * SEG_SECONDS + (sorted[ci].giftTime + GIFT_DELAY_SECONDS - runStartReal);
    }
    runSegs = [];
    runClipIdx = [];
  };

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const segs = extractSegments(c.playlist);
    if (segs.length === 0) continue;
    const cStart = c.giftTime - BEFORE_SECONDS;
    const cEnd = c.giftTime + AFTER_SECONDS;
    if (runSegs.length === 0) {
      runStartReal = cStart;
      runEndReal = cEnd;
    } else if (cStart <= runEndReal) {
      runEndReal = Math.max(runEndReal, cEnd);
    } else {
      flushRun();
      runStartReal = cStart;
      runEndReal = cEnd;
    }
    runClipIdx.push(i);
    segs.forEach((url, j) => runSegs.push({ url, real: c.giftTime - BEFORE_SECONDS + j * SEG_SECONDS }));
  }
  flushRun();

  lines.push("#EXT-X-ENDLIST");
  lines.push("");
  return { playlist: lines.join("\n"), totalSeg, runs, giftPosAbs };
}

/** 画布圆角矩形路径 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// ==================== 送礼横幅绘制（画布版，参照模拟器 ComboNotification） ====================

// 连击数字 / x SVG 缓存（本地 public/combo/*.svg）
const comboImgCache = new Map<string, HTMLImageElement | null>();
function getComboImg(name: string): HTMLImageElement | null {
  let img = comboImgCache.get(name);
  if (img === undefined) {
    const el = new Image();
    el.src = `/combo/combo-${name}.svg`;
    comboImgCache.set(name, el);
    img = el;
  }
  return img && img.naturalWidth > 0 ? img : null;
}

// 礼物图标缓存（crossOrigin 保持画布干净，可录制进视频）
const bannerGiftIconCache = new Map<string, HTMLImageElement | null>();
function getBannerGiftIcon(url: string): HTMLImageElement | null {
  if (!url) return null;
  const norm = url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
  let img = bannerGiftIconCache.get(norm);
  if (img === undefined) {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.src = norm;
    bannerGiftIconCache.set(norm, el);
    img = el;
  }
  return img && img.naturalWidth > 0 ? img : null;
}

/** 右侧斜切的长条路径（模拟器 ComboNotification 斜角背景） */
function slantedStripPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, slant: number) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w - slant, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
}

/** 圆形占位头像（粉→紫渐变 + 昵称首字）。B站礼物记录无送礼用户头像，用昵称首字占位 */
function drawAvatarPlaceholder(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, nick: string) {
  const grad = ctx.createLinearGradient(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2);
  grad.addColorStop(0, "#f472b6");
  grad.addColorStop(1, "#a855f7");
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.stroke();
  if (nick) {
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.round(size * 0.44)}px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
    ctx.fillText(nick.charAt(0), cx, cy + size * 0.02);
  }
}

/** 数字拆位（参照模拟器 getNumberDigits） */
function splitDigits(n: number): string[] {
  return String(n).split("");
}

/** 超出最大宽度时加省略号截断 */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}

/** 送礼横幅用户头像缓存：昵称 -> 已加载 img（null 表示已确认无头像）；未请求过 = undefined */
const bannerFaceCache = new Map<string, HTMLImageElement | null>();

/** 按送礼者昵称取头像（礼物流水只有昵称，贡献榜按昵称返回 face） */
function getBannerFace(nick?: string): HTMLImageElement | null | undefined {
  if (!nick) return null;
  return bannerFaceCache.get(nick);
}

function setBannerFace(nick: string, url: string) {
  if (!nick || !url) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    bannerFaceCache.set(nick, img);
  };
  img.onerror = () => {
    bannerFaceCache.set(nick, null);
  };
  img.src = url.replace(/^\/\//, "https://").replace(/^http:/, "https:");
}

/**
 * 顶部送礼横幅（参照模拟器 ComboNotification 样式）：
 * 斜角渐变长条背景 + 圆形头像 + 昵称/投喂/礼物名(黄) + 礼物图标(弹跳) + x + 连击数字 SVG。
 * t 为相对送礼时刻的秒数（0 = 送礼瞬间）：送礼前 1s 渐显、送礼后 5s 渐隐；
 * 距画布顶部 10% 高度，水平居中。
 */
function drawComboBanner(ctx: CanvasRenderingContext2D, c: ClipData, t: number) {
  if (t < -1 || t > 5) return;
  const bannerH = 56;
  const y = CANVAS_H * 0.1;

  // 渐显 [-1,0] / 渐隐 [4,5]
  let offY = 0;
  let alpha = 1;
  if (t < 0) {
    const p = t + 1;
    offY = (1 - p) * bannerH * 1.5;
    alpha = p;
  } else if (t > 4) {
    const p = t - 4;
    offY = -p * bannerH * 1.6;
    alpha = 1 - p;
  }
  const by = y + offY;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  // ---- 单行内容，横幅宽度随元素自适应 ----
  const FONT = "system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  const padding = 16; // 左右内边距
  const avatarSize = 44;
  const gapAfterAvatar = 12; // 头像与文字间距
  const textGap = 10; // 昵称/投喂/礼物名 间距
  const gapBeforeCluster = 16; // 文本与右侧图标簇间距

  // 文本宽度（昵称黄 / 投喂白 / 礼物名白，单行）
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `600 20px ${FONT}`;
  const nickT = truncateText(ctx, c.group.nickname, 160);
  const nickW = ctx.measureText(nickT).width;
  ctx.font = `500 18px ${FONT}`;
  const feedT = "投喂";
  const feedW = ctx.measureText(feedT).width;
  const giftT = truncateText(ctx, c.group.giftName, 140);
  const giftW = ctx.measureText(giftT).width;

  // 右侧图标簇宽度（礼物图标 + x + 连击数字）
  const giftSize = 48;
  const xH = 22;
  const digitH = 34;
  const digits = splitDigits(c.count || 1);
  const xImg = getComboImg("x");
  let digitsW = 0;
  for (const d of digits) {
    const img = getComboImg(d);
    if (img) digitsW += digitH * ((img.naturalWidth / img.naturalHeight) || 0.9) + 2;
    else digitsW += 34;
  }
  const xW = xImg ? xH * ((xImg.naturalWidth / xImg.naturalHeight) || 1) : 0;
  const clusterW = giftSize + 8 + (xImg ? xW + 6 : 0) + digitsW;

  const contentW =
    avatarSize + gapAfterAvatar + nickW + textGap + feedW + textGap + giftW + gapBeforeCluster + clusterW;
  const bannerW = contentW + padding * 2;
  const bannerX = (CANVAS_W - bannerW) / 2;

  // 斜角渐变长条背景（样式同模拟器 ComboNotification，宽度自适应）
  const grad = ctx.createLinearGradient(bannerX, by, bannerX + bannerW, by + bannerH);
  grad.addColorStop(0, "rgba(60,90,160,0.5)");
  grad.addColorStop(1, "rgba(90,60,140,0.5)");
  slantedStripPath(ctx, bannerX, by, bannerW, bannerH, 28);
  ctx.fillStyle = grad;
  ctx.fill();

  // 头像：优先真实头像（通过送礼者昵称从 UserScoreRank 排行匹配 face），否则昵称首字占位
  const avatarX = bannerX + padding;
  const avatarCY = by + bannerH / 2;
  const face = getBannerFace(c.group.nickname);
  if (face && face.naturalWidth > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarCY, avatarSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(face, avatarX, avatarCY - avatarSize / 2, avatarSize, avatarSize);
    ctx.restore();
  } else {
    drawAvatarPlaceholder(ctx, avatarX + avatarSize / 2, avatarCY, avatarSize, c.group.nickname);
  }

  // 占位头像绘制会把 textAlign 改成 center，绘制文本前必须重置为左对齐，
  // 否则昵称/投喂/礼物名会以各自坐标为中心绘制，导致元素互相重叠
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // 单行文本：昵称(黄) + "投喂"(白) + 礼物名(白)
  const textX = avatarX + avatarSize + gapAfterAvatar;
  const midY = by + bannerH / 2;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillStyle = "#ffd54f";
  ctx.fillText(nickT, textX, midY);
  let cx = textX + nickW + textGap;
  ctx.font = `500 18px ${FONT}`;
  ctx.fillStyle = "#fff";
  ctx.fillText(feedT, cx, midY);
  cx += feedW + textGap;
  ctx.fillText(giftT, cx, midY);

  // 右侧图标簇：礼物图标(弹跳) + x + 连击数字，从文本后接续
  const giftX = textX + nickW + textGap + feedW + textGap + giftW + gapBeforeCluster;
  const giftCY = by + bannerH / 2;
  const bounce = t < 0.3 ? -8 * Math.sin(Math.PI * (t / 0.3)) : 0;
  const icon = getBannerGiftIcon(c.group.icon);
  if (icon) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 8;
    ctx.drawImage(icon, giftX, giftCY - giftSize / 2 + bounce, giftSize, giftSize);
    ctx.restore();
  } else {
    // 图标未加载：画圆形占位
    ctx.beginPath();
    ctx.arc(giftX + giftSize / 2, giftCY + bounce, giftSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fill();
  }

  // x + 连击数字 SVG（参照模拟器 DigitImage）
  let digitX = giftX + giftSize + 8;
  if (xImg) {
    ctx.drawImage(xImg, digitX, by + bannerH / 2 - xH / 2 + 3, xW, xH);
    digitX += xW + 6;
  }
  for (const d of digits) {
    const img = getComboImg(d);
    if (img) {
      const dw = digitH * ((img.naturalWidth / img.naturalHeight) || 0.9);
      ctx.drawImage(img, digitX, by + bannerH / 2 - digitH / 2, dw, digitH);
      digitX += dw + 2;
    } else {
      ctx.fillStyle = "#fff";
      ctx.font = "700 34px system-ui";
      ctx.fillText(d, digitX, by + bannerH / 2);
      digitX += 34;
    }
  }

  ctx.restore();
}

function MergedPlayer({
  clips,
  onClose,
  backgroundUrl = "",
  anchorName = "",
  anchorFace = "",
}: {
  clips: ClipData[];
  onClose: () => void;
  /** 直播间背景图 URL（可选，无则纯黑底），放在画布最底层 cover 绘制 */
  backgroundUrl?: string;
  anchorName?: string;
  anchorFace?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLVideoElement>(null);
  const fxRefs = useRef<Array<HTMLVideoElement | null>>([]);
  const hlsRef = useRef<Hls | null>(null);
  // 最近一次有效播放位置（重建播放器时恢复用）
  const lastPosRef = useRef(0);
  // 强恢复函数：销毁并重建 hls（由 effect 内注册，供点击/看门狗调用）
  const rebuildHlsRef = useRef<(() => void) | null>(null);
  // 是否检测到停滞/加载失败（startLoad 无法恢复时，点击/看门狗应重建 hls）
  const needsRecoveryRef = useRef(false);
  // 最近一次检测到的停滞位置（重建后若恢复到该"死区"则向前跳过，避免反复重建）
  const stallPosRef = useRef(-1);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // drawLoop 位于 useEffect([]) 闭包内读不到最新的 saving，用 ref 同步供绘制时判断
  const savingRef = useRef(false);
  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);
  const readyRef = useRef(false);

  // 按礼物时刻先后排序
  const sorted = useMemo(() => [...clips].sort((a, b) => a.giftTime - b.giftTime), [clips]);

  // 合并播放计划：重叠片段合并为连续 run，不重复播放相同片段
  const plan = useMemo(() => buildMergedPlan(sorted), [sorted]);

  const totalSec = plan.totalSeg * SEG_SECONDS;

  // 直播间背景图：crossOrigin 保持画布干净（否则 getImageData / captureStream 会被污染阻止）
  const bgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!backgroundUrl) {
      bgRef.current = null;
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgRef.current = img;
    };
    img.onerror = () => {
      bgRef.current = null;
    };
    img.src = backgroundUrl;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [backgroundUrl]);

  // 画布内绘制用的头像 / 礼物图标（crossOrigin 保持画布干净，录制视频时一起被录进去）
  const faceRef = useRef<HTMLImageElement | null>(null);
  const giftIconRef = useRef<HTMLImageElement | null>(null);
  // 底部/顶部 chrome 预渲染离屏画布：每帧只贴同一位图，杜绝该区域逐帧像素波动
  // （半透明圆+图标逐帧重绘/动图）导致编码器把它当动态区域、视频体积暴涨。
  const chromeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chromeVersionRef = useRef(0);
  const chromeRenderedVersionRef = useRef(-1);
  const bumpChrome = () => {
    chromeVersionRef.current++;
  };
  useEffect(() => {
    const faceImg = new Image();
    if (anchorFace) {
      faceImg.crossOrigin = "anonymous";
      faceImg.onload = () => {
        faceRef.current = faceImg;
        bumpChrome();
      };
      faceImg.src = anchorFace;
    }
    const giftImg = new Image();
    giftImg.crossOrigin = "anonymous";
    giftImg.onload = () => {
      // 礼物图标按钮保持静态：不再把动图 webp 挂到 DOM 让它逐帧播放，
      // 否则画布（与被录制的视频）里该区域每帧都不同，导致视频体积明显变大。
      giftIconRef.current = giftImg;
      bumpChrome();
    };
    giftImg.src = "/gift-icon.webp";
    return () => {
      faceImg.onload = null;
      giftImg.onload = null;
    };
  }, [anchorFace]);

  // 常用礼物按钮图标（人气票，本地静态 png）
  const renqipiaoRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = new Image();
    img.src = "/renqipiao.png";
    img.onload = () => {
      renqipiaoRef.current = img;
      bumpChrome();
    };
    return () => {
      img.onload = null;
    };
  }, []);

  /**
   * 把"主播头像+昵称"（左上）和"底部评论栏"直接绘制进画布（最上层），
   * 这样保存视频时也会被一并录制（与 DOM 覆盖层不同）。
   * 样式照搬模拟器：badge 底色 rgba(119,108,112,0.5)、渐变圆形头像、评论栏同底色。
   */
  const drawChrome = (
    ctx: CanvasRenderingContext2D,
    faceImg: HTMLImageElement | null,
    giftImg: HTMLImageElement | null,
    renqipiaoImg: HTMLImageElement | null,
  ) => {
    // ---- 左上角主播胶囊 badge（距顶部距离约为默认的 2 倍） ----
    const bx = 16;
    const by = 44;
    const bh = 52;
    const avatarSize = 44;
    const name = anchorName || "主播昵称";
    ctx.font = "500 20px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    const tw = ctx.measureText(name).width;
    const badgeW = 20 + avatarSize + 10 + tw + 18;
    roundRectPath(ctx, bx, by, badgeW, bh, bh / 2);
    ctx.fillStyle = "rgba(119, 108, 112, 0.5)";
    ctx.fill();

    // 渐变圆形头像（粉→紫）
    const grad = ctx.createLinearGradient(bx + 4, by + 4, bx + 4 + avatarSize, by + 4 + avatarSize);
    grad.addColorStop(0, "#f472b6");
    grad.addColorStop(1, "#a855f7");
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx + 4 + avatarSize / 2, by + bh / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.clip();
    if (faceImg && faceImg.naturalWidth > 0) {
      ctx.drawImage(faceImg, bx + 4, by + (bh - avatarSize) / 2, avatarSize, avatarSize);
    } else {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.round(avatarSize * 0.5)}px system-ui`;
      ctx.fillStyle = "#fff";
      ctx.fillText("📺", bx + 4 + avatarSize / 2, by + bh / 2);
    }
    ctx.restore();

    // 昵称
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "500 20px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(name, bx + 4 + avatarSize + 10, by + bh / 2);

    // ---- 底部评论栏（比默认稍上移）：弹幕输入框 + 送礼按钮，底色同 badge ----
    // 评论栏整体更扁（高度减小）、文字更大，同行元素保持同一高度
    const barBottom = 24;
    const inputH = 56;
    const inputY = CANVAS_H - barBottom - inputH;
    const giftSize = 56;
    const gx = CANVAS_W - 20 - giftSize;
    const gy = CANVAS_H - barBottom - giftSize;
    const inputX = 20;
    // 输入框右侧为"常用礼物"按钮让位（同模拟器：输入框 → 人气票按钮 → 礼物按钮）
    // 常用礼物按钮尺寸/底色完全照礼物按钮复刻
    const qgSize = giftSize;
    const qGap = 10;
    const qgx = gx - qGap - qgSize;
    const qgy = gy;
    const inputW = qgx - 12 - inputX;
    roundRectPath(ctx, inputX, inputY, inputW, inputH, inputH / 2);
    ctx.fillStyle = "rgba(119, 108, 112, 0.5)";
    ctx.fill();

    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = "22px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillText("弹幕支持下～", inputX + 26, inputY + inputH / 2);

    // 输入框右侧笑脸
    const smSize = 40;
    const smX = inputX + inputW - smSize - 22;
    const smY = inputY + (inputH - smSize) / 2;
    ctx.fillStyle = "#FFD700";
    ctx.beginPath();
    ctx.arc(smX + smSize / 2, smY + smSize / 2, smSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(smX + smSize * 0.34, smY + smSize * 0.42, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(smX + smSize * 0.66, smY + smSize * 0.42, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(smX + smSize / 2, smY + smSize * 0.55, smSize * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 3;
    ctx.stroke();

    // 常用礼物按钮（复刻模拟器"人气票"：圆形底色 + 人气票图标，位于输入框与礼物按钮之间）
    ctx.beginPath();
    ctx.arc(qgx + qgSize / 2, qgy + qgSize / 2, qgSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(119, 108, 112, 0.5)";
    ctx.fill();
    if (renqipiaoImg && renqipiaoImg.naturalWidth > 0) {
      // 人气票图标内容偏满，缩小使其完整落在 badge 内（并裁剪进圆形，避免溢出）
      const ri = qgSize * 0.72;
      ctx.save();
      ctx.beginPath();
      ctx.arc(qgx + qgSize / 2, qgy + qgSize / 2, qgSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(renqipiaoImg, qgx + (qgSize - ri) / 2, qgy + (qgSize - ri) / 2, ri, ri);
      ctx.restore();
    }

    // 礼物按钮
    ctx.beginPath();
    ctx.arc(gx + giftSize / 2, gy + giftSize / 2, giftSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(119, 108, 112, 0.5)";
    ctx.fill();
    if (giftImg && giftImg.naturalWidth > 0) {
      // 礼物图标放大以填满 badge（再裁剪进圆形，缩放后四角不溢出于圆形外）
      const gi = giftSize * 1.2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(gx + giftSize / 2, gy + giftSize / 2, giftSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(giftImg, gx + (giftSize - gi) / 2, gy + (giftSize - gi) / 2, gi, gi);
      ctx.restore();
    }
  };

  useEffect(() => {
    let disposed = false;
    let raf = 0;

    const live = liveRef.current;
    if (!live) return;

    // 特效 video 数组：挂载后由 JSX ref 填充，组件生命周期内引用稳定
    const fxArr = fxRefs.current;

    const logEvt = (name: string, extra?: unknown) => {
      console.log(`[GiftReplay][hls] ${name}`, extra ?? "");
    };

    // 合并播放列表 blob（仅本 effect 创建，cleanup 时吊销；片段 URL 由父级统一管理）
    const revocable: string[] = [];
    const blob = new Blob([plan.playlist], { type: "application/vnd.apple.mpegurl" });
    const blobUrl = URL.createObjectURL(blob);
    revocable.push(blobUrl);

    const timeoutId = window.setTimeout(() => {
      if (disposed || readyRef.current) return;
      console.warn("[GiftReplay][hls] 8s 内未就绪，m3u8:\n" + plan.playlist);
      setError("视频初始化超时，请查看控制台日志");
    }, 8000);

    // 循环播放：播到结尾自动从头开始（hls 播完进入 STOPPED 时需先 startLoad 才能重启）
    const handleEnded = () => {
      if (disposed) return;
      try { live.currentTime = 0; } catch { /* ignore */ }
      try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
      // ended 后 hls 需先重填起点缓冲，立即 play 可能因 buffer 未就绪失败；延迟再试一次兜底
      const tryPlay = () => {
        if (disposed) return;
        if (live.paused) live.play().then(() => setPlaying(true)).catch(() => {});
      };
      tryPlay();
      window.setTimeout(tryPlay, 300);
    };

    if (Hls.isSupported()) {
      // 可重复调用的 hls 构建：初次创建与"停滞/失败后强恢复（重建）"共用。
      // 重建能恢复 startLoad 无法处理的不可恢复停滞（跨 run/场次编码参数不符、buffer 卡死等）。
      const fatalRecoveredRef = { current: false };
      const createHls = () => {
        if (disposed) return;
        try { hlsRef.current?.destroy(); } catch { /* ignore */ }
        hlsRef.current = null;
        const hls = new Hls({ debug: true });
        hlsRef.current = hls;
        hls.on(Hls.Events.MEDIA_ATTACHED, () => logEvt("MEDIA_ATTACHED"));
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          logEvt("MANIFEST_PARSED");
          if (disposed) return;
          fatalRecoveredRef.current = false;
          needsRecoveryRef.current = false;
          readyRef.current = true;
          setReady(true);
          // 重建后恢复到上次有效位置（结尾附近则从头开始）；
          // 若上次位置正是停滞"死区"（片段/时间戳跳变导致无法续播），则向前跳过约 2 段避免再次卡死
          const pos = lastPosRef.current;
          const dur = live.duration;
          let resume = -1;
          if (pos > 0 && Number.isFinite(dur) && pos < dur - 0.5) {
            if (stallPosRef.current >= 0 && Math.abs(pos - stallPosRef.current) < 1.5) {
              const skip = pos + 4; // 跳过约 2 个 2s 片段
              resume = skip < dur - 0.5 ? skip : 0;
              stallPosRef.current = -1;
              console.warn(`[GiftReplay][hls] 上次位置 ${pos.toFixed(1)} 为死区，跳过至 ${resume}`);
            } else {
              resume = pos;
            }
          } else {
            resume = 0;
          }
          try { live.currentTime = resume; } catch { /* ignore */ }
          live.play().then(() => setPlaying(true)).catch((e) => logEvt("play失败", e));
        });
        hls.on(Hls.Events.FRAG_LOADED, (_e, d) => logEvt("FRAG_LOADED", d.frag?.sn));
        hls.on(Hls.Events.LEVEL_LOADED, (_e, d) => logEvt("LEVEL_LOADED", `${d.details?.fragments?.length ?? 0}段`));
        hls.on(Hls.Events.ERROR, (_e, data) => {
          // bufferSeekOverHole：主动跨 run seek 越过 PTS 空洞时 hls.js 的正常提示，非致命、无需处理
          if (data.details === "bufferSeekOverHole") return;
          console.warn("[GiftReplay][hls] ERROR", data.type, data.details, data.fatal, data.frag?.url ?? "");
          // 缓冲停滞/追加失败（跨场次片段时间戳/编码参数跳变等）→ 强制恢复加载，避免卡死后点击无反应
          if (data.details === "bufferStalledError" || data.details === "bufferAppendError") {
            needsRecoveryRef.current = true;
            try { hls.startLoad(); } catch { /* ignore */ }
            return;
          }
          if (data.fatal) {
            // 致命错误：先重建 hls 一次（能解决多数网络/媒体错误）；重建后仍失败才报错
            if (fatalRecoveredRef.current) {
              readyRef.current = true;
              setReady(true);
              setError(`播放失败: ${data.details}`);
              return;
            }
            fatalRecoveredRef.current = true;
            needsRecoveryRef.current = true;
            console.warn("[GiftReplay][hls] 致命错误，重建播放器");
            // 延迟到下一拍再销毁重建，避免在 hls 事件回调内同步 destroy
            window.setTimeout(() => createHls(), 0);
          }
        });
        hls.loadSource(blobUrl);
        hls.attachMedia(live);
      };
      createHls();
      rebuildHlsRef.current = createHls;
    } else if (live.canPlayType("application/vnd.apple.mpegurl")) {
      const nativeUrl = URL.createObjectURL(new Blob([plan.playlist], { type: "application/vnd.apple.mpegurl" }));
      revocable.push(nativeUrl);
      live.src = nativeUrl;
      live.addEventListener("loadedmetadata", () => {
        if (!disposed) {
          readyRef.current = true;
          setReady(true);
          live.play().then(() => setPlaying(true)).catch(() => {});
        }
      });
    } else {
      setError("当前环境不支持 HLS 播放");
    }

    live.addEventListener("ended", handleEnded);

    // 给某个 clip 的特效 video 设置 src（clip 播放时激活 / 下个 clip 预加载）
    const ensureFxSrc = (idx: number) => {
      const c = sorted[idx];
      const v = fxArr[idx];
      // 无专属动画（总价达阈值但礼物无对应特效）时不设置 src，避免空 URL 触发加载
      if (!c || !v || !c.effectVideoUrl) return;
      if (v.getAttribute("data-src") !== c.effectVideoUrl) {
        v.setAttribute("data-src", c.effectVideoUrl);
        v.src = c.effectVideoUrl;
        v.load();
      }
    };

    let activeIdx = -1;

    // 停滞检测：播放中 currentTime 长时间不动 → 强制恢复 hls 加载，避免卡死后点击无反应
    let watchLastT = -1;
    let watchLastMove = performance.now();
    let watchLastRecover = 0;

    const drawLoop = () => {
      raf = requestAnimationFrame(drawLoop);
      let fadeA = 0; // 跨 run 过渡遮罩 alpha：drawLoop 顶层声明，供下方 seek 计算与最上层遮罩绘制共享
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      if (canvas.width !== CANVAS_W) {
        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
      }
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

      // 把一帧按定位规则画到主画布：竖屏铺满、横屏长宽等比并居中偏上
      const drawFrame = (src: CanvasImageSource, vw: number, vh: number, topOffset: number) => {
        const lr = vw / vh;
        const portrait = vh / vw > PORTRAIT_RATIO;
        if (portrait) {
          const cr = CANVAS_W / CANVAS_H;
          let dw = CANVAS_W;
          let dh = CANVAS_H;
          if (lr > cr) dw = CANVAS_H * lr;
          else dh = CANVAS_W / lr;
          ctx.drawImage(src, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh);
        } else {
          const vh2 = CANVAS_W * (vh / vw);
          ctx.drawImage(src, 0, topOffset, CANVAS_W, vh2);
        }
      };

      // 直播间背景图（最底层）：保持原图比例 cover 裁剪，根据画布比例裁掉多出的高或宽
      const bg = bgRef.current;
      if (bg && bg.naturalWidth > 0 && bg.naturalHeight > 0) {
        const bgRatio = bg.naturalWidth / bg.naturalHeight;
        const cRatio = CANVAS_W / CANVAS_H;
        let dw = CANVAS_W;
        let dh = CANVAS_H;
        let dx = 0;
        let dy = 0;
        if (bgRatio > cRatio) {
          // 图更宽：高度铺满，左右裁掉
          dh = CANVAS_H;
          dw = CANVAS_H * bgRatio;
          dx = (CANVAS_W - dw) / 2;
        } else {
          // 图更高：宽度铺满，上下裁掉
          dw = CANVAS_W;
          dh = CANVAS_W / bgRatio;
          dy = (CANVAS_H - dh) / 2;
        }
        ctx.drawImage(bg, dx, dy, dw, dh);
      }

      // 视频未就绪时也照常绘制背景与"主播/评论栏"装饰（保证保存视频时始终有画面框架）
      const videoReady = live.videoWidth > 0 && live.readyState >= 2;

      if (videoReady) {
        if (!live.paused) {
          if (live.currentTime !== watchLastT) {
            watchLastT = live.currentTime;
            watchLastMove = performance.now();
            lastPosRef.current = live.currentTime;
            needsRecoveryRef.current = false; // 时间在前进 → 无需恢复
          } else if (
            performance.now() - watchLastMove > 3000 &&
            performance.now() - watchLastRecover > 6000
          ) {
            watchLastRecover = performance.now();
            // 停滞若恰发生在两个 run(跨场次/跨片段 DISCONTINUITY)交界处，hls.js 常卡在上一 run 最后一帧
            // 且无法自动进入下一个 run。此时 +0.001 的微调仍停留在当前 run，无法越过边界，需直接跳到下一个 run 起点。
            const rb = plan.runs;
            let boundaryNext = -1;
            for (let i = 0; i < rb.length - 1; i++) {
              const runEnd = rb[i].segEnd * SEG_SECONDS;
              if (Math.abs(watchLastT - runEnd) < 0.5) {
                boundaryNext = rb[i + 1].segStart * SEG_SECONDS;
                break;
              }
            }
            if (boundaryNext >= 0) {
              console.warn(`[GiftReplay][hls] run 交界停滞(${watchLastT.toFixed(1)}→${boundaryNext.toFixed(1)})，跳入下一 run`);
              watchLastT = boundaryNext;
              try { live.currentTime = boundaryNext; } catch { /* ignore */ }
              try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
              if (live.paused) live.play().catch(() => {});
            } else if (needsRecoveryRef.current) {
              // 已尝试 startLoad 仍停滞（如跨 run 编码参数不符）→ 重建播放器强恢复
              needsRecoveryRef.current = false;
              console.warn("[GiftReplay][hls] 停滞未恢复，重建播放器");
              rebuildHlsRef.current?.();
            } else {
              needsRecoveryRef.current = true;
              stallPosRef.current = watchLastT; // 记录停滞位置（重建时用于跳过死区）
              console.warn("[GiftReplay][hls] 播放停滞，尝试恢复加载");
              // 先用 startLoad 恢复加载；同时微调 currentTime 触发 seek，迫使 hls 重填当前位置的缓冲缺口
              try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
              try { live.currentTime = watchLastT + 0.001; } catch { /* ignore */ }
              // 若 hls 已 STOPPED（如片段加载失败停止），startLoad 后立即恢复播放
              if (live.paused) live.play().catch(() => {});
            }
          }
        } else {
          watchLastT = live.currentTime;
          watchLastMove = performance.now();
          lastPosRef.current = live.currentTime;
        }

        // 循环修复：在 VOD 名义时长结束前预判回绕，避免 hls 进入 STOPPED/ended 状态导致黑屏停滞。
        // 原因：B站 2s 片段的真实时长常略短于 m3u8 的 #EXTINF 2.00，hls 把 video.duration 设为名义总时长，
        // 而真实媒体提前结束——currentTime 会卡在"真实末尾与名义末尾之间"：既不发 ended 也无法前进，
        // 触发看门狗"播放停滞"且黑屏。故按计划总时长（totalSec）提前 1s 回绕，越过该死区。
        // 片段多为本地 Blob URL（Tauri），回绕不重新请求网络；保留默认缓冲使回绕到起点可直接续播。
        if (!savingRef.current && !live.paused && !live.ended && !needsRecoveryRef.current) {
          const dur = live.duration;
          if (Number.isFinite(dur) && dur > 0 && live.currentTime >= totalSec - 1.0) {
            try { live.currentTime = safeStartPos(live, 0); } catch { /* ignore */ }
            try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
            watchLastT = 0;
            watchLastMove = performance.now();
          }
        }

        // 跨 run 主动切换：最简单拼接。
        // - 不同礼物(相隔>20s)被拆成多个 run，run 间用 EXT-X-DISCONTINUITY 衔接，片段携带源 PTS，
        //   hls.js 在该交接处常卡在上一 run 最后一帧、无法自动续播 → 主动 seek 到下一 run 起点并 startLoad。
        fadeA = 0;
        if (videoReady && !live.paused && !needsRecoveryRef.current) {
          let curRi = -1;
          for (let i = 0; i < plan.runs.length; i++) {
            const rs0 = plan.runs[i].segStart * SEG_SECONDS;
            const rs1 = plan.runs[i].segEnd * SEG_SECONDS;
            if (live.currentTime >= rs0 && live.currentTime < rs1) { curRi = i; break; }
          }
          if (curRi >= 0 && curRi < plan.runs.length - 1) {
            const runEnd = plan.runs[curRi].segEnd * SEG_SECONDS;
            if (live.currentTime >= runEnd - 0.05 && live.currentTime < runEnd + 0.6) {
              const nextStart = plan.runs[curRi + 1].segStart * SEG_SECONDS;
              console.warn(`[GiftReplay][hls] 跨 run 拼接(${live.currentTime.toFixed(1)}→${nextStart.toFixed(1)})`);
              try { live.currentTime = nextStart; } catch { /* ignore */ }
              try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
              watchLastT = nextStart;
              watchLastMove = performance.now();
            }
          }
        }
      }

      // 定位当前所属 run，并在 run 内按"动画排队"规则找出当前应播放动画的 clip。
      // 排队：同一 run 内多个动画按礼物时刻顺序依次播放，后面的等前面的播完再开始。
      const segIndex = Math.floor(live.currentTime / SEG_SECONDS);
      let idx = -1;
      let animStart = 0;
      let curRun = -1;
      // 每个片段的"生效时刻"：有动画=动画排定开始时间(与动画排队一致)，无动画=绝对送礼时间。
      // 送礼横幅窗口以此为基准，保证"横幅显示时间与礼物特效播放时间对齐"。
      const effStart = new Array<number>(sorted.length);
      if (videoReady) {
        for (let r = 0; r < plan.runs.length; r++) {
          if (segIndex >= plan.runs[r].segStart && segIndex < plan.runs[r].segEnd) {
            curRun = r;
            break;
          }
        }
        if (curRun >= 0) {
          const run = plan.runs[curRun];
          // 第一遍：按排队规则预计算 run 内各动画片段的排定开始时间
          let cursor = run.segStart * SEG_SECONDS;
          for (const ci of run.clipIdx) {
            const c = sorted[ci];
            const fxV = fxArr[ci];
            const ed = fxV?.duration && isFinite(fxV.duration) ? Math.min(fxV.duration, 15) : 8;
            if (c.showFx && c.effectVideoUrl) {
              const start = Math.max(plan.giftPosAbs[ci], cursor);
              effStart[ci] = start;
              cursor = start + ed;
            } else {
              effStart[ci] = plan.giftPosAbs[ci];
            }
          }
          // 第二遍：找出当前正在播放的动画
          for (const ci of run.clipIdx) {
            const c = sorted[ci];
            if (!c.showFx || !c.effectVideoUrl) continue; // 不播动画/无特效的片段不占排队位置
            const start = effStart[ci] ?? plan.giftPosAbs[ci];
            const fxV = fxArr[ci];
            const dur = fxV?.duration && isFinite(fxV.duration) ? Math.min(fxV.duration, 15) : 8;
            if (live.currentTime >= start && live.currentTime < start + dur) {
              idx = ci;
              animStart = start;
              break;
            }
          }
        }
      }

      // clip 切换：暂停其余特效 video，预加载当前 run 内全部特效（排队需要）及下一段
      if (idx !== activeIdx) {
        activeIdx = idx;
        for (let i = 0; i < fxArr.length; i++) {
          const v = fxArr[i];
          if (v && i !== idx) {
            try { v.pause(); } catch { /* ignore */ }
          }
        }
        if (curRun >= 0) {
          for (const ci of plan.runs[curRun].clipIdx) ensureFxSrc(ci);
          const lastCi = plan.runs[curRun].clipIdx[plan.runs[curRun].clipIdx.length - 1];
          if (lastCi + 1 < sorted.length) ensureFxSrc(lastCi + 1);
        } else if (idx >= 0) {
          ensureFxSrc(idx);
          if (idx + 1 < sorted.length) ensureFxSrc(idx + 1);
        }
      }

      if (videoReady) {
        // 直播画面定位：竖屏铺满整个画布，横屏宽度填满高度等比（参考模拟器 LiveStreamBackground）
        drawFrame(live, live.videoWidth, live.videoHeight, CANVAS_H * 0.2);
      }

      // 礼物特效叠加：礼物在 animStart 处出现（run 内按排队规则）。
      // showFx=false（同一礼物 10s 内连续赠送的第二次）只播视频不叠动画；
      // 动画时长超过 15s 时只播放前 15s。
      if (idx >= 0) {
        const c = sorted[idx];
        if (c.showFx) {
          const fxV = fxArr[idx];
          if (fxV && c.effectVideoUrl) {
            const t = live.currentTime - animStart;
            const effDur = fxV.duration ? Math.min(fxV.duration, 15) : 15;
            if (t >= 0 && t <= effDur) {
              if (live.paused) {
                // 暂停时冻结特效：不再 play/seek 循环，避免画面闪烁
                if (!fxV.paused) fxV.pause();
                if (fxV.duration && Math.abs(fxV.currentTime - t) > 0.05) {
                  try { fxV.currentTime = t; } catch { /* ignore */ }
                }
              } else {
                if (fxV.readyState >= 2 && fxV.paused) fxV.play().catch(() => {});
                if (fxV.duration && Math.abs(fxV.currentTime - t) > 0.2) {
                  try { fxV.currentTime = t; } catch { /* ignore */ }
                }
              }
              drawEffect(ctx, fxV, c.effectConfig, CANVAS_W, CANVAS_H);
            }
          }
        }
      }

      // ---- 送礼横幅（画进画布，保存视频时一起录制） ----
      // 顶部送礼横幅：所有片段（含无专属动画/重复送礼）在各自送礼时刻前 1s 渐显、后 5s 渐隐。
      // 不依赖动画 idx，故"总价达阈值但无专属动画"的礼物也能正常显示横幅
      if (videoReady && curRun >= 0) {
        const run = plan.runs[curRun];
        let bi = -1;
        let bt = 0;
        const wt = live.currentTime;
        for (const ci of run.clipIdx) {
          // 生效时刻与礼物特效播放时间对齐：有动画用排定开始时间，无动画用绝对送礼时间
          const p = effStart[ci] ?? plan.giftPosAbs[ci];
          if (wt >= p - 1 && wt < p + 5) {
            if (bi < 0 || p > bt) {
              bi = ci;
              bt = p;
            }
          }
        }
        if (bi >= 0) drawComboBanner(ctx, sorted[bi], wt - bt);
      }

      // 最上层：主播头像/昵称 + 底部评论栏（直接画进画布，保存视频时一起录制）
      // 预渲染到离屏画布，每帧贴同一位图：chrome 区域像素逐帧完全一致，
      // 编码器不会把这段当动态区域，从而避免视频体积暴涨。
      if (chromeVersionRef.current !== chromeRenderedVersionRef.current) {
        if (!chromeCanvasRef.current) chromeCanvasRef.current = document.createElement("canvas");
        const cc = chromeCanvasRef.current;
        if (cc.width !== CANVAS_W || cc.height !== CANVAS_H) {
          cc.width = CANVAS_W;
          cc.height = CANVAS_H;
        }
        const cctx = cc.getContext("2d");
        if (cctx) drawChrome(cctx, faceRef.current, giftIconRef.current, renqipiaoRef.current);
        chromeRenderedVersionRef.current = chromeVersionRef.current;
      }
      const chromeBuf = chromeCanvasRef.current;
      if (chromeBuf) ctx.drawImage(chromeBuf, 0, 0);

      // 右上角倒计时：整个拼接视频的剩余时间（分钟:秒），仅播放时显示，不录制进视频
      if (!savingRef.current) {
        const remain = Math.max(0, totalSec - live.currentTime);
        const mm = Math.floor(remain / 60);
        const ss = Math.floor(remain % 60);
        const label = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
        ctx.font = "600 24px system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
        const tw = ctx.measureText(label).width;
        const padX = 14;
        const bx = CANVAS_W - 20 - tw - padX * 2;
        const by2 = 18;
        const bh = 34;
        roundRectPath(ctx, bx, by2, tw + padX * 2, bh, bh / 2);
        ctx.fillStyle = "rgba(128,128,128,0.5)";
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + (tw + padX * 2) / 2, by2 + bh / 2);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
      }

      // 过渡遮罩（当前恒为 0，保留变量避免影响其余逻辑）
      if (fadeA > 0.002) {
        ctx.globalAlpha = fadeA;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.globalAlpha = 1;
      }
    };
    drawLoop();

    return () => {
      disposed = true;
      clearTimeout(timeoutId);
      cancelAnimationFrame(raf);
      live.removeEventListener("ended", handleEnded);
      try { live.pause(); } catch { /* ignore */ }
      for (let i = 0; i < fxArr.length; i++) {
        const v = fxArr[i];
        if (v) {
          try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* ignore */ }
        }
      }
      hlsRef.current?.destroy();
      hlsRef.current = null;
      rebuildHlsRef.current = null;
      for (const u of revocable) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    if (saving) return;
    const live = liveRef.current;
    if (!live) return;
    setError(""); // 点击时清除错误提示，允许重试
    if (live.paused) {
      // 检测到停滞/加载失败（startLoad 无法恢复）时：重建 hls 强恢复；否则正常恢复播放
      if (needsRecoveryRef.current || !readyRef.current) {
        needsRecoveryRef.current = false;
        rebuildHlsRef.current?.();
        // createHls 的 MANIFEST_PARSED 内会自动 play；此处兜底再播放一次
        live.play().then(() => setPlaying(true)).catch(() => {});
      } else {
        // 若 hls 因片段加载失败进入 STOPPED，先 startLoad 恢复加载再播放，否则点击无反应
        try { hlsRef.current?.startLoad(); } catch { /* ignore */ }
        if (live.ended) {
          try { live.currentTime = 0; } catch { /* ignore */ }
        }
        live.play().then(() => setPlaying(true)).catch(() => {});
      }
    } else {
      live.pause();
      setPlaying(false);
    }
  };

  // 保存视频：录制 canvas 流（真实播放一遍），保存到相册/下载
  const doSave = async () => {
    const canvas = canvasRef.current;
    const live = liveRef.current;
    if (!canvas || !live || saving || plan.totalSeg === 0) return;
    setSaving(true);
    savingRef.current = true; // 同步置位：录制期间禁用循环回绕，避免录到下一遍开头
    const wasPlaying = !live.paused;
    let dataDirAbs = ""; // 应用沙盒数据目录（移动端边录边写的落盘目录）
    let abortPath = ""; // 出错时待清理的本地半成品文件
    try {
      // 从头播放以便录制完整内容。不钉在 0：首段缓冲起点≈0.02（非 0），
      // 停在 0 会让 Chrome 不渲染 → 起始卡顿/黑屏，故落到已缓冲起点
      try { live.currentTime = safeStartPos(live, 0); } catch { /* ignore */ }
      if (live.paused) await live.play().catch(() => {});
      setPlaying(true);
      // 等待首帧真正解码并绘制，避免录制开头为黑帧（Android 上 videoWidth>0 时往往还没出帧，
      // 过早 captureStream 会让首帧/MP4 封面只有叠加层、画面为黑）。标准：播放头相对起播点
      // 前进了（说明已解码出帧并呈现），再让 drawLoop 把该帧画上画布。
      const startT = live.currentTime;
      const t0 = performance.now();
      while (live.currentTime <= startT + 0.03 && performance.now() - t0 < 4000) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      // 再等两帧让 drawLoop 把视频首帧画到画布后再开始录制
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));

      // 录制码率/帧率按长度做内存预算：iOS 整段 mp4 需一次性 Blob→ArrayBuffer 再经 Tauri IPC
      // 整体拷贝，视频越长峰值内存越大，长视频无上限会导致 WKWebView 内存吃紧闪退回首页。
      // 给"总时长"设内存预算，反推码率上限；越长越压低帧率，保证保存不 OOM 且画质够用。
      const MEMORY_BUDGET_BYTES = 40 * 1024 * 1024; // ~40MB，峰值(renderer+IPC拷贝)≈120MB 内安全
      const captureFps = totalSec <= 45 ? 30 : totalSec <= 90 ? 24 : 20;
      const bitrate = Math.round((MEMORY_BUDGET_BYTES * 8) / Math.max(totalSec, 1));

      const stream = canvas.captureStream(captureFps);
      // 选择当前环境支持的录制格式。优先 mp4：容器自带时长元数据与封面，系统相册可正确识别
      // （webm 由 MediaRecorder 产出常缺 Duration，表现为"可播但时长0、封面黑屏"）。
      let mime = "";
      if (MediaRecorder.isTypeSupported("video/mp4")) mime = "video/mp4";
      else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) mime = "video/webm;codecs=vp9";
      else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) mime = "video/webm;codecs=vp8";
      else if (MediaRecorder.isTypeSupported("video/webm")) mime = "video/webm";
      const rateOpts: MediaRecorderOptions = { videoBitsPerSecond: bitrate };
      if (mime) rateOpts.mimeType = mime;
      const rec = new MediaRecorder(stream, rateOpts);
      // 以 recorder 实际生效的 mimeType 为准判断容器，避免因探测返回 false 导致格式张冠李戴
      // （如 iOS 上探测不出 mp4、MediaRecorder 默认却编码 mp4，若仍当 webm 存，相册会拒写）
      const actualMime = rec.mimeType || mime || "";
      const mimeBase = actualMime.startsWith("video/mp4") || actualMime.startsWith("application/mp4")
        ? "video/mp4"
        : "video/webm";
      const ext = mimeBase === "video/mp4" ? "mp4" : "webm";
      const isMobile = isTauriMobile();
      const fileName = `礼物录屏_${fmtFileTs(Date.now())}.${ext}`;
      // 边录边写：移动端长视频把每个 500ms chunk 用 plugin-fs 流式追加写到应用沙盒文件，
      // JS/WebKit 只短暂持有单个 chunk，避免整段 mp4 在 Blob→ArrayBuffer→IPC 里整体拷贝，
      // 导致 iOS 长视频 WKWebView 内存吃紧闪退回首页。写完后一次性用文件路径导入相册。
      if (isMobile) {
        dataDirAbs = await appDataDir();
      }
      // 用对象持有句柄：避免 let 被闭包赋值后 TS 把它收窄成 null-only，读句柄处需用下标取值
      const streamState: { handle: FileHandle | null } = { handle: null };
      let appendChain: Promise<void> = Promise.resolve();
      let chunkFailed = false;
      let bytesWritten = 0;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        if (isMobile) {
          const data = e.data;
          if (data && typeof data.arrayBuffer === "function") {
            appendChain = appendChain.then(async () => {
              if (chunkFailed) return;
              try {
                if (!streamState.handle) streamState.handle = await open(await join(dataDirAbs, fileName), { create: true, write: true, append: true });
                const buf = new Uint8Array(await data.arrayBuffer());
                const written = await streamState.handle!.write(buf);
                bytesWritten += written;
              } catch (err) {
                chunkFailed = true;
                console.error("[GiftReplay] 分块落盘失败:", err);
              }
            });
          }
        } else {
          chunks.push(e.data);
        }
      };
      const stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.start(500);
      // 等完整播完一遍后停止（录制期间已禁用循环回绕，不会录到下一遍的开头）
      await new Promise((r) => setTimeout(r, totalSec * 1000));
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());

      if (isMobile) {
        await appendChain; // 等待所有分块真正写盘完成
        await streamState.handle?.close();
        if (chunkFailed) throw new Error("录制分块写入失败");
        if (bytesWritten === 0) throw new Error("录制结果为空");
        abortPath = await join(dataDirAbs, fileName);
        // 从本地文件路径导入相册（成功已弹 toast），不再把整段带回 JS/IPC 内存
        await saveVideoFileFromPath(abortPath, fileName, mimeBase);
      } else {
        const blob = new Blob(chunks, { type: mimeBase });
        if (blob.size === 0) throw new Error("录制结果为空");
        const buf = await blob.arrayBuffer();
        const res = await saveVideoFile(buf, fileName, mimeBase);
        if (res === "fallback") showToast("视频保存失败，请重试");
      }
    } catch (e) {
      console.error("[GiftReplay] 保存视频失败:", e);
      // 边录边写中途失败：删掉半成品本地文件，避免残留
      if (abortPath) {
        try { await remove(abortPath); } catch { /* ignore */ }
      }
      showToast("保存视频失败");
    } finally {
      savingRef.current = false;
      if (!wasPlaying) {
        try { live.pause(); } catch { /* ignore */ }
        setPlaying(false);
      }
      setSaving(false);
    }
  };

  const firstTs = sorted.length > 0 ? fmtTime(sorted[0].giftTime) : "";
  const lastTs = sorted.length > 0 ? fmtTime(sorted[sorted.length - 1].giftTime) : "";

  return (
    <div className="rounded-xl border border-black/10 bg-white p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-black/80 shrink-0">
            已拼接 {sorted.length} 段
          </span>
          <span className="text-xs text-black/40 truncate">
            {firstTs} → {lastTs} · 时长 {fmtDur(totalSec)}
          </span>
        </div>
        <button type="button" onClick={onClose} className="text-black/35 hover:text-black/70 text-xs shrink-0">
          关闭
        </button>
      </div>

      {/* 各片段信息（粉丝 · 礼物 · 时刻） */}
      <div className="flex flex-wrap gap-1 mb-2">
        {sorted.map((c) => (
          <span
            key={c.id}
            className="px-1.5 py-0.5 rounded text-[11px] text-black/70"
            style={{ backgroundColor: c.group.fanColor }}
          >
            {c.group.nickname}·{c.group.giftName}·{fmtTime(c.giftTime)}
          </span>
        ))}
      </div>

      <div
        className="relative bg-black rounded-lg overflow-hidden mx-auto"
        style={{ aspectRatio: `${CANVAS_W}/${CANVAS_H}`, maxHeight: "62vh" }}
      >
        {/* 原始 video：直播画面与礼物特效绘制到 canvas，不直接显示。
            不能用 display:none——隐藏视频会让媒体/渲染管线停摆（paused=false 但 currentTime 冻结、点击无反应），
            改为"已渲染但移出可视区"（1px + 绝对定位 + 透明），保证持续出帧。 */}
        <video
          ref={liveRef}
          muted
          playsInline
          style={{ position: "absolute", left: "-10000px", top: 0, width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }}
        />
        {sorted.map((c, i) => (
          <video
            key={c.id}
            ref={(el) => {
              fxRefs.current[i] = el;
            }}
            muted
            playsInline
            preload="none"
            crossOrigin="anonymous"
            style={{ position: "absolute", left: "-10000px", top: 0, width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }}
          />
        ))}
        <canvas
          ref={canvasRef}
          onClick={toggle}
          className="w-full h-full cursor-pointer"
        />

        {!ready && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm pointer-events-none">
            视频加载中...
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-300 text-xs px-4 text-center pointer-events-none">
            {error}
          </div>
        )}
        {/* 暂停时显示播放按钮（居中圆形），点击画布即可恢复播放 */}
        {ready && !error && !playing && !saving && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-7 h-7 text-white" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </div>
        )}
        {playing && !saving && (
          <div className="absolute inset-0 flex items-center justify-center text-white/80 pointer-events-none opacity-0 hover:opacity-100 transition">
            <span className="text-xs">点击暂停</span>
          </div>
        )}
        {saving && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="text-white/90 text-xs">正在录制视频...</span>
          </div>
        )}
      </div>

      {/* 保存按钮（卡片下方） */}
      <div className="mt-2 flex items-center justify-center">
        <button
          type="button"
          onClick={doSave}
          disabled={saving || !ready || plan.totalSeg === 0}
          className="px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-[#1f1c17] hover:opacity-90 transition disabled:opacity-50"
        >
          {saving ? "录制中..." : "保存视频"}
        </button>
      </div>
    </div>
  );
}

/** 吊销 clip 的片段 Blob URL（clip 从 state 移除时调用，避免内存泄漏） */
function revokeClipBlobs(c: ClipData) {
  for (const u of c.blobUrls ?? []) {
    try { URL.revokeObjectURL(u); } catch { /* ignore */ }
  }
}

// ==================== 主组件 ====================

export default function GiftReplayPanel({
  anchorName = "",
  anchorFace = "",
  anchorUid = 0,
}: {
  anchorName?: string;
  anchorFace?: string;
  /** 主播 UID，用于获取直播间背景图 */
  anchorUid?: number;
}) {
  const [sessions, setSessions] = useState<ReplaySession[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");

  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const sessionsRef = useRef<HTMLDivElement>(null);

  // 每个场次的礼物组：live_id -> GiftGroup[]
  const [giftsBySession, setGiftsBySession] = useState<Record<string, GiftGroup[]>>({});

  const [priceFilter, setPriceFilter] = useState(2000);
  const [fanFilter, setFanFilter] = useState("");
  const [selectedGiftKeys, setSelectedGiftKeys] = useState<Set<string>>(new Set());
  const [clips, setClips] = useState<ClipData[]>([]);
  // 每次生成自增：作为合并播放器 key，重新生成时重建（新片段/新特效）
  const [genCount, setGenCount] = useState(0);
  const clipsRef = useRef<ClipData[]>([]);
  // 已请求过送礼排行头像的场次（模块级 bannerFaceCache 由横幅绘制读取，无需 state）
  const fetchedFaceLiveIdsRef = useRef<Set<string>>(new Set());
  // 渲染后同步最新 clips（供 onClose/generateClips 读取），不能渲染期直接写 ref
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);
  // 生成片段后按场次拉取送礼观众排行（UserScoreRank：nickname→face），
  // 通过送礼者昵称匹配写入模块级 bannerFaceCache（横幅绘制时读取），昵称无头像则兜底占位
  useEffect(() => {
    const liveIds = Array.from(
      new Set(clips.map((c) => c.group.session.live_id).filter(Boolean)),
    ).filter((id) => !fetchedFaceLiveIdsRef.current.has(id));
    if (liveIds.length === 0) return;
    let disposed = false;
    (async () => {
      for (const id of liveIds) {
        try {
          const res = await dataFetch(`/api/anchor/gift-replay?action=user_faces&live_id=${id}`);
          const json = await res.json();
          if (disposed || json?.code !== 0 || !json?.data) {
            // 失败/异常：不标记「已请求」，下次生成或刷新会自动重试
            continue;
          }
          const faces = json.data as Record<string, string>;
          // 仅当成功拉到非空头像列表才记入已请求集合，避免对同一场次反复发请求
          if (Object.keys(faces).length > 0) fetchedFaceLiveIdsRef.current.add(id);
          for (const [nick, face] of Object.entries(faces)) {
            if (nick && face) setBannerFace(nick, face);
          }
        } catch {
          // 拉取失败不阻塞横幅（兜底显示首字占位）；不标记已请求，留待重试
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [clips]);
  // 面板卸载时吊销仍打开的 clip 片段 Blob URL，避免内存泄漏
  useEffect(() => {
    return () => {
      for (const c of clipsRef.current) revokeClipBlobs(c);
    };
  }, []);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [genTotal, setGenTotal] = useState(0);
  const [showToast, setShowToast] = useState("");
  const [effectMap, setEffectMap] = useState<Record<string, { url: string; config: EffectConfig | null }>>({});
  // 直播间背景图（通过 uid→room_id→getInfoByRoom 获取，可选）
  const [roomBackground, setRoomBackground] = useState("");

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 监听外部点击关闭场次下拉
  useEffect(() => {
    if (!sessionsOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (sessionsRef.current?.contains(t)) return;
      setSessionsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown as EventListener, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown as EventListener);
    };
  }, [sessionsOpen, sessionsRef]);

  // 场次下拉面板定位（fixed，贴近按钮下方）
  useEffect(() => {
    if (!sessionsOpen) return;
    const btn = sessionsRef.current?.querySelector("button");
    const panel = sessionsRef.current?.querySelector<HTMLElement>("div.fixed");
    if (!btn || !panel) return;
    const r = btn.getBoundingClientRect();
    const margin = 12;
    const estH = Math.min(sessions.length * 32 + 40, 300);
    let top = r.bottom + 4;
    if (top + estH > window.innerHeight - margin) {
      top = Math.max(margin, r.top - estH - 4);
    }
    panel.style.top = `${top}px`;
    panel.style.left = `${Math.max(margin, Math.min(r.left, window.innerWidth - 170 - margin))}px`;
  }, [sessionsOpen, sessions.length, sessionsRef]);

  const toast = useCallback((msg: string) => {
    setShowToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setShowToast(""), 12000);
  }, []);

  // 加载场次
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const res = await dataFetch("/api/anchor/gift-replay?action=list");
        const json = await res.json();
        console.log("[GiftReplay] list 响应:", json);
        if (json?.code !== 0) {
          if (json?.message === "needs-relogin") setSessionError("登录凭证已失效，请重新登录");
          else setSessionError(json?.message || "获取场次失败");
          setSessionLoading(false);
          return;
        }
        const list: ReplaySession[] = json?.data?.list ?? [];
        console.log(`[GiftReplay] 场次数=${list.length}`, list);
        if (disposed) return;
        setSessions(list);
        setSelectedSessions(new Set(list.map((s) => s.live_id)));
        setSessionLoading(false);
      } catch (e: unknown) {
        if (disposed) return;
        console.error("[GiftReplay] list 加载异常:", e);
        setSessionError(e instanceof Error ? e.message : "网络错误");
        setSessionLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // 载入所选场次的礼物（并行，逐场拉取 ≥2000）
  useEffect(() => {
    const ids = Array.from(selectedSessions);
    if (ids.length === 0) return;
    let disposed = false;
    (async () => {
      const updated: Record<string, GiftGroup[]> = { ...giftsBySession };
      for (const liveId of ids) {
        if (disposed) break;
        if (updated[liveId]) continue; // 已拉取
        const s = sessions.find((x) => x.live_id === liveId);
        if (!s) continue;
        try {
          const res = await dataFetch(
            `/api/anchor/gift-replay?action=gifts&live_id=${liveId}&start_time=${s.start_time}&end_time=${s.end_time}&threshold=2000`,
          );
          const json = await res.json();
          console.log(`[GiftReplay] gifts live_id=${liveId} 响应:`, json);
          if (json?.code === 0 && json?.data?.list) {
            updated[liveId] = buildGroups(s, json.data.list);
            console.log(`[GiftReplay] gifts live_id=${liveId} 分组数=${updated[liveId].length}`);
          } else {
            console.warn(`[GiftReplay] gifts live_id=${liveId} 无数据:`, json?.message);
            updated[liveId] = [];
          }
        } catch (e) {
          console.error(`[GiftReplay] gifts live_id=${liveId} 异常:`, e);
          updated[liveId] = [];
        }
      }
      if (!disposed) {
        setGiftsBySession(updated);
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessions]);

  // 解析礼物目录，构建 name -> gift_id -> 特效
  useEffect(() => {
    let disposed = false;
    (async () => {
      const platform = await getPlatform();
      await ensureGiftCatalogLoaded(platform);
      const list = getGiftList();
      const nameToId: Record<string, number> = {};
      for (const g of list) {
        if (g.name && g.id) nameToId[g.name] = g.id;
      }
      if (disposed) return;
      // 为当前展示的全部礼物一次性解析特效
      const allGroups = Object.values(giftsBySession).flat();
      const needed = allGroups.filter((g) => !effectMap[g.key]);
      if (needed.length === 0) return;
      const ids = needed
        .map((g) => nameToId[g.giftName])
        .filter((id): id is number => !!id);
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return;
      const fx = await fetchGiftEffects(uniqueIds);
      // id -> url; 关联回 group
      const updated: Record<string, { url: string; config: EffectConfig | null }> = {};
      for (const g of needed) {
        const id = nameToId[g.giftName];
        const eff = ids.includes(id) ? fx[id] : undefined;
        if (eff?.found && eff.web_mp4) {
          updated[g.key] = {
            url: eff.web_mp4,
            config: (eff.effect_config as EffectConfig | null) ?? null,
          };
        } else {
          updated[g.key] = { url: "", config: null };
        }
      }
      if (!disposed) setEffectMap((prev) => ({ ...prev, ...updated }));
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftsBySession]);

  // 获取主播直播间背景图（uid→room_id→getInfoByRoom→background）
  useEffect(() => {
    if (!anchorUid) return;
    let disposed = false;
    (async () => {
      try {
        const res = await dataFetch(`/api/anchor/gift-replay?action=roombg&uid=${anchorUid}`);
        const json = await res.json();
        console.log("[GiftReplay] roombg 响应:", json);
        if (!disposed && json?.code === 0 && json?.data?.background) {
          setRoomBackground(json.data.background);
        }
      } catch (e) {
        console.warn("[GiftReplay] 获取直播间背景失败:", e);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [anchorUid]);

  // ==================== 数据处理 ====================

  const allGroups = useMemo(
    () => Object.values(giftsBySession).flat(),
    [giftsBySession],
  );

  // 仅展示当前勾选场次的礼物（取消勾选后实时消失）
  const visibleGroups = useMemo(
    () => allGroups.filter((g) => selectedSessions.has(g.session.live_id)),
    [allGroups, selectedSessions],
  );

  // 每场在"当前筛选条件"下的礼物数（用于场次下拉显示）
  const sessionCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of allGroups) {
      if (g.giftValue >= priceFilter && (!fanFilter || g.nickname === fanFilter)) {
        m[g.session.live_id] = (m[g.session.live_id] ?? 0) + 1;
      }
    }
    return m;
  }, [allGroups, priceFilter, fanFilter]);

  // 礼物拉取中：是否存在尚未拉取完毕的已选场次
  const giftLoading = useMemo(
    () =>
      !sessionLoading &&
      Array.from(selectedSessions).some((id) => !(id in giftsBySession)),
    [selectedSessions, giftsBySession, sessionLoading],
  );

  const fanList = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of visibleGroups) map.set(g.nickname, g.nickname);
    return Array.from(map.values());
  }, [visibleGroups]);

  const filteredGroups = useMemo(() => {
    return visibleGroups.filter(
      (g) =>
        g.giftValue >= priceFilter &&
        (!fanFilter || g.nickname === fanFilter),
    );
  }, [visibleGroups, priceFilter, fanFilter]);

  // 生成结果拆分：可播放片段（无错误且有片段）→ 合并播放；失败片段 → 单独提示
  const videoClips = useMemo(
    () => clips.filter((c) => !c.error && extractSegments(c.playlist).length > 0),
    [clips],
  );
  const errorClips = useMemo(() => clips.filter((c) => c.error), [clips]);

  const toggleSession = (id: string) => {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllSessions = () => {
    setSelectedSessions((prev) =>
      prev.size === sessions.length ? new Set() : new Set(sessions.map((s) => s.live_id)),
    );
  };

  const toggleGift = (g: GiftGroup) => {
    // 同时选择的礼物数量上限（模糊提示，不透露内部负担）
    if (!selectedGiftKeys.has(g.key) && selectedGiftKeys.size >= 10) {
      toast("一次最多选择 10 个礼物，请先取消部分选择");
      return;
    }
    setSelectedGiftKeys((prev) => {
      const next = new Set(prev);
      if (next.has(g.key)) next.delete(g.key);
      else next.add(g.key);
      return next;
    });
  };

  // ==================== 生成录屏 ====================

  const generateClips = async () => {
    const model = selectedGiftKeys;
    if (model.size === 0) {
      toast("请先选择至少一个礼物");
      return;
    }
    const selected = allGroups.filter((g) => model.has(g.key));
    if (selected.length === 0) return;

    const jobs: { g: GiftGroup; liveId: string; s: ReplaySession; time: number; count: number }[] = [];
    const seenJobs = new Set<string>();
    for (const g of selected) {
      const s = g.session;
      for (const t of g.times) {
        const jobKey = `${g.key}_${t}`;
        if (seenJobs.has(jobKey)) continue; // 同一礼物同一秒只生成一次，避免重复 key
        seenJobs.add(jobKey);
        jobs.push({ g, liveId: s.live_id, s, time: t, count: g.timeCounts?.[t] ?? 1 });
      }
    }
    if (jobs.length === 0) return;

    // 礼物特效按绝对时间播放，不做跨记录的合并（合并仅发生在"一条记录 gift_count>1"时，
    // 该场景本就是一个 job、count 透传，动画只播一次横幅显示 gift_count）。
    // 若两个特效动画在时间上重叠，由 drawLoop 的游标队列把后一个推迟到前一个播完再播
    // （见下方排队逻辑：start = max(giftPosAbs, cursor)，前一个不截断、后一个自动等待）。
    const showFxFlags: boolean[] = jobs.map(() => true);
    if (jobs.length > 20) {
      toast("礼物时刻过多，一次最多生成 20 段，请精简选择");
      return;
    }

    setGenerating(true);
    setGenTotal(jobs.length);
    setGenProgress(0);
    console.log(`[GiftReplay] 生成录屏 jobs=${jobs.length}`, jobs.map((j) => ({ id: j.liveId, t: j.time })));
    const produced: ClipData[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const { g, liveId, s, time } = jobs[i];
      try {
        console.log(`[GiftReplay] clips 请求 ${i + 1}/${jobs.length} live_id=${liveId} gift_time=${time}`);
        const res = await dataFetch(
          `/api/anchor/gift-replay?action=clips&live_id=${liveId}&start_time=${s.start_time}&end_time=${s.end_time}&gift_time=${time}`,
        );
        const json = await res.json();
        console.log(`[GiftReplay] clips 响应 ${i + 1}/${jobs.length}:`, json);
        if (json?.code === 0 && json?.data?.found) {
          produced.push({
            id: `${g.key}_${time}`,
            group: g,
            playlist: json.data.playlist,
            giftTime: time,
            count: jobs[i].count,
            effectVideoUrl: effectMap[g.key]?.url ?? "",
            effectConfig: effectMap[g.key]?.config ?? null,
            showFx: showFxFlags[i],
            blobUrls: json.data.blobUrls,
          });
        } else {
          console.warn(`[GiftReplay] clips 无片段 ${i + 1}/${jobs.length}:`, json?.data?.reason);
          produced.push({
            id: `${g.key}_${time}`,
            group: g,
            playlist: "",
            giftTime: time,
            count: jobs[i].count,
            effectVideoUrl: "",
            effectConfig: null,
            showFx: showFxFlags[i],
            error: json?.data?.reason || "未能生成该段录屏",
          });
        }
      } catch (e) {
        console.error(`[GiftReplay] clips 异常 ${i + 1}/${jobs.length}:`, e);
        produced.push({
          id: `${g.key}_${time}`,
          group: g,
          playlist: "",
          giftTime: time,
          count: g.timeCounts?.[time] ?? 1,
          effectVideoUrl: "",
          effectConfig: null,
          showFx: showFxFlags[i],
          error: "生成失败",
        });
      }
      setGenProgress(i + 1);
    }
    console.log(`[GiftReplay] 生成完成 成功=${produced.filter((p) => !p.error).length} 失败=${produced.length - produced.filter((p) => !p.error).length}`);
    // 生成结果始终只反映"当前所选礼物"：produced 已覆盖所有被选中的 gift group（含失败 error 占位）。
    // 直接整体替换，避免取消选择后旧礼物的录屏残留（setClips 增量合并会导致旧片段混入）。
    // 被移除/被替换的旧 clip 的 Blob URL 延后吊销，等旧合并播放器卸载后再释放，避免旧 hls 仍在读取时被吊销。
    const prevClips = clipsRef.current;
    const newIds = new Set(produced.map((p) => p.id));
    const removed = prevClips.filter((p) => !newIds.has(p.id));
    setClips(produced);
    setGenCount((n) => n + 1);
    if (removed.length > 0) {
      window.setTimeout(() => {
        for (const p of removed) revokeClipBlobs(p);
      }, 600);
    }
    setGenerating(false);
    if (produced.length === 0) toast("暂未生成任何录屏，请检查是否已登录且为本人账号");
  };

  // ==================== 渲染 ====================

  return (
    <div className="space-y-4">
      {showToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[9999] bg-black/85 text-white px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity">
          {showToast}
        </div>
      )}

      {/* 标题 */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold tracking-tight">礼物录屏</h3>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <SessionsSelect
          sessions={sessions}
          selected={selectedSessions}
          onToggle={toggleSession}
          onSelectAll={selectAllSessions}
          visible={sessionsOpen}
          onToggleOpen={() => setSessionsOpen((v) => !v)}
          containerRef={sessionsRef}
          loading={sessionLoading}
          counts={sessionCounts}
        />

        <Dropdown
          value={String(priceFilter)}
          onChange={(v) => setPriceFilter(Number(v))}
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-black/65 outline-none"
          options={PRICE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        />

        <Dropdown
          value={fanFilter}
          onChange={setFanFilter}
          className="rounded-lg border border-black/10 bg-white px-2 py-1.5 text-xs text-black/65 outline-none max-w-[160px]"
          options={[
            { value: "", label: "全部粉丝" },
            ...fanList.map((f) => ({ value: f, label: f })),
          ]}
        />

        {selectedGiftKeys.size > 0 && (
          <button
            type="button"
            onClick={() => setSelectedGiftKeys(new Set())}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-500 hover:bg-red-600 transition"
          >
            清除选择({selectedGiftKeys.size})
          </button>
        )}

        <button
          type="button"
          onClick={generateClips}
          disabled={generating}
          className="ml-auto px-4 py-1.5 rounded-lg text-xs font-medium text-white bg-[#1f1c17] hover:opacity-90 transition disabled:opacity-50"
        >
          生成
        </button>
      </div>

      {generating && (
        <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-3 text-xs text-black/55">
          正在生成录屏（{genProgress}/{genTotal}）...
          <div className="mt-2 h-1.5 bg-black/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-[#1f1c17] rounded-full transition-all"
              style={{ width: `${genTotal ? (genProgress / genTotal) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* 场次加载状态 */}
      {sessionError && (
        <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4 text-center text-sm text-black/45">
          {sessionError}
        </div>
      )}
      {sessionLoading && !sessionError && (
        <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4 text-center text-sm text-black/45">
          正在获取直播场次...
        </div>
      )}

      {/* 礼物列表（按钮按粉丝着色） */}
      {!sessionLoading && !sessionError && (
        giftLoading ? (
          <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4 text-center text-sm text-black/45">
            正在获取礼物列表...
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="rounded-lg border border-black/10 bg-[#f9f4ea] p-4 text-center text-sm text-black/45">
            暂无符合条件的礼物
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {filteredGroups.map((g) => {
              const isSel = selectedGiftKeys.has(g.key);
              return (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => toggleGift(g)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition border ${
                    isSel
                      ? "border-[#1f1c17] bg-[#1f1c17] text-white shadow-md"
                      : "border-black/10 text-black/75 hover:opacity-80"
                  }`}
                  style={isSel ? {} : { backgroundColor: g.fanColor }}
                >
                  {g.icon && (
                    <img src={g.icon.replace(/^\/\//, "https://").replace(/^http:/, "https:")} alt="" className="w-4 h-4 rounded" />
                  )}
                  <span className="font-medium">{g.giftName}</span>
                  <span className={isSel ? "text-white/70" : "text-black/40"}>
                    ×{g.count} · {g.giftValue}
                  </span>
                </button>
              );
            })}
          </div>
        )
      )}

      {/* 生成结果：全部可播放片段拼接为一个视频；失败的片段单独提示 */}
      {clips.length > 0 && (
        <div className="space-y-3">
          {videoClips.length > 0 && (
            <MergedPlayer
              key={genCount}
              clips={videoClips}
              backgroundUrl={roomBackground}
              anchorName={anchorName}
              anchorFace={anchorFace}
              onClose={() => {
                const all = clipsRef.current;
                setClips([]);
                // 先卸载播放器，再吊销全部 Blob URL，避免旧 hls 仍在读取
                window.setTimeout(() => {
                  for (const c of all) revokeClipBlobs(c);
                }, 600);
              }}
            />
          )}
          {errorClips.map((c) => (
            <div key={c.id} className="rounded-xl border border-black/10 bg-[#f9f4ea] p-3 text-xs text-black/45">
              {c.group.nickname} · {c.group.giftName}：{c.error}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== 工具函数 ====================

function buildGroups(session: ReplaySession, rawList: RawGiftRecord[]): GiftGroup[] {
  const map = new Map<string, GiftGroup>();
  for (const it of rawList) {
    const time = Number(it.send_gift_time) || 0;
    const cnt = Number(it.gift_count) || 1;
    const key = `${it.nickname}|${it.gift_name}`;
    const group = map.get(key);
    if (group) {
      group.count += cnt;
      group.times.push(time);
      group.timeCounts![time] = cnt;
      group.giftValue = Math.max(group.giftValue, Number(it.gift_value) || 0);
      if (!group.uid && it.uid) group.uid = Number(it.uid) || undefined;
    } else {
      map.set(key, {
        key: `${session.live_id}|${key}`,
        session,
        nickname: it.nickname ?? "",
        giftName: it.gift_name ?? "",
        giftValue: Number(it.gift_value) || 0,
        count: cnt,
        times: [time],
        timeCounts: { [time]: cnt },
        icon: it.gift_icon ?? "",
        fanColor: fanColorFromNick(it.nickname ?? ""),
        uid: Number(it.uid) || undefined,
      });
    }
  }
  return Array.from(map.values());
}