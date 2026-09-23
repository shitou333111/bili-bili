/**
 * 礼物特效 → 透明 WebP 动图提取脚本
 *
 * 按 gift_id 从 B站全屏特效接口查找到绑定的特效，
 * 下载 mp4 视频和配套配置 JSON，用 ffmpeg 合成透明通道后同时输出三种格式：
 *   - webp：带透明通道的动画（libwebp）
 *   - webm：带透明通道的动画（libvpx-vp9，yuva420p 真 alpha）
 *   - gif：  带透明的动画（GIF 仅支持 1-bit 单色透明，无半透明渐变；
 *            每帧写满尺寸并跳过开头全透明帧，保证缩略图和尺寸显示正常）
 *
 * 合成逻辑与模拟器 AlphaVideoPlayer 一致：
 *   视频内包含 rgbFrame（画面区）和 aFrame（灰度透明区）两个矩形区域，
 *   取 aFrame 的 R 通道作为 alpha 合并到 rgbFrame 画面上，
 *   输出尺寸 = round(w * scale) × round(h * scale)。
 *
 * 运行方式（在项目根目录，需要可用的 ffmpeg，如 conda activate mfa；
 * WebM 需要带 libvpx 的 ffmpeg，会自动查找 imageio-ffmpeg 自带的静态 ffmpeg）：
 *   node scripts/gift-effect-webp.mjs <gift_id> [--out <输出路径前缀>] [--fps <帧率>] [--quality <1-100>] [--keep-h <高度保留比例>]
 *
 * --keep-h：从底部向上保留最终输出高度的百分比（作用于缩放后的输出尺寸，而非原始视频画幅），
 *           宽度不变。接受 0.3 或 30% 写法，均为 30%。默认 0.5。
 *
 * 示例：
 *   node scripts/gift-effect-webp.mjs 31100
 *   node scripts/gift-effect-webp.mjs 31100 --out ./my --fps 30 --quality 90
 *   node scripts/gift-effect-webp.mjs 31100 --keep-h 30%   # 只保留底部向上 30% 高度
 *
 * 若指定礼物没有绑定特效，则输出提示且不生成文件。
 */

import { promises as fs, existsSync, readdirSync } from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(__dirname, "output");

const BILI_API =
  "https://api.live.bilibili.com/xlive/general-interface/v1/fullScSpecialEffect/GetEffectConfListV2?platform=pc";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// ==================== 命令行参数 ====================

/** 解析高度保留比例：0.3 或 30% 均表示 30%（不带 % 时只接受 0~1 的小数） */
function parseKeepH(raw) {
  if (raw == null) return 0.5; // 默认保留底部向上 50% 高度
  const s = String(raw).trim();
  const hasPct = s.endsWith("%");
  const n = Number(hasPct ? s.slice(0, -1) : s);
  if (isNaN(n) || n <= 0) {
    console.error(`[gift-effect-webp] 无效的 --keep-h 值: ${raw}（示例: 0.3 或 30%）`);
    process.exit(1);
  }
  const ratio = hasPct ? n / 100 : n;
  if (ratio > 1) {
    console.error(`[gift-effect-webp] --keep-h 需在 (0,1] 之间（如 0.3）或 (0,100]% 之间（如 30%），收到: ${raw}`);
    process.exit(1);
  }
  return ratio;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { giftId: null, out: null, fps: null, quality: 90, keepH: 0.5 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") opts.out = args[++i];
    else if (a === "--fps") opts.fps = Number(args[++i]);
    else if (a === "--quality") opts.quality = Number(args[++i]);
    else if (a === "--keep-h") opts.keepH = parseKeepH(args[++i]);
    else if (!a.startsWith("--") && opts.giftId === null) opts.giftId = a;
    else {
      console.error(`[gift-effect-webp] 未知参数: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// ==================== 工具函数 ====================

/** 收集候选 ffmpeg：FFMPEG_PATH > PATH > conda mfa 环境 > imageio-ffmpeg 自带静态 ffmpeg */
function collectFfmpegCandidates() {
  const list = [];
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    list.push(process.env.FFMPEG_PATH);
  }
  list.push("ffmpeg"); // PATH 中的 ffmpeg（存在性由 hasVpx 探测）
  const home = os.homedir();
  const envRoots = [
    path.join(home, ".conda", "envs"),
    path.join(home, "miniconda3", "envs"),
    path.join(home, "anaconda3", "envs"),
    "C:\\ProgramData\\miniconda3\\envs",
    "C:\\ProgramData\\anaconda3\\envs",
  ];
  for (const root of envRoots) {
    if (!existsSync(root)) continue;
    for (const env of safeReaddir(root)) {
      for (const sub of ["Library\\bin\\ffmpeg.exe", "bin\\ffmpeg.exe", "bin\\ffmpeg"]) {
        const p = path.join(root, env, sub);
        if (existsSync(p)) list.push(p);
      }
      // imageio-ffmpeg 自带的静态 ffmpeg（含 libvpx）
      const binDir = path.join(root, env, "Lib", "site-packages", "imageio_ffmpeg", "binaries");
      if (existsSync(binDir)) {
        for (const f of safeReaddir(binDir)) {
          if (f.startsWith("ffmpeg") && f.endsWith(".exe")) list.push(path.join(binDir, f));
        }
      }
    }
  }
  return [...new Set(list)];
}

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

const vpxCache = new Map();

/** 探测 ffmpeg 是否可用且（needVpx 时）带 libvpx-vp9 编码器 */
function hasVpx(ffmpeg, needVpx) {
  const key = `${ffmpeg}|${needVpx}`;
  if (vpxCache.has(key)) return vpxCache.get(key);
  let ok = false;
  try {
    const r = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" });
    ok = r.status === 0 && (!needVpx || /libvpx-vp9/.test(r.stdout || ""));
  } catch {
    ok = false;
  }
  vpxCache.set(key, ok);
  return ok;
}

/** 定位 ffmpeg；needVpx=true 时要求带 libvpx-vp9（编真 alpha WebM 用） */
function resolveFfmpeg(needVpx = false) {
  for (const c of collectFfmpegCandidates()) {
    if (hasVpx(c, needVpx)) return c;
  }
  if (needVpx) {
    console.error(
      "[gift-effect-webp] 未找到带 libvpx 的 ffmpeg（无法编码带透明通道的 WebM）。" +
        "请安装: pip install imageio-ffmpeg（可用 -i https://pypi.tuna.tsinghua.edu.cn/simple），" +
        "或设置环境变量 FFMPEG_PATH 指向带 libvpx 的 ffmpeg。",
    );
    process.exit(1);
  }
  console.error(
    "[gift-effect-webp] 未找到 ffmpeg。请先切换环境（conda activate mfa），或设置环境变量 FFMPEG_PATH 指向 ffmpeg 可执行文件。",
  );
  process.exit(1);
}

/** 带 UA/Referer 的 JSON 请求（与项目 /api/gift-effects 一致） */
async function fetchJson(url, withBiliHeaders = false) {
  const headers = withBiliHeaders
    ? { "User-Agent": UA, Referer: "https://live.bilibili.com/" }
    : { "User-Agent": UA };
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

/** 下载文件到本地路径 */
async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** 执行 ffmpeg，失败时抛错 */
function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

/** 执行 ffmpeg 并捕获 stderr（用于解析 metadata=print 输出），失败时抛错 */
function runFfmpegCapture(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => (err += d));
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve(err);
      else reject(new Error(`ffmpeg 退出码 ${code}`));
    });
  });
}

// ==================== 主流程 ====================

async function main() {
  const opts = parseArgs();
  const giftId = Number(opts.giftId);
  if (!opts.giftId || isNaN(giftId) || giftId <= 0) {
    console.error("[gift-effect-webp] 用法: node scripts/gift-effect-webp.mjs <gift_id> [--out <输出路径>] [--fps <帧率>] [--quality <1-100>]");
    process.exit(1);
  }

  // 1. 查询特效绑定表，找到该礼物绑定的特效（与路由逻辑一致：只认 web_mp4/web_mp4_json 齐全的条目，后绑定的覆盖先绑定的）
  console.log(`[gift-effect-webp] 查询礼物 ${giftId} 的特效绑定...`);
  const conf = await fetchJson(BILI_API, true);
  if (conf.code !== 0) {
    console.error(`[gift-effect-webp] 特效接口返回错误 code=${conf.code} message=${conf.message}`);
    process.exit(1);
  }
  const confList = conf?.data?.full_sc_resource?.conf_list ?? [];
  let effect = null;
  for (const item of confList) {
    if (!item.web_mp4 || !item.web_mp4_json) continue;
    if ((item.bind_gift_ids ?? []).includes(giftId)) effect = item;
  }
  if (!effect) {
    console.log(`[gift-effect-webp] 礼物 ${giftId} 没有绑定任何特效，未生成文件。`);
    process.exit(1);
  }

  // 2. 下载配置 JSON，解析区域信息
  console.log(`[gift-effect-webp] 特效配置: ${effect.web_mp4_json}`);
  const config = await fetchJson(effect.web_mp4_json);
  const info = config?.info;
  if (!info || !Array.isArray(info.rgbFrame) || !Array.isArray(info.aFrame)) {
    console.error(`[gift-effect-webp] 礼物 ${giftId} 的特效配置 JSON 缺少 rgbFrame/aFrame 字段，无法合成。`);
    process.exit(1);
  }
  const [rx, ry, rw, rh] = info.rgbFrame;
  const [ax, ay, aw, ah] = info.aFrame;
  const scale = info.scale || 1;
  const outW = Math.max(1, Math.round(info.w * scale));
  const outH = Math.max(1, Math.round(info.h * scale));
  const fps = opts.fps || info.fps || 30;
  // 按 --keep-h 从底部向上保留输出高度的百分比（作用于缩放后的输出尺寸，宽度不变）
  const cropH = Math.max(2, Math.floor(outH * opts.keepH / 2) * 2); // 取偶，保证 yuva420p 可编码
  const cropY = outH - cropH;
  const doCrop = cropH < outH;
  console.log(`[gift-effect-webp] 视频 ${info.videoW}×${info.videoH} | rgbFrame=[${info.rgbFrame}] aFrame=[${info.aFrame}] | 输出 ${outW}×${outH} @ ${fps}fps`);
  console.log(`[gift-effect-webp] 高度保留 ${(opts.keepH * 100).toFixed(1)}%: 底部向上裁剪至 ${outW}×${cropH} (y=${cropY})`);

  // 3. 下载 mp4 到临时目录
  const tmpMp4 = path.join(os.tmpdir(), `gift-effect-${giftId}-${Date.now()}.mp4`);
  const base = opts.out
    ? path.resolve(ROOT, opts.out).replace(/\.(webp|webm|gif)$/i, "")
    : path.join(OUTPUT_DIR, `gift-effect-${giftId}`);
  const paths = { webp: `${base}.webp`, webm: `${base}.webm`, gif: `${base}.gif` };

  try {
    console.log(`[gift-effect-webp] 下载视频: ${effect.web_mp4}`);
    await download(effect.web_mp4, tmpMp4);

    // 4. ffmpeg 合成：rgb 区缩放至输出尺寸 + a 区取 R 通道作 alpha 合并
    const ffmpeg = resolveFfmpeg(false);       // webp/gif（mfa conda ffmpeg 即可）
    const ffmpegVpx = resolveFfmpeg(true);     // webm 需要带 libvpx-vp9 的 ffmpeg
    console.log(`[gift-effect-webp] ffmpeg: ${ffmpeg}`);
    console.log(`[gift-effect-webp] ffmpeg(libvpx): ${ffmpegVpx}`);
    await fs.mkdir(path.dirname(paths.webp), { recursive: true });

    // 公共滤镜：合成带 alpha 的 bgra 视频流 [out]
    // keepH 裁剪在 alphamerge 之后进行（宽度不变，保留底部向上 cropH 高度）
    const baseFilter = [
      `[0:v]crop=${rw}:${rh}:${rx}:${ry},scale=${outW}:${outH}:flags=bicubic,setsar=1[rgb]`,
      `[0:v]crop=${aw}:${ah}:${ax}:${ay},format=gbrp,extractplanes=r,format=gray,scale=${outW}:${outH}:flags=bicubic,setsar=1[al]`,
      `[rgb][al]alphamerge,format=bgra${doCrop ? `,crop=${outW}:${cropH}:0:${cropY}` : ""},fps=${fps}[out]`,
    ].join(";");

    // 4a. webp（libwebp，带透明动画）
    await runFfmpeg(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", tmpMp4,
      "-filter_complex", baseFilter,
      "-map", "[out]",
      "-an", "-sn",
      "-c:v", "libwebp",
      "-lossless", "0",
      "-q:v", String(opts.quality),
      "-loop", "0",
      paths.webp,
    ]);

    // 4b. gif（palettegen 保留透明；GIF 为 1-bit 单色透明）
    //
    // 特效动画开头通常有若干全透明帧，会带来两个问题：
    //   1. GIF 编码器默认 offsetting 优化把与上一帧内容相同的帧写成 1×1 子图块，
    //      导致文件显示 1×1 → 加 -gifflags -offsetting 让每帧写满完整尺寸；
    //   2. 缩略图取首帧渲染，首帧全透明则没有缩略图 → 预扫描 alpha 找到首个可见帧，
    //      GIF 从该帧开始（跳过的帧本来就是全透明的，视觉无损失）。
    let gifStartFrame = 0;
    try {
      const scanLog = await runFfmpegCapture(ffmpeg, [
        "-hide_banner", "-loglevel", "info", "-y",
        "-i", tmpMp4,
        "-filter_complex", `${baseFilter};[out]alphaextract,signalstats,metadata=print[stat]`,
        "-map", "[stat]",
        "-an", "-sn",
        "-f", "null", "-",
      ]);
      // 用与 paletteuse alpha_threshold=128 一致的阈值判断可见，
      // 避免缩放噪声（YMAX=1~127）被误判为可见、首帧在 GIF 里仍是全透明
      const ymaxs = [...scanLog.matchAll(/lavfi\.signalstats\.YMAX=(\d+)/g)].map(m => Number(m[1]));
      const firstVisible = ymaxs.findIndex(v => v >= 128);
      if (firstVisible > 0) gifStartFrame = firstVisible;
      console.log(`[gift-effect-webp] GIF 首个可见帧: ${gifStartFrame} / 共 ${ymaxs.length} 帧`);
    } catch (err) {
      console.warn(`[gift-effect-webp] 首帧可见性扫描失败（跳过裁剪）: ${err?.message || err}`);
    }
    const gifTrim = gifStartFrame > 0
      ? `trim=start_frame=${gifStartFrame},setpts=PTS-STARTPTS,`
      : "";
    const gifFilter = [
      baseFilter,
      `[out]${gifTrim}split[gifin][palin]`,
      "[palin]palettegen=reserve_transparent=1:stats_mode=diff[pal]",
      "[gifin][pal]paletteuse=new=1:alpha_threshold=128[gout]",
    ].join(";");
    await runFfmpeg(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", tmpMp4,
      "-filter_complex", gifFilter,
      "-map", "[gout]",
      "-an", "-sn",
      "-gifflags", "-offsetting", // 每帧写满尺寸，避免 1×1 子图块（缩略图/尺寸显示异常）
      "-loop", "0",
      paths.gif,
    ]);

    // 4c. webm（libvpx-vp9，yuva420p 真 alpha 透明通道）
    await runFfmpeg(ffmpegVpx, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", tmpMp4,
      "-filter_complex", baseFilter,
      "-map", "[out]",
      "-an", "-sn",
      "-c:v", "libvpx-vp9",
      "-pix_fmt", "yuva420p",
      "-b:v", "0",
      "-crf", String(Math.max(1, Math.round((100 - opts.quality) * 0.6))), // quality 90 → crf 6
      "-row-mt", "1",
      "-deadline", "good",
      "-cpu-used", "2",
      "-loop", "0",
      paths.webm,
    ]);

    // 5. 输出结果
    for (const fmt of ["webp", "gif", "webm"]) {
      const stat = await fs.stat(paths[fmt]);
      console.log(`[gift-effect-webp] 完成: ${paths[fmt]} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  } finally {
    await fs.rm(tmpMp4, { force: true });
  }
}

main().catch(err => {
  console.error(`[gift-effect-webp] 失败: ${err?.message || err}`);
  process.exit(1);
});
