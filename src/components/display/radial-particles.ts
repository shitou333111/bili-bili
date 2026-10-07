/**
 * 自研粒子聚散引擎（RadialBadge）—— 入场提示的"四面八方聚散"粒子特效。
 *
 * 【来源】scripts/particle-radial-test.html 右面板（自研新效果）。本文件是其工程化移植：
 *   1. 去掉试验台里的滑块/参数 UI，所有参数由调用方一次性传入（本项目用一套固定参数）；
 *   2. 视觉缩放 VS 从"常量 0.55（试验台用 scene.style.transform 模拟真机缩放）"改为运行时
 *      动态测算，以适配系统里画布整体被缩放（画布 fit scale / CSS zoom / iframe 缩放）的场景；
 *   3. 取色 LUT（BadgeLut）的元素定位从 `.badge/.avatar/.name` 类名查询改为"按 badge 子元素
 *      顺序"（children[0]=头像、children[1]=昵称），从而不必给系统原有的 Avatar / 昵称 JSX
 *      增加任何类名或属性（旧效果代码保持零改动）；
 *   4. 昵称白字的竖直定位改用 fontBoundingBox 度量，精确复刻 CSS `line-height:1` + flex 居中，
 *      因此不需要试验台里那行 `#badge-new .name{transform:translateY(-3px)}` 的 DOM 位移补偿。
 *
 * 【它做什么】一个"状态机 + rAF 驱动"的粒子系统：
 *   - showing（聚合）：粒子在"中心→落点"方向上做各向异性自相似外推，从四面八方凝成 badge；
 *   - hiding（消散）：反向（badge 内 → 向四周扩散）缓慢化开成雾；
 *   - 粒子颜色 = badge 对应像素的真实颜色（离屏重绘 + getImageData 取色网格 LUT）：
 *     胶囊红→黄渐变 / 头像 / 昵称白字都能被粒子忠实还原；LUT 不可用时回退到按 x 映射的红→黄色相。
 *
 * 【调用方职责】提供 {holder, badge, haloIn, canvas} 四个 DOM 引用，并在合适时机调用
 *   setHidden(false)（聚合）/ setHidden(true)（消散）。onComplete 会在每次动画"真正"结束
 *   （粒子全部离场）后回调，参数为刚结束的模式，调用方据此串联"停留 → 消散 → onDone"时序。
 */

/* ============================================================================
 * 类型定义
 * ========================================================================== */

export interface RadialBadgeDom {
  /** 最外层定位容器（自身不含任何缩放/位移变换）：仅用于动态测算祖先视觉缩放 VS */
  holder: HTMLElement;
  /** 承载 badge 外观（渐变/头像/昵称）的元素，同时也是"揭示"（缩放淡入）的作用对象 */
  badge: HTMLElement;
  /** 光晕内层元素（与 badge 同步做揭示）；若无需光晕，可传 badge 自身 */
  haloIn: HTMLElement;
  /** 粒子画布（绝对定位、居中于 holder） */
  canvas: HTMLCanvasElement;
}

export interface RadialBadgeOptions {
  /** 动画时长（ms）：聚合/消散各自的一次时长 */
  duration: number;
  /** 粒子密度系数：生成速率 = coefficient * 133 个/秒 */
  coefficient: number;
  /** 聚合起点距离（× badge 宽度）：越大则雾场越远 */
  inDist: number;
  /** 消散扩散距离（× badge 宽度） */
  outDist: number;
  /** 涡流强度：垂直于飞行方向的正弦偏移幅度系数 */
  spin: number;
  /** 揭示方式：'scale' 缩放淡入 | 'radial' 圆形遮罩 | 'fade' 纯淡入 */
  reveal: "scale" | "radial" | "fade";
  /** 粒子生成速率倍率（只缩放"生成"的时间轴，本项目固定 1） */
  speedFactor: number;
  /** 粒子基础半径（px，设计坐标；实际半径再乘 0.6~1.4 随机数 + 视觉缩放） */
  size: () => number;
  /** 呼吸抖动系数（本项目固定 1） */
  oscillation: number;
  /** 形状指数：2=椭圆，越大越贴近胶囊（圆角矩形） */
  shapePow: number;
  /** 纵向拉伸：把自相似位移的 y 分量放大，让聚散"四面八方"而非只沿水平方向 */
  vStretch: number;
  /** 纵向收口：横向位置越靠两端，纵向位移越小（外扩云呈圆台/胶囊轮廓） */
  vTaper: number;
  /** 每次动画真正结束后的回调，参数 = 刚结束的模式 */
  onComplete?: (finished: "showing" | "hiding") => void;
}

/** 单颗粒子（生成时确定不变量，逐帧写入 dx/dy/r/alpha 供绘制） */
interface Particle {
  kind: "in" | "out";
  born: number;
  life: number;
  /** 归一化起始距离（0=badge 中心，1=雾场最外）：用于"越远越淡"的透明度梯度 */
  offN: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  swirl: number;
  size: number;
  phase: number;
  /** 透明度个体倍率（浓淡错落，更像雾） */
  aMul: number;
  /** 淡入/淡出长尾指数（各粒子错落出现/消失） */
  fadePow: number;
  /** 生成时取自 badge 实际像素的颜色 */
  col: string;
  // ---- 逐帧计算结果 ----
  dx: number;
  dy: number;
  r: number;
  alpha: number;
}

interface GradientStop {
  off: number;
  color: string;
}
interface ParsedGradient {
  angle: number;
  stops: GradientStop[];
}
interface BadgeLutData {
  gw: number;
  gh: number;
  cell: number;
  cols: string[];
  w: number;
  h: number;
}

/* ============================================================================
 * 常量与通用工具
 * ========================================================================== */

/** 新实现同屏粒子硬上限（密度系数较高时留足余量） */
const NEW_CAP = 40000;

/**
 * 消散时 badge「本体」（渐变底 + 头像 + 白字昵称）的淡出跨度，取值 = 占 duration 的比例。
 * reveal 在 t = HIDE_REVEAL_SPAN 处即降到 0，之后的时间里只剩粒子继续外飘。
 * 之所以需要提前淡尽（而非像旧实现那样在整个 duration 上从 1 线性降到 0）：
 * badge 底是带 0.5 alpha 的渐变、白字与头像不带 alpha，二者叠在同一个 reveal opacity 上，
 * 于是白字的视觉强度始终是底的 2 倍；白色对深色直播画面又是最高对比 → 暖色底早已淡没时，
 * 末尾仍会残留一圈白字轮廓，看起来"没真正化成粒子"。
 */
const HIDE_REVEAL_SPAN = 0.7;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** hsl 串缓存（hue 仅 0~60 共 61 种取值；回退色与库补丁 25 同族） */
const HSL: string[] = [];
for (let i = 0; i <= 60; i++) HSL[i] = "hsl(" + i + ",90%,60%)";

/**
 * 形状约束（超椭圆）——"形状"的唯一来源，聚合/消散共用：
 *   rho(dx,dy) = 0 中心、1 形状边界、>1 形状外。
 *   令 ux=|dx|/(w/2)、uy=|dy|/(h/2)，则 rho = (ux^n + uy^n)^(1/n)。
 *   n=2 → 纯椭圆；n 越大两端越饱满，整体越贴近胶囊（圆角矩形）。
 */
function shapeRho(w: number, h: number, dx: number, dy: number, n: number): number {
  const a = Math.max(1e-6, w / 2);
  const b = Math.max(1e-6, h / 2);
  const ux = Math.abs(dx) / a;
  const uy = Math.abs(dy) / b;
  return Math.pow(Math.pow(ux, n) + Math.pow(uy, n), 1 / n);
}

/**
 * 中心加权强度：诞生分布密度 ∝ 1 + CENTER_BIAS*(1-rho)，中心出生量约为边界的 (1+k) 倍。
 * badge 很扁（h 远小于 w），纯面积均匀时"离中心近"的粒子占比很小，且任何向外位移都会先摊薄中心，
 * 于是视觉上近乎"均匀铺满"，感知不到"中心最多"。2.0 → 出生比 3:1，形成明显亮核，
 * 同时两端不至于过稀（消散时不出现"黑洞"）。
 */
const CENTER_BIAS = 2.0;

/**
 * 在超椭圆形状内取点（返回 badge 局部坐标，原点=badge 左上）。两步拒绝采样：
 *   ① 几何拒绝：丢弃 rho>1 的样本 → 均匀铺满整个形状（若按"x 均匀 + y 按带宽均匀"，
 *      联合密度 ∝ 1/band(x)，两端会被超采样，表现为粒子堆在端部）；
 *   ② 深度加权拒绝：接受概率 (1+CENTER_BIAS*(1-rho))/(1+CENTER_BIAS) → 中心最密、边界最稀。
 */
function sampleBadgePoint(w: number, h: number, n: number): [number, number] {
  for (let i = 0; i < 48; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const rho = shapeRho(w, h, x - w / 2, y - h / 2, n);
    if (rho > 1) continue;
    const d = clamp(1 - rho, 0, 1);
    if (Math.random() < (1 + CENTER_BIAS * d) / (1 + CENTER_BIAS)) return [x, y];
  }
  return [w / 2, h / 2]; // 兜底：48 次全落空概率≈1e-27，实际不会发生
}

/* ============================================================================
 * badge 像素取色（离屏重绘 → getImageData → 颜色网格 LUT）
 *   目标：粒子颜色 = badge 该位置的实际像素色（胶囊红→黄渐变 / 头像圆 / 昵称白字），
 *        而不是把色相按 x 硬映射成红→黄。
 *   做法：按 badge 的计算样式把 badge 离屏重绘一遍（渐变色停剥掉 alpha，见 toOpaque），
 *        再按 cell 像素一格采样成颜色网格。失败则回退到解析式红→黄色相映射。
 * ========================================================================== */

/** toOpaque 用的离屏 2d 探针：延迟创建，避免 SSR（无 document）阶段求值报错 */
let _colorProbe: CanvasRenderingContext2D | null = null;
function colorProbe(): CanvasRenderingContext2D | null {
  if (_colorProbe) return _colorProbe;
  if (typeof document === "undefined") return null;
  _colorProbe = document.createElement("canvas").getContext("2d");
  return _colorProbe;
}

/**
 * 把颜色归一化成不透明 rgb 串（剥掉 alpha）。
 * badge 的胶囊渐变是 0.5 alpha 的半透明色：若照原样参与取色，粒子色会与页面底色相乘而发暗发黑；
 * 而真机 badge 底下还压着一层彩色光晕，所以"纯 badge 色"才更接近人眼看到的黄红色调，
 * 也才有"粒子生成 badge / badge 散成粒子"的对应感。
 */
function toOpaque(color: string): string {
  const probe = colorProbe();
  if (!probe) return color;
  try {
    probe.fillStyle = "#000";
    probe.fillStyle = color; // 交给浏览器归一化（支持 #hex / rgb / hsl / 命名色）
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = probe.fillStyle;
    probe.fillRect(0, 0, 1, 1);
    const d = probe.getImageData(0, 0, 1, 1).data;
    return "rgb(" + d[0] + "," + d[1] + "," + d[2] + ")";
  } catch {
    return color;
  }
}

/** CSS 长度 → 数字（非数值如 'normal'/'auto' 归 0，避免 NaN 污染整条布局链） */
function px(v: string): number {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

/** CSS 方位关键字 → 角度（deg，0=to top，90=to right） */
function dirToDeg(s: string): number {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const map: Record<string, number> = {
    "to top": 0,
    "to top right": 45,
    "to right top": 45,
    "to right": 90,
    "to bottom right": 135,
    "to right bottom": 135,
    "to bottom": 180,
    "to bottom left": 225,
    "to left bottom": 225,
    "to left": 270,
    "to top left": 315,
    "to left top": 315,
  };
  return map[t] != null ? map[t] : 180;
}

/** 解析 CSS linear-gradient 串 → {angle, stops}；解析不了返回 null */
function parseLinearGradient(str: string): ParsedGradient | null {
  if (!str || String(str).indexOf("linear-gradient") < 0) return null;
  const s0 = String(str);
  const inner = s0.slice(s0.indexOf("(") + 1, s0.lastIndexOf(")"));
  // 顶层逗号切分（色停里的 rgb()/hsla() 逗号不能切）
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);

  let angle = 180;
  const stops: GradientStop[] = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    if (!s) continue;
    if (i === 0 && /^[-+]?[\d.]+deg$/.test(s)) {
      angle = parseFloat(s);
      continue;
    }
    if (i === 0 && /^to\s+/i.test(s)) {
      angle = dirToDeg(s);
      continue;
    }
    const m = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(s);
    if (!m) continue;
    stops.push({
      color: toOpaque(m[1].trim()),
      off: m[2] != null ? parseFloat(m[2]) / 100 : null!,
    } as GradientStop);
  }
  if (!stops.length) return null;
  // 未标注位置的按均匀分布补齐（CSS 实际规则更复杂，但对本场景两种渐变已足够）
  const n = stops.length;
  for (let i = 0; i < n; i++) if (stops[i].off == null) stops[i].off = n > 1 ? i / (n - 1) : 0;
  if (n === 1) stops.push({ color: stops[0].color, off: 1 });
  return { angle, stops };
}

/** 按 CSS 角度语义在 w×h 盒内建立线性渐变（与浏览器一致：0deg=向上，90deg=向右） */
function makeGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  angleDeg: number,
  stops: GradientStop[]
): CanvasGradient {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const L = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const g = ctx.createLinearGradient(
    w / 2 - (dx * L) / 2,
    h / 2 - (dy * L) / 2,
    w / 2 + (dx * L) / 2,
    h / 2 + (dy * L) / 2
  );
  for (let i = 0; i < stops.length; i++) g.addColorStop(clamp(stops[i].off, 0, 1), stops[i].color);
  return g;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 设置 canvas font：计算样式里的字体栈直接拼可能解析失败（会静默保留上一次 font），
 * 因此赋值后回读校验字号，没生效就退回 sans-serif。
 */
function setFont(ctx: CanvasRenderingContext2D, cs: CSSStyleDeclaration, sizePx: number): void {
  const size = sizePx.toFixed(1) + "px";
  const weight = cs.fontWeight || "700";
  ctx.font = weight + " " + size + " " + (cs.fontFamily || "sans-serif");
  if (ctx.font.indexOf(size) < 0) ctx.font = weight + " " + size + " sans-serif";
}

/**
 * 判断图片像素能否被安全采样（不会污染 canvas 导致 getImageData 抛异常）：
 * 只有同源 / data: / blob: 才允许绘制照片参与取色；跨域图片会 taint 画布，
 * 届时整张 LUT 构建会抛错并整体回退，所以这里提前排除（改为用"渐变+字母"画头像）。
 */
function isSampleSafe(src: string): boolean {
  if (!src) return false;
  if (src.startsWith("data:") || src.startsWith("blob:")) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** LUT 取色网格的每格边长（CSS 设计像素） */
const LUT_CELL = 2;

/**
 * 用 badge 的计算样式离屏重绘 + 采样，返回颜色网格；失败返回 null（调用方回退到色相映射）。
 * 入参 badgeEl 必须是真正承载渐变/内边距/文字的元素；其子元素约定为
 * children[0]=头像（img 或"渐变+字母"圆）、children[1]=昵称 span。
 */
function buildBadgeLut(badgeEl: HTMLElement, vs: number): BadgeLutData | null {
  if (!badgeEl) return null;
  try {
    const cs = getComputedStyle(badgeEl);
    const bw = Math.max(2, Math.round(badgeEl.offsetWidth * vs));
    const bh = Math.max(2, Math.round(badgeEl.offsetHeight * vs));
    const off = document.createElement("canvas");
    off.width = bw;
    off.height = bh;
    const c = off.getContext("2d");
    if (!c) return null;

    // 1) 胶囊底：直接用渐变色停本身（已在解析时剥掉 alpha）着色
    const bg = parseLinearGradient(cs.backgroundImage);
    if (!bg) return null;
    c.save();
    roundRectPath(c, 0, 0, bw, bh, bh / 2);
    c.clip();
    c.fillStyle = makeGradient(c, bw, bh, bg.angle, bg.stops);
    c.fillRect(0, 0, bw, bh);
    c.restore();

    // 从计算样式推布局，避免用 getBoundingClientRect（会被揭示变换污染）
    let cursor = px(cs.paddingLeft) * vs;
    const gap = px(cs.columnGap || cs.gap) * vs;

    // 2) 头像圆 + 圆内文字
    //    有照片 <img>（已加载且同源可采样）时按 object-fit:cover 同款裁切直接绘制照片像素，
    //    否则回退到"渐变底 + 字母"（与 DOM 里的兜底表现一致）
    let usedImg = false;
    const avEl = badgeEl.children[0] as HTMLElement | undefined;
    const acs = avEl ? getComputedStyle(avEl) : null;
    if (avEl && acs) {
      const aw = px(acs.width) * vs;
      const ah = px(acs.height) * vs;
      const acx = cursor + aw / 2;
      const acy = bh / 2;
      const img =
        avEl.tagName === "IMG"
          ? (avEl as HTMLImageElement)
          : (avEl.querySelector("img") as HTMLImageElement | null);
      const photoReady =
        !!(img && img.complete && img.naturalWidth > 0) &&
        isSampleSafe(img ? img.currentSrc || img.src : "");
      c.save();
      c.beginPath();
      c.arc(acx, acy, Math.min(aw, ah) / 2, 0, Math.PI * 2);
      c.clip();
      c.translate(cursor, acy - ah / 2);
      if (photoReady && img) {
        // cover：等比放大到短边铺满，居中裁掉溢出（同 object-fit:cover）
        const k = Math.max(aw / img.naturalWidth, ah / img.naturalHeight);
        const dw = img.naturalWidth * k;
        const dh = img.naturalHeight * k;
        c.drawImage(img, (aw - dw) / 2, (ah - dh) / 2, dw, dh);
        usedImg = true;
      } else {
        const ag = parseLinearGradient(acs.backgroundImage);
        c.fillStyle = ag ? makeGradient(c, aw, ah, ag.angle, ag.stops) : acs.backgroundColor || "#f69";
        c.fillRect(0, 0, aw, ah);
      }
      c.restore();
      const ch = photoReady ? "" : (avEl.textContent || "").trim();
      if (ch) {
        c.save();
        c.fillStyle = acs.color || "#fff";
        c.textAlign = "center";
        c.textBaseline = "middle";
        setFont(c, acs, px(acs.fontSize) * vs);
        c.fillText(ch, acx, acy);
        c.restore();
      }
      cursor += aw + gap;
    }

    // 3) 昵称文字
    const nameEl = badgeEl.children[1] as HTMLElement | undefined;
    if (nameEl) {
      const ncs = getComputedStyle(nameEl);
      c.save();
      c.fillStyle = ncs.color || "#fff";
      c.textAlign = "left";
      c.textBaseline = "alphabetic";
      // letterSpacing 在部分 TS lib 定义里缺失，用类型断言安全写入
      const cc = c as CanvasRenderingContext2D & { letterSpacing?: string };
      if ("letterSpacing" in cc) cc.letterSpacing = ncs.letterSpacing || "0px";
      setFont(c, ncs, px(ncs.fontSize) * vs);
      const nameStr = (nameEl.textContent || "").trim();
      // 竖直定位：精确复刻 DOM 的 `line-height:1` + flex 居中。
      // DOM 侧：行盒高=fontSize（line-height:1）、字形内容区高=asc+desc，正负半行距居中
      //   → 基线 = boxH/2 + (asc - desc)/2（boxH=fontSize）。
      // 这里用 fontBoundingBox 度量（=浏览器计算行盒所用的字体度量）反算同一基线，
      // 使 canvas 里白字的墨迹位置与 DOM 昵称严格重合（无需任何 DOM 位移补偿）。
      const mt = c.measureText(nameStr);
      const asc = mt.fontBoundingBoxAscent;
      const desc = mt.fontBoundingBoxDescent;
      const baseline =
        isFinite(asc) && isFinite(desc) && (asc || desc)
          ? bh / 2 + (asc - desc) / 2
          : bh / 2 + (mt.actualBoundingBoxAscent - mt.actualBoundingBoxDescent) / 2;
      c.fillText(nameStr, cursor, baseline);
      c.restore();
    }

    // 4) 采样成颜色网格
    const cell = LUT_CELL;
    const gw = Math.ceil(bw / cell);
    const gh = Math.ceil(bh / cell);
    const data = c.getImageData(0, 0, bw, bh).data;
    const cols = new Array<string>(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const sx = Math.min(bw - 1, gx * cell + (cell >> 1));
        const sy = Math.min(bh - 1, gy * cell + (cell >> 1));
        const o = (sy * bw + sx) * 4;
        const a = data[o + 3];
        // 关键：离屏画布是透明底，胶囊圆角之外的像素 alpha=0、rgb=0（未预乘），
        // 直接读 rgb 会得到 rgb(0,0,0) —— 即"黑角"。这里检测 alpha：
        // 近乎全透明（<8）的格子写空串（哨兵），由 lutColor 返回 null，
        // 生成粒子时自动回退到 _fallbackColor（红→黄色相），避免出现黑色粒子。
        cols[gy * gw + gx] =
          a < 8 ? "" : "rgb(" + data[o] + "," + data[o + 1] + "," + data[o + 2] + ")";
      }
    }
    void usedImg;
    return { gw, gh, cell, cols, w: bw, h: bh };
  } catch {
    return null;
  }
}

/** 取 LUT 中 badge 局部坐标 (lx,ly) 的颜色；LUT 不可用或该格透明返回 null */
function lutColor(lut: BadgeLutData | null, lx: number, ly: number): string | null {
  if (!lut) return null;
  const gx = clamp(Math.floor(lx / lut.cell), 0, lut.gw - 1);
  const gy = clamp(Math.floor(ly / lut.cell), 0, lut.gh - 1);
  // 透明格存的是空串（见 buildBadgeLut），空串为 falsy → 返回 null，
  // 调用处会回退到 _fallbackColor（红→黄），从而杜绝 badge 圆角外的黑色粒子。
  return lut.cols[gy * lut.gw + gx] || null;
}

/* ============================================================================
 * RadialBadge 引擎
 * ========================================================================== */

export class RadialBadge {
  private dom: RadialBadgeDom;
  private duration: number;
  private coefficient: number;
  private inDist: number;
  private outDist: number;
  private spin: number;
  private reveal: "scale" | "radial" | "fade";
  private speedFactor: number;
  private size: () => number;
  private oscillation: number;
  private shapePow: number;
  private vStretch: number;
  private vTaper: number;
  private onComplete: (finished: "showing" | "hiding") => void;

  /** 当前状态：null=空闲 | showing=聚合中 | hiding=消散中 */
  mode: "showing" | "hiding" | null = null;
  particles: Particle[] = [];
  /** 运行时测算的祖先视觉缩放（等价于库补丁里的 _visualScale，但不再依赖库） */
  private visualScale = 1;

  private _raf: number | null = null;
  private _spawnAcc = 0;
  private _t0 = 0;
  private _last = 0;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _rect = { width: 0, height: 0 };
  private _badgeRect = { x: 0, y: 0, w: 0, h: 0 };
  private _lut: BadgeLutData | null = null;

  constructor(dom: RadialBadgeDom, opts: RadialBadgeOptions) {
    this.dom = dom;
    this.duration = opts.duration;
    this.coefficient = opts.coefficient;
    this.inDist = opts.inDist;
    this.outDist = opts.outDist;
    this.spin = opts.spin;
    this.reveal = opts.reveal;
    this.speedFactor = opts.speedFactor;
    this.size = opts.size;
    this.oscillation = opts.oscillation;
    this.shapePow = opts.shapePow;
    this.vStretch = opts.vStretch;
    this.vTaper = opts.vTaper;
    this.onComplete = opts.onComplete || (() => {});
    // rAF 回调以裸函数引用登记，必须绑定 this（严格模式下裸调用 this=undefined）
    this._frame = this._frame.bind(this);
    this._measure();
    this._applyReveal(0); // 初始不可见（与"隐藏"状态对齐）
  }

  /** 动态测算祖先视觉缩放 VS（库补丁 _visualScale 的等价实现）。
   *  holder 自身无任何变换，offsetWidth 为布局像素、getBoundingClientRect 为视觉像素，
   *  二者之比即祖先链上的 CSS 缩放乘积（画布 fit scale / zoom 等）；
   *  退化时（未布局/为 0）回退 1。 */
  private _computeVisualScale(): number {
    const ref = this.dom.holder || this.dom.badge;
    const w = ref ? ref.offsetWidth : 0;
    if (w > 0) {
      const r = ref.getBoundingClientRect().width / w;
      if (isFinite(r) && r > 0) return r;
    }
    return 1;
  }

  /** 测量 badge 尺寸 / 画布分辨率 / 取色网格（每次动画启动与尺寸变化时调用） */
  private _measure(): void {
    const badge = this.dom.badge;
    const cvs = this.dom.canvas;
    const vs = this._computeVisualScale();
    this.visualScale = vs;
    this._rect = { width: badge.offsetWidth * vs, height: badge.offsetHeight * vs };
    // 场半径：粒子最远飞行距离 + 粒子半径 + 余量。
    // 横向维持原口径不动；纵向单独放宽 —— 纵向位移被 vStretch 放大（见 _spawn），
    // 若沿用同一个 pad，vStretch 较大时纵向粒子会被 canvas 裁掉。
    const maxTravelX = Math.max(this.inDist, this.outDist * 1.25) * this._rect.width;
    const maxTravelY =
      Math.max(this.inDist, this.outDist * 1.25) * (this._rect.height / 2) * this.vStretch;
    const padX = maxTravelX + 40 * vs;
    const padY = Math.max(maxTravelY, this._rect.height / 2) + 40 * vs;
    cvs.width = Math.round(this._rect.width + padX * 2);
    cvs.height = Math.round(this._rect.height + padY * 2);
    // 位图分辨率 = 视觉分辨率（先按视觉像素设位图，再除以 VS 换算回布局像素的 CSS 尺寸）
    cvs.style.width = cvs.width / vs + "px";
    cvs.style.height = cvs.height / vs + "px";
    this._ctx = cvs.getContext("2d");
    // canvas 坐标系里 badge 的矩形（原点 = canvas 左上，badge 左上 = (pad,pad) 居中）
    this._badgeRect = {
      x: (cvs.width - this._rect.width) / 2,
      y: (cvs.height - this._rect.height) / 2,
      w: this._rect.width,
      h: this._rect.height,
    };
    // 颜色网格：每次测量后重建（尺寸变了颜色分布也跟着变）
    this._lut = buildBadgeLut(badge, vs);
  }

  /** 头像图片稍后加载完成时刷新取色网格（可选，提升头像粒子取色保真度） */
  refreshLut(): void {
    this._lut = this.dom.badge ? buildBadgeLut(this.dom.badge, this.visualScale || 1) : null;
  }

  /** 切换状态：hidden=true → 消散，hidden=false → 聚合。同状态重复调用忽略。 */
  setHidden(hidden: boolean): void {
    const mode: "showing" | "hiding" = hidden ? "hiding" : "showing";
    if (this.mode === mode) return;
    this._start(mode);
  }

  private _start(mode: "showing" | "hiding"): void {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._measure();
    this.mode = mode;
    this.particles = [];
    this._spawnAcc = 0;
    this._t0 = performance.now();
    this._last = this._t0;
    this._applyReveal(mode === "showing" ? 0 : 1);
    // 聚合：预铺一层"刚起飞不久"的粒子，让 badge 位置从第 0 帧起就有可见的雾
    // （否则第 0 帧 badge 位置空无一物 = 用户说的"黑洞"）；只回拨 35% 寿命，
    // 配合 _updateDraw 的全局渐显因子，开局是一层很淡的雾，随时间逐渐凝实成 badge。
    if (mode === "showing") {
      const n = Math.round(this.coefficient * 14);
      for (let i = 0; i < n; i++) {
        const p = this._spawn();
        if (p) p.born = this._t0 - p.life * Math.random() * 0.35;
      }
    }
    this._raf = requestAnimationFrame(this._frame);
  }

  /** badge（+光晕）整体成型 / 分解：rev=0 完全不可见，rev=1 完全成型 */
  private _applyReveal(rev: number): void {
    const r = clamp(rev, 0, 1);
    let opacity = r;
    let scale = 1;
    let clip = "";
    if (this.reveal === "scale") {
      opacity = r;
      scale = 0.88 + 0.12 * r;
    } else if (this.reveal === "radial") {
      opacity = clamp(r * 2, 0, 1); // 圆遮罩本身即"揭示"，透明度快速跟上
      const w = this._rect.width;
      const h = this._rect.height;
      const R = 0.5 * Math.sqrt(w * w + h * h) * r;
      clip =
        "circle(" + R.toFixed(1) + "px at " + (w / 2).toFixed(1) + "px " + (h / 2).toFixed(1) + "px)";
    }
    for (const el of [this.dom.badge, this.dom.haloIn]) {
      if (!el) continue;
      el.style.opacity = opacity.toFixed(3);
      el.style.transform = scale === 1 ? "" : "scale(" + scale.toFixed(4) + ")";
      el.style.clipPath = clip;
    }
  }

  /** 生成一个粒子（聚合：雾场→badge 内；消散：badge 内→雾场外）；返回该粒子 */
  private _spawn(): Particle | null {
    const br = this._badgeRect;
    if (!br) return null;
    const vs = this.visualScale || 1;
    const sz = this.size() * (0.6 + Math.random() * 0.8) * vs;
    const now = this._t0 || performance.now();
    let p: Particle;

    if (this.mode === "showing") {
      // 落点：超椭圆形状内的采样点（中心加权）→ 形状可在椭圆↔胶囊间用 shapePow 调节
      const [tx, ty] = sampleBadgePoint(br.w, br.h, this.shapePow);
      // 起点：以 badge 中心为原点、沿"中心→落点"方向自相似（等比）外推。
      // 关键：位移 ∝ 距中心距离 → 整团粒子云始终是同一超椭圆的等比放大，
      // 端部与中心按同一比例铺开 → 两端不会被"满量程飞离"瞬间掏空（旧胶囊法线方案的黑洞根因）。
      const scx = br.w / 2;
      const scy = br.h / 2;
      const rx = tx - scx;
      const ry = ty - scy;
      const dist = Math.hypot(rx, ry) || 1e-6;
      const ux = rx / dist;
      const uy = ry / dist; // 单位径向（中心→落点）
      const Dref = Math.hypot(scx, scy) || 1; // 角点半径：offN 的归一化基准
      const growMax = Math.max(0.05, this.inDist); // 最大等比放大率（inDist 越大雾场越远）
      // 距离分布两段：一半贴 badge 的浓核，另一半铺到整个雾场 → 外围稀但持续有
      const f =
        Math.random() < 0.5
          ? 0.5 * Math.pow(Math.random(), 1.7) // 浓核：0~0.5，偏贴 badge
          : 0.18 + 0.82 * Math.random(); // 外围：铺满整个雾场，越远越稀
      const d0 = dist * growMax * f; // 位移 ∝ dist（自相似）
      // 纵向收口：横向位置越靠两端，纵向位移越小（中间大、两侧小 → 圆台/胶囊轮廓）
      const uw = rx / scx; // -1..1
      const hw = Math.pow(Math.max(0, 1 - uw * uw), 0.5 * this.vTaper);
      const jt = (Math.random() * 2 - 1) * 0.24; // 径向小抖动：不至于像从模子里脱出来
      const csn = Math.cos(jt);
      const sn = Math.sin(jt);
      const ax = ux * csn - uy * sn;
      const ay = ux * sn + uy * csn;
      p = {
        kind: "in",
        born: now,
        life: this.duration * (0.85 + Math.random() * 0.5),
        offN: clamp((dist / Dref) * f, 0, 1), // 归一化起始距离：越远越淡（与消散 offN 严格镜像）
        x0: br.x + tx + ax * d0,
        // y 分量按 vStretch 各向异性放大 → 纵向也铺得开（不改 x，故仍是自相似放大，不产生黑洞）
        // 再乘收口窗口 hw：横向两端纵向位移收小 → 外扩云呈圆台/胶囊轮廓
        y0: br.y + ty + ay * d0 * this.vStretch * hw,
        x1: br.x + tx,
        y1: br.y + ty,
        swirl: (Math.random() * 2 - 1) * this.spin * d0,
        size: sz,
        phase: Math.random() * Math.PI * 2,
        aMul: 0.45 + 0.55 * Math.random(), // 透明度多样：多数偏淡、少数较实
        fadePow: 0.55 + Math.random() * 0.75, // 淡出长尾指数：各粒子错落先后消失
        col: lutColor(this._lut, tx, ty) || this._fallbackColor(tx, br.w),
        dx: 0,
        dy: 0,
        r: sz,
        alpha: 0,
      };
    } else {
      // 起点：超椭圆形状内的采样点（与聚合共用同一形状约束）
      const [sx, sy] = sampleBadgePoint(br.w, br.h, this.shapePow);
      const px0 = br.x + sx;
      const py0 = br.y + sy;
      // 方向/距离：与聚合严格镜像 —— 沿"中心→起点"径向自相似外推，位移 ∝ dist →
      // 整团外扩云仍是同一超椭圆的等比放大，两端与中心同比例铺开 → 根治"两端两个黑洞"。
      const ocx = br.w / 2;
      const ocy = br.h / 2;
      const rx = sx - ocx;
      const ry = sy - ocy;
      const dist = Math.hypot(rx, ry) || 1e-6;
      const ux = rx / dist;
      const uy = ry / dist;
      const Dref = Math.hypot(ocx, ocy) || 1;
      const growMax = Math.max(0.05, this.outDist);
      // 飞散距离三段混合：三成近程、四成中程、三成远程铺到整个雾场 → 外围"比 badge 少、但一直有"的过渡雾带。
      // 近程最低档由 0 抬到 0.12：避免大量粒子紧贴 badge 外侧堆成一条"亮壳/轮廓线"。
      const u = Math.random();
      const f =
        u < 0.34 ? 0.12 + 0.26 * Math.random() : u < 0.72 ? 0.38 + 0.34 * Math.random() : 0.72 + 0.4 * Math.random();
      const d1 = dist * growMax * f;
      // 纵向收口：与聚合严格镜像（横向两端纵向位移收小 → 外扩云呈圆台/胶囊轮廓）
      const uw = rx / ocx; // -1..1
      const hw = Math.pow(Math.max(0, 1 - uw * uw), 0.5 * this.vTaper);
      const jt = (Math.random() * 2 - 1) * 0.24;
      const csn = Math.cos(jt);
      const sn = Math.sin(jt);
      const ax = ux * csn - uy * sn;
      const ay = ux * sn + uy * csn;
      const offN = clamp((dist / Dref) * f, 0, 1);
      p = {
        kind: "out",
        born: now,
        // 生命：与飞散距离基本无关（仅极弱倾向让浓核稍晚散）+ 宽随机铺开 →
        // 任何时刻外围都保持"比 badge 区域少、但一直有"的比例，末尾是整体慢慢飘散的雾散
        life: this.duration * (0.8 + 0.2 * (1 - offN)) * (0.72 + Math.random() * 0.68),
        x0: px0,
        y0: py0,
        x1: px0 + ax * d1,
        // 与聚合严格镜像：y 分量按 vStretch 各向异性放大，再乘收口窗口 hw
        y1: py0 + ay * d1 * this.vStretch * hw,
        offN, // 归一化外飘距离：外飘时按它衰减透明度（越外围越淡）
        swirl: (Math.random() * 2 - 1) * this.spin * d1 * 0.4,
        size: sz,
        phase: Math.random() * Math.PI * 2,
        aMul: 0.45 + 0.55 * Math.random(),
        fadePow: 0.55 + Math.random() * 0.75,
        col: lutColor(this._lut, sx, sy) || this._fallbackColor(sx, br.w),
        dx: 0,
        dy: 0,
        r: sz,
        alpha: 0,
      };
    }
    this.particles.push(p);
    return p;
  }

  /** LUT 不可用时的回退：按 badge 局部 x 映射红→黄色相 */
  private _fallbackColor(lx: number, w: number): string {
    return HSL[Math.round(60 * clamp(lx / (w || 1), 0, 1))];
  }

  private _frame(now: number): void {
    const dt = Math.min(64, now - this._last); // 限幅，防切后台后一次性补一大堆
    this._last = now;
    const el = now - this._t0;
    const t = el / this.duration;
    const osc = this.oscillation * (this.visualScale || 1) * 0.55; // 降幅 → 减少散射感

    if (t < 1) {
      // 生成：粒子速率 = 密度系数 × 133/s
      const rate = this.coefficient * 133 * this.speedFactor;
      this._spawnAcc += (rate * dt) / 1000;
      let n = Math.floor(this._spawnAcc);
      this._spawnAcc -= n;
      if (this.particles.length + n > NEW_CAP) n = Math.max(0, NEW_CAP - this.particles.length);
      while (n-- > 0) this._spawn();
      // badge 成型/分解：不透明度随"雾的浓度"平滑变化，避免固定曲线造成的突兀
      let rev: number;
      if (this.mode === "showing") rev = easeInOutCubic(clamp(t / 0.92, 0, 1)); // 从雾里逐渐凝结成形
      // 逐渐化开成雾：badge 本体在 HIDE_REVEAL_SPAN（70% duration）处即淡尽，
      // 其后仅由粒子继续外飘 → 避免白字轮廓在末尾残留（详见 HIDE_REVEAL_SPAN 注释）。
      // 保留原 (1-s)^1.35 的曲线形状（起步快、收尾平滑、在 s=0 处斜率为 0），只是把跨度压缩。
      else rev = Math.pow(clamp(1 - t / HIDE_REVEAL_SPAN, 0, 1), 1.35);
      this._applyReveal(rev);
    } else {
      this._applyReveal(this.mode === "showing" ? 1 : 0);
    }

    this._updateDraw(now, osc);

    if (t >= 1 && this.particles.length === 0) {
      const finished = this.mode as "showing" | "hiding";
      this._raf = null;
      this.mode = null;
      this.onComplete(finished);
      return;
    }
    this._raf = requestAnimationFrame(this._frame);
  }

  private _updateDraw(now: number, osc: number): void {
    const ctx = this._ctx;
    const cvs = this.dom.canvas;
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    // 聚合全局渐显因子：整个粒子场的整体不透明度随进度 0.12→1（前 60% 完成），
    // 与消散末尾"整体慢慢飘散"严格镜像 → 聚合开局是"雾从无到有地浮现"，而非一上来就实。
    const tAll = this._t0 == null ? 1 : (now - this._t0) / this.duration;
    const gA = this.mode === "showing" ? 0.12 + 0.88 * clamp(tAll / 0.6, 0, 1) : 1;
    const out: Particle[] = [];
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const u = (now - p.born) / p.life;
      if (u >= 1) continue; // 生命结束 → 回收
      const uc = clamp(u, 0, 1);
      let e: number;
      let alpha: number;
      let r: number;
      if (p.kind === "in") {
        // 先快后慢：迅速贴近目标，之后长时间在目标处徘徊 → "浓雾聚集成 badge"
        e = easeOutCubic(uc);
        // 渐进显形：用随机指数 fadePow 的幂曲线 → 起始透明度≈0、随时间缓慢加实，
        // 且各粒子 fadePow 不同 → 错落出现，与消散末尾 (1-uc)^fadePow 淡出严格镜像
        alpha = Math.pow(uc, p.fadePow);
        // 距离梯度：起点越远越淡、越靠近中心越不透明 → 与消散的 (1-0.72*offN*e) 严格镜像
        alpha *= 1 - 0.85 * p.offN * (1 - e);
        alpha *= gA; // 全局渐显：开局整体半透明
        if (uc > 0.72) alpha *= Math.pow((1 - uc) / 0.28, p.fadePow); // 末尾错落淡出
        r = p.size;
      } else {
        // 缓慢化开（两端慢），但混入 15% 线性位移保留"末速" → 末尾仍在慢慢飘散；
        // 淡出用随机长尾指数（fadePow）→ 各粒子错落先后消失；
        // 外飘距离越远透明度越低（offN*e = 当前归一化外飘距离）→ 越靠外围越淡
        e = easeInOutCubic(uc) * 0.85 + uc * 0.15;
        alpha = Math.min(1, uc * 6) * Math.pow(1 - uc, p.fadePow) * (1 - 0.72 * p.offN * e);
        r = p.size * (1 - 0.3 * e);
      }
      const dx = p.x1 - p.x0;
      const dy = p.y1 - p.y0;
      const len = Math.hypot(dx, dy) || 1;
      // 涡流：垂直于飞行方向的正弦偏移，两端为 0、中段最大
      const off = p.swirl * Math.sin(Math.PI * e) * Math.sin(p.phase + now * 0.0025);
      const nx = -dy / len;
      const ny = dx / len;
      p.dx = lerp(p.x0, p.x1, e) + nx * off;
      p.dy = lerp(p.y0, p.y1, e) + ny * off + Math.sin(p.phase + now * 0.006) * osc;
      p.r = r;
      p.alpha = clamp(alpha * p.aMul, 0, 1); // 逐粒子透明度：个体差异 → 浓淡错落更像雾
      out.push(p);
    }
    this.particles = out;
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      if (p.alpha <= 0.004) continue;
      ctx.fillStyle = p.col; // 逐粒子颜色（生成时取自 badge 实际像素）
      ctx.globalAlpha = p.alpha;
      ctx.beginPath();
      ctx.arc(p.dx, p.dy, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** 卸载/重挂载前调用：停止 rAF 并释放粒子（防止跨轮残留的动画继续跑） */
  destroy(): void {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.mode = null;
    this.particles = [];
  }
}
