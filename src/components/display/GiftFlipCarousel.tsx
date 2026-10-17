"use client";

/**
 * 礼物翻卡/礼物抽奖 —— 3D 轮转卡片（画布渲染 + 面板实时预览共用）。
 *
 * 待机形态参照公开实现 slider_3d（HoanghoDev/youtube_v2）：
 *   一圈卡片围成圆柱、绕 Y 轴匀速旋转，整体略微 rotateX 倾斜，卡片带透视景深。
 *   轮转中心常驻礼物图标（= 主播选定的触发礼物图标），作为圆柱的"轴"被围在环中。
 *
 * 触发（play 下发）后的动画分镜：
 *   spin（旋转到目标卡）→ flash（目标卡闪烁）→ pop（卡片放大飘到画布中心、露出卡背）
 *   → flip（翻面解密，露出图片/选项文字 + 粉丝头像）→ hold（停留展示）→ restore（复位）。
 *   本组件只负责"环形背景 + 中心礼物图标"的旋转与闪烁；放大/翻面揭晓的卡片由外部
 *   GiftFlipReveal 在画布（或面板预览舞台）中心渲染（保证无论环形放在何处都能居中展示）。
 *   阶段变化通过 onPhase 上报（active=null 表示回到待机），onDone 在复位回待机时回调。
 *
 * 该旋转变为逐帧驱动（rAF 手动积分 + 缓动），便于精确停在目标角度、并可与待机旋转无缝衔接。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GiftFlipOption, GiftFlipPhase } from "@/lib/display/types";

/** 舞台基准尺寸（画布中按 MovableBox 的 scale 整体缩放） */
export const GIFT_FLIP_STAGE = { w: 900, h: 600 };
/** 单张卡片宽度上限 / 下限（卡片多时自动收窄，但保证最小可读宽度） */
const CARD_MAX_W = 180;
const CARD_MIN_W = 96;
/** 卡片高宽比（略偏窄高的竖卡，缝隙观感更清晰；取适中值，不过分窄高） */
const CARD_RATIO = 1.32;
/** 相邻卡片之间的最小缝隙（px）——保证礼物图标始终能透过缝隙看到 */
const GAP_MIN = 30;
/** 圆柱半径下限/上限（按卡牌数取"刚好留出缝隙"的半径，过多时封顶避免整体过大） */
const RADIUS_MIN = 300;
const RADIUS_MAX = 460;
/** 整体俯视程度（竖直错位量 = 系数 × 半径 × cos(卡片当前世界角度)）。
 *  只按深度做竖直平移、**不给单张卡片加 rotateX**，从而整体呈俯视、卡片仍正对镜头不失真。 */
const TILT_FACTOR = 0.26;
/** 后排（cos<0，即"深处"）额外压低系数：避免深处的卡片被抬得过高，单独再降一档 */
const BACK_TILT_DAMP = 0.8;
/** 圆柱整体下移量（0 = 环心即舞台中心，中心礼物图标落在正中） */
const RING_SHIFT_Y = 0;
/** 透视距离 */
const PERSPECTIVE = 2000;
/** 舞台四周预留边距（计算整体缩放用，保证卡片完全可见、不被裁切） */
const EDGE_PAD = 18;
/** 待机自转角速度（度/秒） */
const IDLE_SPEED = 24;
/** 中心礼物图标尺寸（在环的 3D 上下文内，随环整体缩放） */
const HUB_ICON = 220;
/** 中心礼物数量「×N」字号（与图标同比例放大） */
const HUB_COUNT_FONT = 104;
/** 中心礼物数量「×N」相对图标中心的竖直上移量（px）：略微上移、不与其竖直对齐，更易从缝隙透出 */
const HUB_COUNT_LIFT = 26;

/** 分镜时长（ms） */
const SPIN_MS = 1300;
const FLASH_MS = 750;
const POP_MS = 720;
const FLIP_MS = 760;
const HOLD_MS = 2700;
const RESTORE_MS = 680;

/** 翻牌过程中环形背景整体"变暗"程度（逐卡降透明度；不对 preserve-3d 容器直接降 opacity，
 *  否则会触发扁平化、使 3D 阵列塌成平面） */
const DIM_OPACITY = 0.3;

/** 一次翻卡：归属粉丝 + 命中的选项下标 */
export interface GiftFlipPlay {
  fan: { uid: number; uname: string; face: string };
  optionIndex: number;
}

/** 面板预览用的示例粉丝（真实触发由主进程下发） */
const DEMO_FAN = { uid: 0, uname: "示例观众", face: "" };

/** 选项 → 卡片底色（未配图片时的纯色卡片；按序号取色相，保证每张颜色不同） */
function optionColor(i: number, n: number, light = 52): string {
  const hue = Math.round((i * 360) / Math.max(1, n));
  return `hsl(${hue} 62% ${light}%)`;
}

/** 选项文字自适应字号：字数越少越大，使文字成为卡片主体；并随卡片宽度等比缩放。 */
function flipCardTextSize(text: string, cardW: number): number {
  const n = Array.from(text).length;
  const base =
    n <= 1 ? 78 : n <= 2 ? 66 : n <= 4 ? 52 : n <= 6 ? 42 : n <= 8 ? 34 : n <= 10 ? 30 : 26;
  return Math.max(14, Math.round((base * cardW) / 210));
}

/** 洗牌：返回 0..n-1 的一个随机排列（slot → optionIndex 的映射） */
function shufflePerm(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 单张卡片的 3D 变换（每帧按当前环角度重算）。
 *
 * 关键：竖直错位取"卡片**当前世界角度** `i·step + deg` 的 cos"，而不是卡片初始槽位角度。
 * 环整体按 rotateY(deg) 自转，卡片 i 的世界角度随之变化；因此同一张卡片在转到前侧时下移、
 * 转到后侧时上移——**轨迹（椭圆路径）固定，卡片沿轨迹移动**，而不是每张卡各自钉死在某个高度。
 * 卡片自身不加 rotateX（保持正对镜头不失真），整圈的俯视感完全由这层竖直错位营造。
 */
function itemTransform(i: number, deg: number, radius: number, step: number): string {
  const rad = ((i * step + deg) * Math.PI) / 180;
  const c = Math.cos(rad);
  // 前排（c>0）下移、后排（c<0，深处）上移；后排额外乘 BACK_TILT_DAMP，使其不要抬得过高
  const y = Math.round(radius * c * TILT_FACTOR * (c < 0 ? BACK_TILT_DAMP : 1));
  return `translateY(${y}px) rotateY(${i * step}deg) translateZ(${radius}px)`;
}

/** 卡片正面内容（图片/纯色底 + 可选文字），轮转卡片共用 */
function CardVisual({
  option,
  index,
  count,
  cardW,
  showText,
}: {
  option: GiftFlipOption;
  index: number;
  count: number;
  cardW: number;
  showText: boolean;
}) {
  return (
    <div
      className="gfcar-card"
      style={{
        background: option.image
          ? "#1b1b22"
          : `linear-gradient(150deg, ${optionColor(index, count, 58)}, ${optionColor(index, count, 40)})`,
      }}
    >
      {option.image ? <img className="gfcar-card-img" src={option.image} alt="" /> : null}
      {showText && option.text ? (
        <>
          <div className="gfcar-scrim" />
          <div className="gfcar-text" style={{ fontSize: flipCardTextSize(option.text, cardW) }}>
            {option.text}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function GiftFlipCarousel({
  options,
  giftImg,
  giftCount,
  showText,
  lockMapping,
  play,
  onDone,
  onPhase,
  demoIntervalMs = 0,
}: {
  options: GiftFlipOption[];
  /** 轮转中心的礼物图标（空则显示占位） */
  giftImg: string;
  /** 触发所需数量：显示在中心图标下方的「×N」 */
  giftCount: number;
  /** 待机时是否在卡片上显示选项文字（翻牌揭晓文字由 GiftFlipReveal 显示，与此开关无关） */
  showText: boolean;
  /** 图片与选项固定：true=一一对应不变；false=每局随机洗牌打乱对应关系 */
  lockMapping: boolean;
  /** 待播放的翻卡（带 seq 便于重复触发）；null = 待机轮转 */
  play?: (GiftFlipPlay & { seq: number }) | null;
  /** 一次翻卡动画播完回调（画布据此回执 giftFlipDone） */
  onDone?: (p: GiftFlipPlay) => void;
  /** 分镜阶段上报（active=null 表示待机）——供外部在舞台中心渲染揭晓卡 */
  onPhase?: (phase: GiftFlipPhase, active: GiftFlipPlay | null) => void;
  /** >0 时按该间隔自动试翻（面板实时预览用） */
  demoIntervalMs?: number;
}) {
  const count = Math.max(1, options.length);
  // 圆柱半径：取"恰好让相邻卡片留出 GAP_MIN 缝隙"的半径（卡牌多 → 半径大），并封顶
  const radius = useMemo(() => {
    const sin = Math.sin(Math.PI / Math.max(3, count));
    const need = (CARD_MAX_W + GAP_MIN) / (2 * sin);
    return Math.round(Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, need)));
  }, [count]);
  // 卡片宽度：卡牌增多时自动收窄，保证相邻卡片始终留有至少 GAP_MIN 的缝隙（不设下限到 0）
  const cardW = useMemo(() => {
    const chord = 2 * radius * Math.sin(Math.PI / Math.max(3, count));
    return Math.round(Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, chord - GAP_MIN)));
  }, [radius, count]);
  const cardH = Math.round(cardW * CARD_RATIO);
  const step = 360 / count;

  // 整体缩放：保证环形（含透视放大后的最外沿，横向与纵向）完全落在舞台内，不被裁切
  const fit = useMemo(() => {
    const halfW = GIFT_FLIP_STAGE.w / 2 - EDGE_PAD;
    const halfH = GIFT_FLIP_STAGE.h / 2 - EDGE_PAD;
    const proj = PERSPECTIVE / Math.max(1, PERSPECTIVE - radius);
    const extentX = (radius + cardW / 2) * proj;
    const extentY = (radius * TILT_FACTOR + cardH / 2) * proj;
    return Math.min(1, halfW / extentX, halfH / extentY);
  }, [radius, cardW, cardH]);

  // slot → optionIndex 映射：固定模式恒为恒等；洗牌模式每局（begin）重洗
  const [permState, setPermState] = useState<number[]>([]);
  const perm = useMemo(() => {
    const identity = options.map((_, i) => i);
    if (lockMapping || permState.length !== options.length) return identity;
    return permState;
  }, [lockMapping, options, permState]);

  const [phase, setPhase] = useState<GiftFlipPhase>("idle");
  const [target, setTarget] = useState(0);

  const phaseRef = useRef<GiftFlipPhase>("idle");
  const activeRef = useRef<GiftFlipPlay | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  const onPhaseRef = useRef(onPhase);
  useEffect(() => {
    onPhaseRef.current = onPhase;
  }, [onPhase]);

  // —— 逐帧旋转（rAF）：待机匀速自转 / spin 阶段缓动到目标角度；中心礼物图标反向旋转保持正对镜头 ——
  const ringRef = useRef<HTMLDivElement | null>(null);
  const hubRef = useRef<HTMLDivElement | null>(null);
  const rotRef = useRef(0);
  const animRef = useRef<{ from: number; to: number; t0: number } | null>(null);
  const fitRef = useRef(1);
  // 逐卡 DOM 引用 + 几何参数引用：rAF 每帧按"卡片当前世界角度"重算竖直错位（见 itemTransform）
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const radiusRef = useRef(radius);
  const stepRef = useRef(step);
  const countRef = useRef(count);
  const applyRef = useRef<(deg: number) => void>(() => {});

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const apply = (deg: number) => {
      const ring = ringRef.current;
      if (ring) {
        // 无 rotateX：卡片各自保持正对镜头；俯视感完全由逐卡竖直错位（见下）营造
        ring.style.transform = `scale(${fitRef.current}) perspective(${PERSPECTIVE}px) rotateY(${deg}deg)`;
      }
      // 逐卡按"当前世界角度 i·step + deg"重算竖直错位：卡片沿固定椭圆轨迹上下起伏
      const items = itemRefs.current;
      const n = countRef.current;
      const r = radiusRef.current;
      const s = stepRef.current;
      for (let i = 0; i < n; i++) {
        const el = items[i];
        if (el) el.style.transform = itemTransform(i, deg, r, s);
      }
      const hub = hubRef.current;
      if (hub) {
        // 反向旋转抵消环的自转：图标始终正对镜头、固定在环心（z=0，即旋转轴上），
        // 前侧卡片从其前方掠过 → 透过卡片缝隙看到图标（源库 .model/.slider 的层叠关系）。
        hub.style.transform = `rotateY(${-deg}deg)`;
      }
    };
    applyRef.current = apply;
    apply(rotRef.current);
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const a = animRef.current;
      if (a) {
        const p = Math.min(1, (now - a.t0) / SPIN_MS);
        const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
        rotRef.current = a.from + (a.to - a.from) * e;
        apply(rotRef.current);
        if (p >= 1) {
          animRef.current = null;
          setPhase("flash");
        }
      } else if (phaseRef.current === "idle") {
        rotRef.current += IDLE_SPEED * dt;
        apply(rotRef.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      applyRef.current = () => {};
    };
  }, []);

  // 几何参数变化（卡片数/半径/步进/fit）时同步到 ref 并立即重绘画一帧
  useEffect(() => {
    fitRef.current = fit;
    radiusRef.current = radius;
    stepRef.current = step;
    countRef.current = count;
    applyRef.current(rotRef.current);
  }, [fit, radius, step, count]);

  /** 开始一次翻卡（从待机/空闲进入 spin）。 */
  const begin = useCallback(
    (p: GiftFlipPlay) => {
      if (phaseRef.current !== "idle") return;
      const n = Math.max(1, options.length);
      const optIdx = Math.max(0, Math.min(n - 1, Math.floor(p.optionIndex) || 0));
      let slot = optIdx;
      if (!lockMapping) {
        // 洗牌模式：重洗映射，并把"显示该选项的卡位"作为停止目标
        const next = shufflePerm(n);
        setPermState(next);
        const found = next.indexOf(optIdx);
        slot = found >= 0 ? found : optIdx;
      }
      activeRef.current = p;
      setTarget(slot);
      setPhase("spin");
    },
    [options.length, lockMapping],
  );

  // 外部下发的一次翻卡（画布：主进程 giftFlip 事件；seq 变化即触发）
  const lastSeqRef = useRef(-1);
  const playSeq = play?.seq ?? -1;
  useEffect(() => {
    if (!play || playSeq === lastSeqRef.current) return;
    lastSeqRef.current = playSeq;
    begin(play);
  }, [play, playSeq, begin]);

  // 面板预览：按间隔自动试翻（仅待机时触发）
  useEffect(() => {
    if (demoIntervalMs <= 0) return;
    const t = setInterval(() => {
      begin({ fan: DEMO_FAN, optionIndex: Math.floor(Math.random() * count) });
    }, demoIntervalMs);
    return () => clearInterval(t);
  }, [demoIntervalMs, count, begin]);

  // 进入 spin：算出"把目标卡片转到正前方"的角度（额外多转两圈，衔接更自然）
  useEffect(() => {
    if (phase !== "spin") return;
    const cur = rotRef.current;
    const want = (((-target * step) % 360) + 360) % 360;
    const delta = ((want - cur) % 360 + 360) % 360;
    animRef.current = { from: cur, to: cur + 720 + delta, t0: performance.now() };
  }, [phase, target, step]);

  // 分镜推进（spin 的收尾由 rAF 回调触发 flash）
  useEffect(() => {
    const after = (ms: number, next: GiftFlipPhase) => {
      const t = setTimeout(() => setPhase(next), ms);
      return () => clearTimeout(t);
    };
    if (phase === "flash") return after(FLASH_MS, "pop");
    if (phase === "pop") return after(POP_MS, "flip");
    if (phase === "flip") return after(FLIP_MS, "hold");
    if (phase === "hold") return after(HOLD_MS, "restore");
    if (phase === "restore") {
      return after(RESTORE_MS, "idle");
    }
  }, [phase]);

  // 分镜回到 idle：回调 onDone（画布回执；面板预览无 onDone）。
  // active 状态不必清空（揭晓卡可见性由 phase 决定），只需清掉 ref 以免同一轮重复回调。
  useEffect(() => {
    if (phase !== "idle") return;
    const p = activeRef.current;
    if (!p) return;
    activeRef.current = null;
    onDoneRef.current?.(p);
  }, [phase]);

  // 阶段上报（供外部揭晓卡渲染）：active=null 表示待机
  useEffect(() => {
    onPhaseRef.current?.(phase, phase === "idle" ? null : activeRef.current);
  }, [phase]);

  // 卡片内容（按槽位取对应选项）。竖直错位/旋转由 rAF 每帧写入 DOM（见 itemTransform），
  // 故此处不再产出静态 transform——否则卡片会各自钉死在某个高度、不随转动变化。
  const items = useMemo(
    () => perm.map((optIdx) => options[optIdx] ?? { text: "", image: "" }),
    [perm, options],
  );

  // 翻牌分镜（pop/flip/hold/restore）期间环形背景逐卡变暗，其余时间全亮
  const dim = phase === "pop" || phase === "flip" || phase === "hold" || phase === "restore";

  return (
    <div className="gfcar" style={{ width: GIFT_FLIP_STAGE.w, height: GIFT_FLIP_STAGE.h }}>
      {/* 3D 圆柱卡片组；中心礼物图标作为环的"轴"放在 ring 内部（z=0，即旋转轴上）、
          逐帧反向旋转使其正对镜头——前侧卡片从其前方掠过，图标从卡片缝隙中透出（源库做法）。 */}
      <div
        ref={ringRef}
        className="gfcar-ring"
        style={{
          left: Math.round((GIFT_FLIP_STAGE.w - cardW) / 2),
          top: Math.round((GIFT_FLIP_STAGE.h - cardH) / 2) + RING_SHIFT_Y,
          width: cardW,
          height: cardH,
        }}
      >
        {/* 轮转中心的礼物图标 + 需要的数量「×N」：图标与数量作为**一个整体**居中（数量不再
            偏向右侧、不会碰到右侧卡片）；数量为 1 时不显示 */}
        <div ref={hubRef} className="gfcar-hub">
          <div className="gfcar-hub-group">
            <div className="gfcar-hub-iconwrap" style={{ width: HUB_ICON, height: HUB_ICON }}>
              <div className="gfcar-hub-glow" />
              {giftImg ? (
                <img className="gfcar-hub-img" src={giftImg} alt="" />
              ) : (
                <div className="gfcar-hub-ph">待设置礼物</div>
              )}
            </div>
            {giftCount > 1 ? (
              <div
                className="gfcar-hub-count"
                style={{ fontSize: HUB_COUNT_FONT, transform: `translateY(-${HUB_COUNT_LIFT}px)` }}
              >
                ×{giftCount}
              </div>
            ) : null}
          </div>
        </div>

        {items.map((opt, i) => (
          <div
            key={i}
            ref={(el) => {
              itemRefs.current[i] = el;
              // 挂载/重渲染后先按当前环角度落位，随后由 rAF 每帧接管
              if (el) el.style.transform = itemTransform(i, rotRef.current, radius, step);
            }}
            className="gfcar-item"
          >
            <div
              className={`gfcar-item-inner${phase === "flash" && i === target ? " gfcar-blink" : ""}`}
              style={{ opacity: dim ? DIM_OPACITY : 1 }}
            >
              <CardVisual option={opt} index={i} count={count} cardW={cardW} showText={showText} />
            </div>
          </div>
        ))}
      </div>

      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.gfcar { position: relative; overflow: hidden; }
.gfcar-ring { position: absolute; transform-style: preserve-3d; will-change: transform; }
.gfcar-item { position: absolute; inset: 0; }
.gfcar-item-inner { position: absolute; inset: 0; transition: opacity .55s ease; }
.gfcar-card {
  position: absolute; inset: 0; border-radius: 18px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 12px 30px rgba(0,0,0,.4), inset 0 0 0 2px rgba(255,255,255,.22);
}
.gfcar-card-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.gfcar-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,.78), rgba(0,0,0,.42) 45%, rgba(0,0,0,.52));
}
.gfcar-text {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 14px 12px; text-align: center; color: #fff;
  font-weight: 800; line-height: 1.12; letter-spacing: 1px;
  text-shadow: 0 2px 10px rgba(0,0,0,.92), 0 0 4px rgba(0,0,0,.95);
  word-break: break-word; overflow-wrap: anywhere;
}
/* 中心礼物图标 + 数量：ring 的子节点、整体居中于环心（z=0 即旋转轴上），逐帧反向旋转正对镜头 */
.gfcar-hub {
  position: absolute; inset: 0; transform-origin: center center;
  display: flex; align-items: center; justify-content: center;
}
.gfcar-hub-group { position: relative; display: flex; align-items: center; justify-content: center; }
.gfcar-hub-iconwrap { position: relative; display: flex; align-items: center; justify-content: center; flex: none; }
.gfcar-hub-glow {
  position: absolute; left: 50%; top: 50%; width: 380px; height: 380px;
  margin-left: -190px; margin-top: -190px; border-radius: 9999px;
  background: radial-gradient(circle, rgba(255,214,102,.55) 0%, rgba(255,170,60,.22) 42%, rgba(255,170,60,0) 72%);
  animation: gfcar-breathe 3.2s ease-in-out infinite;
}
.gfcar-hub-img {
  position: relative; width: 100%; height: 100%; object-fit: contain;
  filter: drop-shadow(0 6px 22px rgba(0,0,0,.6));
  animation: gfcar-float 3.2s ease-in-out infinite;
}
.gfcar-hub-count {
  flex: none; margin-left: 18px;
  color: #ffd24a; font-weight: 900;
  letter-spacing: 1px; line-height: 1; white-space: nowrap;
  text-shadow: 0 3px 12px rgba(0,0,0,.92), 0 0 12px rgba(255,170,40,.75);
}
.gfcar-hub-ph {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 78%; height: 78%; border-radius: 22px;
  border: 3px dashed rgba(255,255,255,.55); color: rgba(255,255,255,.85);
  font-size: 22px; font-weight: 700; letter-spacing: 2px;
  background: rgba(0,0,0,.28); text-shadow: 0 2px 8px rgba(0,0,0,.7);
}
.gfcar-item-inner.gfcar-blink { animation: gfcar-blink .75s ease-in-out; }
@keyframes gfcar-blink {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,214,102,0); transform: scale(1); filter: brightness(1); }
  45% { box-shadow: 0 0 46px 14px rgba(255,214,102,.95); transform: scale(1.14); filter: brightness(1.45) saturate(1.25); }
}
@keyframes gfcar-breathe {
  0%, 100% { opacity: .78; transform: scale(.94); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes gfcar-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
}
`;
