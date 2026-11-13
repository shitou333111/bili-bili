"use client";

/**
 * 官方入场提示（B站入场动画）播放 —— 视频 + 配套 JSON。
 *
 * 视频布局（以示例 info 为例，视频 1088x368）：
 *  ├─ RGB 画面区  info.rgbFrame = [0,0,1080,240]   —— 彩色特效本体（含长条/圆形等底图）
 *  ├─ alpha 区    info.aFrame   = [0,244,540,120]  —— 灰度透明通道（R 通道），尺寸 = 输出尺寸
 *  └─ 遮罩区      info.aFrame 右侧剩余区域           —— 模板元素的"可见性遮罩"（白=可见，黑=隐藏），
 *                                                  圆形头像遮罩 + 长条文字遮罩，逐帧烘焙进视频
 *
 * 合成：① 把 RGB 区绘制到输出画布（尺寸 = info.w/h × info.scale）；② 用 alpha 区 R 通道逐像素
 * 写 alpha（与礼物特效 GiftEffect.renderFrame 同构）；③ 叠加模板层。
 *
 * JSON 三部分：
 *  - info：动画（rgbFrame）+ 透明度（aFrame）+ 尺寸/缩放/帧率；
 *  - src：模板元素定义 —— srcTag 决定用途：含 "avatar" = 用户头像，含 "text" = 昵称文字
 *    （示例中两者 srcType 都是 "img"，靠 srcTag 区分）；w/h = 元素设计尺寸；
 *  - frame：逐帧布局，i = 视频帧号（0 基，第 n 帧用 i=n 的条目；稀疏 → 取 <= 当前帧的最大 i）。
 *    obj.frame = 元素在 RGB 画面区坐标系的矩形；obj.mFrame = 该帧遮罩在**视频绝对坐标**中的矩形
 *    （位于 RGB 区右侧的遮罩带内），尺寸与 frame 不一定相同 → 必须拉伸（缩放）到 frame。
 *
 * 绘制：元素先画进独立缓冲（头像按 fitXY 铺满矩形；昵称按 src.color 居中、超宽缩字号），
 * 再用 mFrame 遮罩衰减缓冲的 alpha（头像被裁成圆、昵称被裁进长条），最后按 z 叠到输出上。
 * 无 src/frame（简单版动画）时按默认粗略区域画长条昵称 + 左端头像圆（DEFAULT_*，待精确坐标）。
 *
 * JSON 获取：danmaku 服务端随 entry 事件下发已加载的 config（画布无 Tauri IPC 的主链路）；
 * 缺省时本组件自行拉取：Tauri 走 invoke("fetch_json")，浏览器直连 CDN（带 CORS），
 * 再失败回退同源 /api/bili-proxy（白名单含 i0.hdslb.com）。
 */
import { useEffect, useRef, useState } from "react";
import type {
  EntryEffectConfig,
  EntrySampleConfig,
  EntryTemplateFrame,
  EntryTemplateSrc,
} from "@/lib/display/types";
import { serverFetch } from "@/lib/server-api";

/** 加载兜底：JSON/视频超时仍未开始播放则结束，避免永久占用 */
const LOAD_TIMEOUT_MS = 8000;

/** 无模板坐标时的默认区域（占输出画布的宽高比例；拿到精确坐标后改这里）：
 *  长条（昵称）中心位于 y=78%，头像圆位于长条左端。 */
const DEFAULT_BAR = { x: 0.3, y: 0.78, w: 0.62, h: 0.1 };
/** 头像圆直径 = 文本区高度 × 该倍数；圆心到文本矩形左缘的间隙 = 文本区高度 × 该倍数 */
const AVATAR_DIAMETER_RATIO = 1.5;
const AVATAR_GAP_RATIO = 0.35;

/** 昵称在模板文字槽内的锚点（相对槽宽/高）：模板文字槽往往比实际亮条更宽（右侧渐隐），
 *  水平居中会显得偏右；条面视觉中心也略低于槽中心，故水平 40%、垂直 58%（偏下）。 */
const NICK_ANCHOR_X = 0.3;
const NICK_ANCHOR_Y = 0.58;

/** 拉取入场动画配套 JSON：Tauri invoke → 浏览器直连 CDN（B站 CDN 带 CORS）→ 同源代理兜底 */
async function fetchEntryJson(url: string): Promise<EntryEffectConfig | null> {
  if (!url) return null;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const j = await invoke<EntryEffectConfig>("fetch_json", { url });
      if (j && typeof j === "object" && j.info) return j;
    } catch {
      /* IPC 不可用 → 落到浏览器通道 */
    }
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const j = await res.json();
      if (j && typeof j === "object" && j.info) return j as EntryEffectConfig;
    }
  } catch {
    /* 直连失败（CORS/网络）→ 同源代理兜底 */
  }
  try {
    // 同源代理兜底（Tauri 生产包为静态导出，相对路径需经 serverFetch 指向服务器）
    const j = await serverFetch<EntryEffectConfig>(`/api/bili-proxy?url=${encodeURIComponent(url)}`);
    if (j && typeof j === "object" && j.info) return j;
  } catch {
    /* 全部失败 → null（整段绘制回退，无模板层） */
  }
  return null;
}

/** 模板元素用途：头像 / 文字 / 未识别（未识别的图片元素没有素材来源，跳过不画） */
type TemplateKind = "avatar" | "text" | "unknown";
function classifySrc(def: EntryTemplateSrc | undefined): TemplateKind {
  const tag = (def?.srcTag ?? "").toLowerCase();
  if (tag.includes("avatar")) return "avatar";
  if (tag.includes("text") || def?.srcType === "txt") return "text";
  return "unknown";
}

/** 当前帧对应的模板条目：i <= frameIdx 的最大 i（i 为 0 基视频帧号，稀疏且可能乱序） */
function pickFrameTemplate(cfg: EntryEffectConfig, frameIdx: number): EntryTemplateFrame | null {
  const frames = cfg.frame ?? [];
  let best: EntryTemplateFrame | null = null;
  for (const fr of frames) {
    if (!fr || typeof fr.i !== "number" || !Array.isArray(fr.obj)) continue;
    if (fr.i > frameIdx) continue;
    if (!best || fr.i > best.i) best = fr;
  }
  return best;
}

/** 合法的 #RRGGBB 颜色（否则用默认白） */
function safeColor(c: string | undefined, fallback: string): string {
  return c && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c) ? c : fallback;
}

export default function EntryOfficialEffect({
  src,
  json,
  config,
  user,
  loop = false,
  onEnd,
  onMeasure,
  cssWidth,
  fallbackSrc,
  sample,
}: {
  /** 特效视频地址（web_mp4；通常是本地缓存地址 /api/video?p=...） */
  src: string;
  /** 视频加载失败时的回退地址（B站 CDN 直链）——本地服务器不可用（如纯 Web 预览）时兜底 */
  fallbackSrc?: string;
  /** 配套 JSON 地址（web_mp4_json；config 缺省时本组件自行拉取） */
  json: string;
  /** 已加载的 JSON（danmaku 服务端随事件下发；null=服务端加载失败 → 本组件自行重试） */
  config?: EntryEffectConfig | null;
  /** 进场用户（头像画入模板的 avatar 槽、昵称画入模板的 text 槽） */
  user: { uname: string; face: string };
  /** true = 循环播放（编辑模式常驻预览 / 面板预览弹窗） */
  loop?: boolean;
  /** 播放结束（loop=false 时触发一次；含加载失败），父级据此结束本条入场动画 */
  onEnd?: () => void;
  /** 输出尺寸（natural 像素）上报：画布按入场提示布局水平居中 */
  onMeasure?: (w: number) => void;
  /** CSS 宽度（缺省 = 输出原尺寸、canvas 内在分辨率 1:1；预览弹窗传小尺寸） */
  cssWidth?: number;
  /** 昵称样本（前置语/后置语 + 三段文字颜色；缺省只画昵称、颜色取模板 src.color） */
  sample?: EntrySampleConfig;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** 样本用 ref 传递：面板调整时实时生效，不需要重启视频（不进入绘制 effect 依赖） */
  const sampleRef = useRef(sample);
  sampleRef.current = sample;
  const [visible, setVisible] = useState(true);
  /** 服务端未下发 config 时自行拉取的进度：undefined=拉取中（暂不启动播放） */
  const [fetched, setFetched] = useState<EntryEffectConfig | null | undefined>(
    config !== undefined && config !== null ? config : undefined
  );
  /** 输出尺寸（cssWidth 模式下按其算高度） */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  // config 未提供（或为 null）→ 自行拉取 JSON；config 到位 → 直接用
  useEffect(() => {
    if (config) {
      setFetched(config);
      return;
    }
    let alive = true;
    setFetched(undefined);
    void fetchEntryJson(json).then((j) => {
      if (alive) setFetched(j);
    });
    return () => {
      alive = false;
    };
  }, [config, json]);

  useEffect(() => {
    setVisible(true);
    setNatural(null);
    if (fetched === undefined) return; // JSON 拉取中：等到位再启动
    const cfg = fetched;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 隐藏的 video 元素（不进 DOM）：作为特效视频的帧源
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.loop = loop;
    video.src = src;

    // 用户头像（模板 avatar 槽的绘制源）：CORS 失败时仅画占位
    const avatar = new Image();
    let avatarReady = false;
    if (user.face) {
      avatar.crossOrigin = "anonymous";
      avatar.onload = () => {
        avatarReady = true;
      };
      avatar.src = user.face;
    }

    /** 模板元素的离屏缓冲（按 srcId 复用，避免逐帧创建 canvas） */
    const buffers = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>();
    /** 遮罩采样缓冲（复用） */
    const maskCanvas = document.createElement("canvas");
    const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
    /** alpha 区采样缓冲 / 输出帧缓冲（复用）：旧实现每帧新建 canvas + getContext + getImageData，
     *  大尺寸动画下每秒产生几十 MB 垃圾，直播姬（CEF）里极易卡顿、甚至让整个浏览器源假死。
     *  这里只在尺寸变化时重建，逐帧复用同一批缓冲。 */
    const alphaCanvas = document.createElement("canvas");
    let alphaCtx: CanvasRenderingContext2D | null = null;
    const frameCanvas = document.createElement("canvas");
    let frameCtx: CanvasRenderingContext2D | null = null;

    let ended = false;
    let raf: number | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (ended) return;
      ended = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      setVisible(false);
      setTimeout(() => onEndRef.current?.(), 300); // 等淡出动画（300ms）结束再通知父级
    };

    /** 取（或建）指定尺寸的元素缓冲 */
    const getBuffer = (key: string, w: number, h: number) => {
      let b = buffers.get(key);
      if (!b) {
        const c = document.createElement("canvas");
        const bc = c.getContext("2d");
        if (!bc) return null;
        b = { canvas: c, ctx: bc };
        buffers.set(key, b);
      }
      if (b.canvas.width !== w || b.canvas.height !== h) {
        b.canvas.width = w;
        b.canvas.height = h;
      }
      b.ctx.clearRect(0, 0, w, h);
      return b;
    };

    /** 昵称文字：画入元素缓冲（前置语 + 昵称 + 后置语，居中、超宽自动缩字号；
     *  三段各自取样本颜色，无样本时统一用模板 src.color） */
    const drawTextInto = (
      bc: CanvasRenderingContext2D,
      w: number,
      h: number,
      def: EntryTemplateSrc | undefined
    ) => {
      const uname = user.uname || "";
      if (!uname || w <= 0 || h <= 0) return;
      const s = sampleRef.current;
      const templateColor = safeColor(def?.color, "#ffffff");
      const segments = [
        { text: s?.prefix ?? "", color: s?.prefixColor ?? templateColor },
        { text: uname, color: s?.nameColor ?? templateColor },
        { text: s?.suffix ?? "", color: s?.suffixColor ?? templateColor },
      ].filter((seg) => seg.text.length > 0);
      // 前置词/昵称/后置词之间自动补一个空格，拉开视觉距离
      const spaced = segments.map((seg, i) => (i === 0 ? seg : { ...seg, text: ` ${seg.text}` }));
      const bold = def?.style?.includes("b") ? "bold " : "";
      const setFont = (sz: number) => {
        bc.font = `${bold}${sz}px "Microsoft YaHei", "PingFang SC", sans-serif`;
      };
      let size = Math.max(8, Math.round(h * 0.66));
      bc.save();
      setFont(size);
      const measured = spaced.reduce((sum, seg) => sum + bc.measureText(seg.text).width, 0);
      if (measured > w && measured > 0) {
        size = Math.max(8, Math.floor((size * w) / measured));
        setFont(size);
      }
      const widths = spaced.map((seg) => bc.measureText(seg.text).width);
      const totalWidth = widths.reduce((sum, x) => sum + x, 0);
      bc.textAlign = "left";
      bc.textBaseline = "middle";
      bc.shadowColor = "rgba(0,0,0,0.45)";
      bc.shadowBlur = Math.max(1, Math.round(size * 0.1));
      // 整段文字以锚点为中心，逐段左对齐绘制
      const x0 = (def ? w * NICK_ANCHOR_X : w / 2) - totalWidth / 2;
      const y = def ? h * NICK_ANCHOR_Y : h / 2;
      let x = x0;
      spaced.forEach((seg, i) => {
        bc.fillStyle = seg.color;
        bc.fillText(seg.text, x, y);
        x += widths[i];
      });
      bc.restore();
    };

    /** 头像：按 fitXY 铺满元素缓冲（形状由 mFrame 圆形遮罩裁出）；
     *  无头像（预览 / 未返回 face / 加载失败）时画示例头像：渐变底 + 人形剪影。 */
    const drawAvatarInto = (bc: CanvasRenderingContext2D, w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      if (avatarReady) {
        bc.drawImage(avatar, 0, 0, w, h);
        return;
      }
      const g = bc.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#7fb0ff");
      g.addColorStop(1, "#3d6fe0");
      bc.fillStyle = g;
      bc.fillRect(0, 0, w, h);
      bc.fillStyle = "rgba(255,255,255,0.92)";
      bc.beginPath();
      bc.arc(w / 2, h * 0.38, Math.min(w, h) * 0.19, 0, Math.PI * 2);
      bc.fill();
      bc.beginPath();
      bc.arc(w / 2, h * 1.02, w * 0.36, Math.PI, Math.PI * 2);
      bc.fill();
    };

    /** 遮罩：从视频采样 mFrame 区域（绝对坐标），拉伸到元素缓冲尺寸后逐像素衰减 alpha */
    const applyMask = (
      b: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D },
      mrect: [number, number, number, number]
    ) => {
      if (!maskCtx) return;
      const [mx, my, mw, mh] = mrect;
      if (mw <= 0 || mh <= 0) return;
      const bw = b.canvas.width;
      const bh = b.canvas.height;
      try {
        if (maskCanvas.width !== mw || maskCanvas.height !== mh) {
          maskCanvas.width = mw;
          maskCanvas.height = mh;
        }
        maskCtx.clearRect(0, 0, mw, mh);
        maskCtx.drawImage(video, mx, my, mw, mh, 0, 0, mw, mh);
        const mask = maskCtx.getImageData(0, 0, mw, mh);
        const region = b.ctx.getImageData(0, 0, bw, bh);
        // 遮罩区是"白=可见 / 黑=隐藏"的灰度图，取 R 通道；双线性按比例缩放采样
        for (let y = 0; y < bh; y++) {
          const sy = Math.min(mh - 1, Math.floor((y * mh) / bh));
          for (let x = 0; x < bw; x++) {
            const sx = Math.min(mw - 1, Math.floor((x * mw) / bw));
            const m = mask.data[(sy * mw + sx) * 4];
            const idx = (y * bw + x) * 4 + 3;
            region.data[idx] = Math.round((region.data[idx] * m) / 255);
          }
        }
        b.ctx.putImageData(region, 0, 0);
      } catch {
        /* 读像素失败（跨域污染）：跳过遮罩，保持元素原样 */
      }
    };

    /** 模板层：按当前帧条目，把各元素（先缓冲后遮罩）按 z 叠到输出画布 */
    const drawTemplateLayer = (
      frameIdx: number,
      scale: number,
      outW: number,
      outH: number
    ): boolean => {
      const defs = cfg?.src ?? [];
      if (!cfg || !defs.length || !(cfg.frame ?? []).length) return false; // 无模板
      const fr = pickFrameTemplate(cfg, frameIdx);
      if (!fr) return true; // 有模板但当前帧还没有布局（特效尚未到该阶段）：不画默认区域
      const objs = [...fr.obj].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
      for (const o of objs) {
        if (!o?.frame) continue;
        const def = defs.find((d) => d.srcId === o.srcId);
        const kind = classifySrc(def);
        if (kind === "unknown") continue;
        // frame 是 RGB 画面区坐标 → 乘 scale 得到输出坐标
        const dw = Math.round(o.frame[2] * scale);
        const dh = Math.round(o.frame[3] * scale);
        if (dw <= 0 || dh <= 0) continue;
        const dx = Math.round(o.frame[0] * scale);
        const dy = Math.round(o.frame[1] * scale);
        if (dx >= outW || dy >= outH || dx + dw <= 0 || dy + dh <= 0) continue; // 完全移出画布
        const buf = getBuffer(`${o.srcId}`, dw, dh);
        if (!buf) continue;
        if (kind === "avatar") drawAvatarInto(buf.ctx, dw, dh);
        else drawTextInto(buf.ctx, dw, dh, def);
        if (o.mFrame) applyMask(buf, o.mFrame);
        ctx.drawImage(buf.canvas, dx, dy);
      }
      return true;
    };

    /** 默认层（JSON 无模板时）：昵称画在默认长条 + 头像圆画在其左端 */
    const drawDefaultLayer = (outW: number, outH: number) => {
      const rect: [number, number, number, number] = [
        Math.round(DEFAULT_BAR.x * outW),
        Math.round((DEFAULT_BAR.y - DEFAULT_BAR.h / 2) * outH),
        Math.round(DEFAULT_BAR.w * outW),
        Math.round(DEFAULT_BAR.h * outH),
      ];
      const buf = getBuffer("__default_text", rect[2], rect[3]);
      if (buf) {
        drawTextInto(buf.ctx, rect[2], rect[3], undefined);
        ctx.drawImage(buf.canvas, rect[0], rect[1]);
      }
      const d = rect[3] * AVATAR_DIAMETER_RATIO;
      const cx = rect[0] - rect[3] * AVATAR_GAP_RATIO - d / 2;
      const cy = rect[1] + rect[3] / 2;
      const ab = getBuffer("__default_avatar", Math.round(d), Math.round(d));
      if (ab) {
        ab.ctx.save();
        ab.ctx.beginPath();
        ab.ctx.arc(ab.canvas.width / 2, ab.canvas.height / 2, ab.canvas.width / 2, 0, Math.PI * 2);
        ab.ctx.closePath();
        ab.ctx.clip();
        drawAvatarInto(ab.ctx, ab.canvas.width, ab.canvas.height);
        ab.ctx.restore();
        ctx.drawImage(ab.canvas, Math.round(cx - d / 2), Math.round(cy - d / 2));
      }
    };

    const renderFrame = () => {
      if (ended) return;
      if (video.readyState < 2) {
        raf = requestAnimationFrame(renderFrame);
        return;
      }

      const info = cfg?.info;
      if (!info) {
        // 无配套 JSON：整段绘制（回退方案，无模板层）
        const w = video.videoWidth || 720;
        const h = video.videoHeight || 720;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          setNatural({ w, h });
          onMeasureRef.current?.(w);
        }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(video, 0, 0, w, h);
      } else {
        const [rx, ry, rw, rh] = info.rgbFrame;
        const [ax, ay, aw, ah] = info.aFrame;
        const scale = info.scale || 1;
        const outW = Math.max(1, Math.round(info.w * scale));
        const outH = Math.max(1, Math.round(info.h * scale));
        if (canvas.width !== outW || canvas.height !== outH) {
          canvas.width = outW;
          canvas.height = outH;
          setNatural({ w: outW, h: outH });
          onMeasureRef.current?.(outW);
        }

        // 2. 取 alpha 区 R 通道写 alpha（透明区尺寸即输出尺寸，逐像素同 GiftEffect）。
        //    RGB 也先画进离屏帧缓冲：主画布（上屏）不做 getImageData，避免 GPU 回读同步；
        //    所有缓冲只在尺寸变化时重建，逐帧零新建。
        let composed = false;
        try {
          if (!alphaCtx || alphaCanvas.width !== aw || alphaCanvas.height !== ah) {
            alphaCanvas.width = aw;
            alphaCanvas.height = ah;
            alphaCtx = alphaCanvas.getContext("2d", { willReadFrequently: true });
          }
          if (frameCanvas.width !== outW || frameCanvas.height !== outH) {
            frameCanvas.width = outW;
            frameCanvas.height = outH;
            frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });
          }
          if (alphaCtx && frameCtx) {
            alphaCtx.clearRect(0, 0, aw, ah);
            alphaCtx.drawImage(video, ax, ay, aw, ah, 0, 0, aw, ah);
            const alphaData = alphaCtx.getImageData(0, 0, aw, ah);
            frameCtx.clearRect(0, 0, outW, outH);
            frameCtx.drawImage(video, rx, ry, rw, rh, 0, 0, outW, outH);
            const frameData = frameCtx.getImageData(0, 0, outW, outH);
            const ad = alphaData.data;
            const fd = frameData.data;
            // 最近的 alpha 行/列下标预先算好，内层循环只做查表
            const rowMap = new Int32Array(outH);
            for (let y = 0; y < outH; y++) rowMap[y] = Math.min(ah - 1, Math.floor((y / outH) * ah)) * aw;
            const colMap = new Int32Array(outW);
            for (let x = 0; x < outW; x++) colMap[x] = Math.min(aw - 1, Math.floor((x / outW) * aw)) * 4;
            for (let y = 0; y < outH; y++) {
              const rowBase = rowMap[y];
              let idx = y * outW * 4 + 3;
              for (let x = 0; x < outW; x++, idx += 4) {
                fd[idx] = ad[rowBase + colMap[x]];
              }
            }
            frameCtx.putImageData(frameData, 0, 0);
            ctx.clearRect(0, 0, outW, outH);
            ctx.drawImage(frameCanvas, 0, 0);
            composed = true;
          }
        } catch {
          /* 跨域读像素失败：保持 RGB 原样绘制（掩膜与合成退化） */
        }
        // 1'. 合成失败（跨域污染等）时直接铺 RGB，至少画面正确
        if (!composed) {
          ctx.clearRect(0, 0, outW, outH);
          ctx.drawImage(video, rx, ry, rw, rh, 0, 0, outW, outH);
        }

        // 3. 模板层（头像/昵称）：帧号取 0 基视频帧序号，对应 JSON frame[].i
        const fps = info.fps || 30;
        const frameIdx = Math.floor(video.currentTime * fps + 1e-3);
        if (!drawTemplateLayer(frameIdx, scale, outW, outH)) drawDefaultLayer(outW, outH);
      }

      raf = requestAnimationFrame(renderFrame);
    };

    const onLoaded = () => {
      video.play().catch(() => finish());
      if (loadTimer) {
        clearTimeout(loadTimer);
        loadTimer = null;
      }
      raf = requestAnimationFrame(renderFrame);
    };

    // 本地缓存地址不可用（例如纯 Web 环境下没有 /api/video）：回退 CDN 直链重试一次
    let usingFallback = false;
    const onError = () => {
      if (!usingFallback && fallbackSrc && fallbackSrc !== src) {
        usingFallback = true;
        video.src = fallbackSrc;
        video.load();
        return;
      }
      finish();
    };

    video.addEventListener("ended", finish);
    video.addEventListener("error", onError);
    video.addEventListener("loadedmetadata", onLoaded);
    video.load();

    loadTimer = setTimeout(finish, LOAD_TIMEOUT_MS);

    return () => {
      ended = true;
      if (loadTimer) clearTimeout(loadTimer);
      video.removeEventListener("ended", finish);
      video.removeEventListener("error", onError);
      video.removeEventListener("loadedmetadata", onLoaded);
      if (raf) cancelAnimationFrame(raf);
      video.pause();
      video.src = "";
      buffers.clear();
    };
  }, [src, json, fetched, loop, user.uname, user.face, fallbackSrc]);

  const style: React.CSSProperties | undefined = cssWidth
    ? {
        width: cssWidth,
        height: natural ? Math.round((cssWidth * natural.h) / natural.w) : undefined,
      }
    : undefined;

  return (
    <canvas
      ref={canvasRef}
      style={style}
      className={`block transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
    />
  );
}
