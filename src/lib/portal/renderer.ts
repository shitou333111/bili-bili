import { RING_VERT, RING_FRAG, SPARK_VERT, SPARK_FRAG } from "./shaders";
import { MAX_SPARKS, SPARK_TUNING, type SparkSystem } from "./sparks";
import { DEFAULT_LOOK, type LookParams, type RenderState } from "./types";

/**
 * Segments per spark ribbon. More gives a smoother curve on the long whips; the
 * cost is linear and trivial (2200 sparks * 10 segments * 6 verts is ~130k
 * vertices per frame, which is nothing for a GPU).
 */
const TRAIL_SEGMENTS = 8;

/**
 * Static geometry for one ribbon: `segments` quads laid end to end along the
 * trail. x = normalised distance along the trail (0 head, 1 tail), y = side.
 * The vertex shader turns each (x, y) into a point on that particle's own
 * reconstructed path, so this buffer is uploaded once and never changes.
 */
function buildRibbon(segments: number): Float32Array {
  const out = new Float32Array(segments * 6 * 2);
  let o = 0;
  const push = (t: number, side: number) => {
    out[o++] = t;
    out[o++] = side;
  };
  for (let s = 0; s < segments; s++) {
    const t0 = s / segments;
    const t1 = (s + 1) / segments;
    push(t0, -1); push(t1, -1); push(t0, 1);
    push(t0, 1); push(t1, -1); push(t1, 1);
  }
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("createProgram failed");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const out: Uniforms = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

/** 轻量 WebGL2 渲染器：只跑 ring + spark 两个 pass（vision/lens 导航专用已删）。 */
export class GLRenderer {
  private gl: WebGL2RenderingContext;
  private quad: WebGLBuffer;
  private vaoFull: WebGLVertexArrayObject;

  private ringProg: WebGLProgram;
  private ringU: Uniforms;
  private sparkProg: WebGLProgram;
  private sparkU: Uniforms;

  private sparkVao: WebGLVertexArrayObject;
  private sparkRibbon: WebGLBuffer;
  private sparkData: WebGLBuffer;
  private sparkMisc: WebGLBuffer;
  private sparkVel: WebGLBuffer;
  private sparkDataCpu = new Float32Array(MAX_SPARKS * 4);
  private sparkMiscCpu = new Float32Array(MAX_SPARKS * 2);
  private sparkVelCpu = new Float32Array(MAX_SPARKS * 2);

  private look: LookParams = { ...DEFAULT_LOOK };

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      // MUST be true. Additive passes leave the framebuffer holding
      // rgb = sum(col_i * alpha_i), which is premultiplied by construction.
      // With `false` the compositor multiplies rgb by alpha a second time, so a
      // fragment of intensity i composites at i^3 — a 0.3 glow arrives at 0.027
      // and the entire ring is invisible except for a hairline core.
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;

    this.ringProg = link(gl, RING_VERT, RING_FRAG);
    this.ringU = uniforms(gl, this.ringProg, [
      "uRes", "uCenter", "uRadius", "uProgress", "uStartAngle",
      "uDir", "uEnergy", "uTime", "uSpin", "uDissipate", "uPx",
      "uCore", "uThickness", "uGrain", "uDust", "uGlow",
    ]);

    this.sparkProg = link(gl, SPARK_VERT, SPARK_FRAG);
    this.sparkU = uniforms(gl, this.sparkProg, ["uRes", "uTrail", "uGravity"]);

    const quad = gl.createBuffer();
    if (!quad) throw new Error("createBuffer failed");
    this.quad = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );

    const vao = gl.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    this.vaoFull = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // --- spark instancing: one ribbon per particle ---
    const svao = gl.createVertexArray();
    const ribbon = gl.createBuffer();
    const data = gl.createBuffer();
    const miscBuf = gl.createBuffer();
    const velBuf = gl.createBuffer();
    if (!svao || !ribbon || !data || !miscBuf || !velBuf) {
      throw new Error("spark buffers failed");
    }
    this.sparkVao = svao;
    this.sparkRibbon = ribbon;
    this.sparkData = data;
    this.sparkMisc = miscBuf;
    this.sparkVel = velBuf;

    gl.bindVertexArray(svao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbon);
    gl.bufferData(gl.ARRAY_BUFFER, buildRibbon(TRAIL_SEGMENTS), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, data);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkDataCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, miscBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkMiscCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, velBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparkVelCpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);

    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    this.dpr = Math.min(2, Math.max(1, dpr)); // cap dpr at 2
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  setLook(patch: Partial<LookParams>): void {
    this.look = { ...this.look, ...patch };
  }

  render(s: RenderState, sparks: SparkSystem): void {
    if (this.disposed) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;

    const dpr = this.dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // gl_FragCoord has its origin bottom-left; CSS coords are top-left.
    const cx = s.cx * dpr;
    const cy = h - s.cy * dpr;
    const radius = s.radius * dpr;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindVertexArray(this.vaoFull);

    // ---- pass 1: ring (additive) ----
    // RGB is the spec's SRC_ALPHA/ONE. Alpha is ONE/ONE, not SRC_ALPHA/ONE:
    // with a single blendFunc the alpha channel would accumulate as sum(a_i^2),
    // which under-reports coverage and dims the composite.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    gl.useProgram(this.ringProg);
    {
      const u = this.ringU;
      gl.uniform2f(u["uRes"]!, w, h);
      gl.uniform2f(u["uCenter"]!, cx, cy);
      gl.uniform1f(u["uRadius"]!, radius);
      gl.uniform1f(u["uProgress"]!, s.progress);
      // Screen-space y is flipped relative to gl_FragCoord, so the traced arc's
      // angle and handedness both mirror.
      gl.uniform1f(u["uStartAngle"]!, -s.startAngle);
      gl.uniform1f(u["uDir"]!, -s.direction);
      gl.uniform1f(u["uEnergy"]!, s.energy);
      gl.uniform1f(u["uTime"]!, s.timeSec);
      gl.uniform1f(u["uSpin"]!, s.spin);
      gl.uniform1f(u["uDissipate"]!, s.dissipate);
      gl.uniform1f(u["uPx"]!, dpr);
      gl.uniform1f(u["uCore"]!, this.look.core);
      gl.uniform1f(u["uThickness"]!, this.look.thickness);
      gl.uniform1f(u["uGrain"]!, this.look.grain);
      gl.uniform1f(u["uDust"]!, this.look.dust);
      gl.uniform1f(u["uGlow"]!, this.look.glow);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- pass 2: sparks (additive, one instanced ribbon per particle) ----
    const n = sparks.count;
    if (n > 0) {
      // Convert CSS px -> device px, y-flipped, into the upload staging buffers.
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        this.sparkDataCpu[o] = sparks.packed[o]! * dpr;
        this.sparkDataCpu[o + 1] = h - sparks.packed[o + 1]! * dpr;
        this.sparkDataCpu[o + 2] = sparks.packed[o + 2]! * dpr;
        this.sparkDataCpu[o + 3] = sparks.packed[o + 3]!;
        this.sparkMiscCpu[i * 2] = sparks.tints[i]!;
        this.sparkMiscCpu[i * 2 + 1] = sparks.ages[i]!;
        // y is flipped going into gl_FragCoord space, so vy flips with it.
        this.sparkVelCpu[i * 2] = sparks.vels[i * 2]! * dpr;
        this.sparkVelCpu[i * 2 + 1] = -sparks.vels[i * 2 + 1]! * dpr;
      }
      gl.bindVertexArray(this.sparkVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkData);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkDataCpu, 0, n * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkMisc);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkMiscCpu, 0, n * 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVel);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkVelCpu, 0, n * 2);

      gl.useProgram(this.sparkProg);
      gl.uniform2f(this.sparkU["uRes"]!, w, h);
      gl.uniform1f(this.sparkU["uTrail"]!, this.look.streak);
      // Screen gravity pulls down (+y); gl_FragCoord space has y up.
      gl.uniform2f(this.sparkU["uGravity"]!, 0, -SPARK_TUNING.gravity * dpr);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, TRAIL_SEGMENTS * 6, n);
    }

    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    try {
      gl.deleteBuffer(this.quad);
      gl.deleteBuffer(this.sparkRibbon);
      gl.deleteBuffer(this.sparkData);
      gl.deleteBuffer(this.sparkMisc);
      gl.deleteBuffer(this.sparkVel);
      gl.deleteVertexArray(this.vaoFull);
      gl.deleteVertexArray(this.sparkVao);
      gl.deleteProgram(this.ringProg);
      gl.deleteProgram(this.sparkProg);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* context already gone */
    }
  }
}
