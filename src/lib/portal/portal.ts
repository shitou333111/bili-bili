import { GLRenderer } from "./renderer";
import { SPARK_TUNING, SparkSystem } from "./sparks";
import { clamp01, easeInCubic, easeOutQuint } from "./easing";
import type { RenderState } from "./types";

/**
 * 相位时间轴（沿用 SlingTab tools/tune.html 的取值；描圈点火加长以呈现「画圈」过程）：
 *   描圈点火 1200ms（头部沿圆周画出火线，参考 gif/portal-test.html 的 draw 阶段）→
 *   圈内展开 180ms → 悬停 2600ms → 消散 380ms
 * 只跑一次，不做导航专用的 GAP/COMMIT 相位。
 */
const T_IGNITE = 1200;
const T_OPEN = 180;
const T_HOLD = 2600;
const T_DISSIPATE = 380;

/* ── 描圈螺旋曲线（portal-test.html / Unity PortalSpawner 一比一）──────────────
 * spawnCurve：半径随画圈进度的 AnimationCurve 关键帧（MainScene.unity 序列化值）。
 *  画圈全程半径一直在长大：p=0.35 → 0.47R，p=0.5 → 0.74R，p=0.73 → 0.95R。
 */
const SPAWN_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.3494407, 0.46650183], [0.49726176, 0.73789155],
  [0.72724634, 0.9490911], [1, 1],
];
function spawnCurve(p: number): number {
  if (p <= 0) return 0;
  for (let i = 1; i < SPAWN_CURVE.length; i++) {
    if (p <= SPAWN_CURVE[i][0]) {
      const [t0, v0] = SPAWN_CURVE[i - 1];
      const [t1, v1] = SPAWN_CURVE[i];
      return v0 + ((p - t0) / (t1 - t0)) * (v1 - v0);
    }
  }
  return 1;
}
/** 头部加速：rotationSpeed = clamp(p*2.1, 1, 2.1) 对应的归一化扫角（先慢后快，像越画越顺） */
function traceProgress(p: number): number {
  const MAX_ROT = 2.1;
  const p0 = 1 / MAX_ROT; // 加速起点
  const total = p0 + MAX_ROT * (1 - p0 * p0) / 2; // ∫rotSpeed dp，归一化分母
  return p <= p0 ? p / total : (p0 + MAX_ROT * (p * p - p0 * p0) / 2) / total;
}

export interface PortalFXCallbacks {
  /**
   * 圈内内容的可见度 0..1：OPEN 阶段渐显、HOLD 保持、DISSIPATE 阶段渐隐。
   * 头像与昵称胶囊同步跟随此值。
   */
  onOpen?: (open: number) => void;
  /** 整个序列（含消散）结束时触发一次。 */
  onDone?: () => void;
}

/**
 * 轻量相位驱动：一个 canvas + 火花系统，IGNITE→OPEN→HOLD→DISSIPATE 跑一轮。
 * 对外只有 start/stop/dispose，无手势、无点击、无导航控制。
 */
export class PortalFX {
  private renderer: GLRenderer;
  private sparks = new SparkSystem();
  private raf = 0;
  private t0 = 0;
  private last = 0;
  private done = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private geo: { cx: number; cy: number; radius: number },
    private cb: PortalFXCallbacks = {},
  ) {
    this.renderer = new GLRenderer(canvas);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.renderer.resize(cssWidth, cssHeight, dpr);
  }

  start(): void {
    this.stop();
    this.t0 = performance.now();
    this.last = this.t0;
    this.done = false;
    this.cb.onOpen?.(0);
    const loop = (now: number): void => {
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.renderer.dispose();
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    const { cx, cy, radius } = this.geo;
    const elapsed = now - this.t0;

    let open = 0;
    let energy = 1;
    let dissipate = 0;
    let liveRadius = radius;
    // 描圈进度（shader uProgress/uStartAngle/uDir）：IGNITE 从 0 画到 1，之后保持全环
    let progress = 1;
    const startAngle = -Math.PI / 2; // 顶部起笔
    const direction = 1;

    if (elapsed < T_IGNITE) {
      // 画圈：进度沿圆周描出火线（shader arc mask + 前沿亮头）。
      // 半径按 Unity spawnCurve 关键帧全程螺旋长大：0.2R 起笔 → p=0.35 时 0.47R → 满径，
      // 头部角速度随进度加速（rotationSpeed = clamp(p*2.1, 1, 2.1) 的归一化扫角）。
      const t = clamp01(elapsed / T_IGNITE);
      const curve = spawnCurve(t);
      progress = traceProgress(t);
      liveRadius = Math.max(2, radius * Math.max(0.2, curve));
      energy = 0.25 + 0.75 * curve;
      // 画线头部（前沿）喷火花，发射率随 spawnCurve 增长（Unity: rate*curve，下限 0.3）
      const headAngle = startAngle + direction * progress * Math.PI * 2;
      const rimSpeed = (radius / (T_IGNITE / 1000)) * (1 - t) * 0.55;
      this.sparks.emitAtRimRate(
        cx, cy, liveRadius, headAngle, direction,
        SPARK_TUNING.rateIgnite * Math.max(0.3, curve), dt,
        SPARK_TUNING.igniteSpeed + rimSpeed, SPARK_TUNING.igniteSpread,
      );
      // 沿已画出的弧撒慢速余烬，形成拖尾亮线（只在描圈过半后开始，避免起笔处堆积）
      if (progress > 0.35) {
        this.sparks.emitAlongArc(
          cx, cy, liveRadius, startAngle, progress * Math.PI * 2, direction,
          SPARK_TUNING.rateIgnite * 0.5, dt,
        );
      }
    } else if ((elapsed - T_IGNITE) < T_OPEN) {
      // 展开：圈内内容（头像/昵称）由小到大渐显。
      const t = clamp01((elapsed - T_IGNITE) / T_OPEN);
      open = easeOutQuint(t);
      this.shed(dt, SPARK_TUNING.rateOpen);
    } else if ((elapsed - T_IGNITE - T_OPEN) < T_HOLD) {
      // 悬停：火圈稳定燃烧，圈内内容完全可见。
      open = 1;
      this.shed(dt, SPARK_TUNING.rateHold);
    } else if ((elapsed - T_IGNITE - T_OPEN - T_HOLD) < T_DISSIPATE) {
      // 消散：火圈吹散，圈内内容同步渐隐。
      const t = elapsed - T_IGNITE - T_OPEN - T_HOLD;
      if (t < 20) this.sparks.emitBurst(cx, cy, radius, 520, 300);
      const d = clamp01(t / T_DISSIPATE);
      open = 1 - easeInCubic(d);
      dissipate = d;
      energy = 1 - d;
    } else {
      energy = 0;
      open = 0;
    }

    this.sparks.update(dt);
    this.cb.onOpen?.(open);

    const state: RenderState = {
      timeSec: (now - this.t0) / 1000,
      cx,
      cy,
      radius: liveRadius,
      progress,
      startAngle,
      direction,
      energy,
      spin: ((now - this.t0) / 1000) * 0.15,
      dissipate,
    };
    this.renderer.render(state, this.sparks);

    const seqDone = elapsed >= T_IGNITE + T_OPEN + T_HOLD + T_DISSIPATE;
    if (seqDone) {
      // 相位序列已结束：energy=0/open=0（else 分支），残余火花继续自然衰减渲染，
      // 直到全部熄灭才触发 onDone 并停帧——若此处立即 stop 会把最后一帧冻结在画布上。
      if (this.sparks.count > 0) {
        this.done = true;
      } else if (!this.done) {
        this.done = true;
        this.stop();
        this.cb.onDone?.();
      }
    }
  }

  private shed(dt: number, rate: number): void {
    const { cx, cy, radius } = this.geo;
    this.sparks.emitAtRimRate(
      cx, cy, radius, Math.random() * Math.PI * 2, 1,
      rate, dt, SPARK_TUNING.shedSpeed, SPARK_TUNING.shedSpread,
    );
  }
}
