// 从 SlingTab (github.com/AtlasAnatomy/SlingTab) 抽取的 4 个 GLSL shader，
// 内联为 TS 字符串（Next.js 不支持 Vite 的 `?raw` 导入）。
// 仅保留 ring + spark 两个 pass：vision/lens 是导航专用，已随裁剪删除。

/** 全屏三角形，ring 与 spark pass 共用。 */
export const RING_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/**
 * 火圈核心 shader。
 *
 * 关键坑（保留原注释）：
 * 1. lead 项必须用 step(0.0, behind) 做符号门控 —— clamp 到 0 会让未描绘段
 *    的高斯恒为 exp(0)=1，整圈提前全亮。
 * 2. GLSL ES 中 pow(x,y) 对 x<0 未定义，平方项一律走 sq()。
 * 3. 所有长度为 gl_FragCoord 设备像素，renderer 上传前翻转 y。
 */
export const RING_FRAG = `#version 300 es
precision highp float;

// The rim is not a glowing tube. It is a dense, uneven stream of embers, and it
// has to break up along its length or it reads as a neon hoop. Everything here
// serves that: the filament wanders off-radius, varies in thickness, and is
// chopped by high-frequency angular noise into individual hot cells. The real
// particle system then sits on top of it.
uniform vec2  uRes;
uniform vec2  uCenter;
uniform float uRadius;
uniform float uProgress;    // 0..1, how much of the ring has been traced
uniform float uStartAngle;  // where the trace began
uniform float uDir;         // +1 / -1, the direction the hand travelled
uniform float uEnergy;      // master brightness
uniform float uTime;        // seconds
uniform float uSpin;        // slow rotation, radians
uniform float uDissipate;   // 0..1, ring blowing apart
uniform float uPx;          // device pixels per CSS pixel

uniform float uCore;        // filament brightness
uniform float uThickness;   // filament half-width, as a fraction of R
uniform float uGrain;       // how hard the speckle chops the filament
uniform float uDust;        // ember dust hugging the outside
uniform float uGlow;        // bloom weight

out vec4 fragColor;

const float TAU = 6.28318530718;

// pow(x, y) is UNDEFINED for x < 0 in GLSL ES, and several drivers return NaN.
// Every squared term below straddles zero, so none of them may use pow().
float sq(float x) { return x * x; }

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

// #C2410C -> #FF8A1F -> #FFD27A -> white-hot. The top stop extends the spec
// palette: embers clip to white at the core, and without it the ring reads as
// flat orange rather than as something burning.
vec3 palette(float t) {
  vec3 c0 = vec3(0.760, 0.255, 0.047);
  vec3 c1 = vec3(1.000, 0.541, 0.121);
  vec3 c2 = vec3(1.000, 0.824, 0.478);
  vec3 c3 = vec3(1.000, 0.957, 0.890);
  t = clamp(t, 0.0, 1.0);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.68) return mix(c1, c2, (t - 0.34) / 0.34);
  return mix(c2, c3, (t - 0.68) / 0.32);
}

void main() {
  vec2  p  = gl_FragCoord.xy - uCenter;
  float d  = length(p);
  float a  = atan(p.y, p.x);
  float px = max(uPx, 1.0);

  float R = uRadius * (1.0 + uDissipate * 0.16);

  if (d > R * 1.75 + 30.0 * px) {
    fragColor = vec4(0.0);
    return;
  }

  // ---- arc mask: the ring follows the hand, it does not appear pre-formed ----
  float rel   = mod((a - uStartAngle) * uDir, TAU);
  float sweep = uProgress * TAU;
  float arc   = 1.0 - smoothstep(sweep - 0.08, sweep + 0.02, rel);
  arc = mix(arc, 1.0, smoothstep(0.985, 1.0, uProgress));

  // Distance BEHIND the leading edge: positive inside the traced arc, negative
  // ahead of it.
  //
  // Do NOT write exp(-sq(max(0.0, behind) / w)). Clamping the argument to zero
  // makes the Gaussian evaluate to exp(0) = 1 for every angle ahead of the
  // sweep, so the whole un-traced ring lights at full core brightness — the arc
  // mask below cannot help, because this term is added outside it. Gate on the
  // sign instead.
  float behind = sweep - rel;
  float lead = step(0.0, behind) * exp(-sq(behind / 0.26))
             * smoothstep(0.02, 0.12, uProgress)
             * smoothstep(1.0, 0.86, uProgress);

  // ---- the filament ----
  // Wander: a hand-drawn burning circle is never a perfect circle.
  float wobble = (fbm(vec2(a * 4.0 + 11.0, uTime * 0.5)) - 0.5) * R * 0.030;
  float rr = R + wobble;

  // Thickness varies slowly around the arc; brightness is chopped fast.
  float swell   = fbm(vec2(a * 8.0 + uSpin * 1.2, uTime * 0.9));
  float speckle = fbm(vec2(a * 52.0 + uSpin * 3.0, uTime * 2.4));

  float w = max(1.4 * px, R * uThickness) * (0.55 + 0.95 * swell);
  float core = exp(-sq((d - rr) / w));
  core *= (1.0 - uGrain) + uGrain * speckle;   // break the line into embers

  // ---- ember dust hugging the outside of the filament ----
  float sprayW = R * 0.14;
  float sprayD = max(0.0, d - rr) / sprayW;
  float dust = exp(-sq(sprayD * 1.15))
             * smoothstep(0.55, 0.95, fbm(vec2(a * 130.0 + uSpin * 5.0,
                                               d * 0.26 - uTime * 5.0)));

  // ---- bloom ----
  float gw = max(R * 0.15, 11.0 * px);
  float dd = (d - rr) / gw;
  float glow = (d > rr ? 1.0 : 0.7) / (1.0 + dd * dd * 5.0);

  // runes（符文环 + 内接多边形）已按需求裁剪：调试参数 runes=0。

  float breathe = 0.88 + 0.12 * fbm(vec2(uTime * 0.55, 3.7));
  float energy  = uEnergy * breathe * (1.0 - uDissipate * 0.85);

  float ring = core * uCore
             + dust * uDust
             + glow * uGlow;
  ring = ring * arc + core * lead * 2.2;

  float intensity = clamp(ring * energy, 0.0, 1.7);
  float heat = clamp(core * 1.20 + lead * 0.45 + dust * 0.30 + glow * 0.08, 0.0, 1.0);

  // Additive: the pipeline blends with SRC_ALPHA / ONE, onto a premultiplied
  // framebuffer. 见 renderer.ts 中 premultipliedAlpha:true 的注释。
  fragColor = vec4(palette(heat), clamp(intensity, 0.0, 1.0));
}
`;

/**
 * 火花顶点 shader：每颗火花是一条沿自身历史轨迹的缎带。
 * 轨迹用抛物线解析重建 p(-τ) = p − v·τ + ½gτ²，CPU 无需保存历史。
 */
export const SPARK_VERT = `#version 300 es
layout(location = 0) in vec2  aCorner;
layout(location = 1) in vec4  aData;   // xy = device px, z = half-width px, w = alpha
layout(location = 2) in vec2  aMisc;   // x = palette position, y = age in seconds
layout(location = 3) in vec2  aVel;    // device px/s

uniform vec2  uRes;
uniform float uTrail;     // seconds of path to draw behind the head
uniform vec2  uGravity;   // device px/s^2, already in gl_FragCoord space

out float vT;      // 0 head .. 1 tail
out float vSide;
out float vAlpha;
out float vTint;

void main() {
  float tn   = aCorner.x;
  float side = aCorner.y;

  // A spark 40ms old must not trail 200ms of path it never travelled.
  float trail = min(uTrail, aMisc.y);
  float tau   = tn * trail;

  vec2 p = aData.xy - aVel * tau + 0.5 * uGravity * tau * tau;

  // d(p)/d(tau) — the tangent of the reconstructed path at this point.
  vec2  dv = -aVel + uGravity * tau;
  float dl = length(dv);
  vec2  dir  = dl > 0.001 ? dv / dl : vec2(1.0, 0.0);
  vec2  perp = vec2(-dir.y, dir.x);

  // Taper to nothing at the tail. The floor keeps a strand from disappearing
  // between samples once it is thinner than a pixel.
  float halfW = aData.z * (1.0 - tn) * (1.0 - tn) + 0.28;

  vec2 px  = p + perp * side * halfW;
  vec2 ndc = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);

  vT     = tn;
  vSide  = side;
  vAlpha = aData.w;
  vTint  = aMisc.x;
}
`;

/** 火花片元 shader：头部白热、尾部冷却变细。 */
export const SPARK_FRAG = `#version 300 es
precision mediump float;

in float vT;      // 0 head .. 1 tail
in float vSide;
in float vAlpha;
in float vTint;

out vec4 fragColor;

// #C2410C -> #FF8A1F -> #FFD27A -> white-hot.
vec3 palette(float t) {
  vec3 c0 = vec3(0.760, 0.255, 0.047);
  vec3 c1 = vec3(1.000, 0.541, 0.121);
  vec3 c2 = vec3(1.000, 0.824, 0.478);
  vec3 c3 = vec3(1.000, 0.957, 0.890);
  t = clamp(t, 0.0, 1.0);
  if (t < 0.34) return mix(c0, c1, t / 0.34);
  if (t < 0.68) return mix(c1, c2, (t - 0.34) / 0.34);
  return mix(c2, c3, (t - 0.68) / 0.32);
}

void main() {
  // Across the strand. The soft shoulder is what stops a 1px ribbon from
  // shimmering as it crosses the pixel grid.
  float across = 1.0 - abs(vSide);
  if (across <= 0.0) discard;

  // Along the strand: bright at the head, cooling and thinning to the tail.
  float along = 1.0 - vT;

  float a = pow(across, 0.65) * pow(along, 1.25) * vAlpha;
  if (a <= 0.002) discard;

  // The tip is white-hot, the tail falls to the deep orange end.
  float heat = clamp(vTint * 0.25 + pow(along, 2.2) * 0.85, 0.0, 1.0);

  fragColor = vec4(palette(heat), clamp(a, 0.0, 1.0));
}
`;
