/**
 * 展示模块 —— 本地视频辅助：时长探测与播放片段（媒体片段 #t=start,end）。
 *
 * 时长探测通过加载 <video> 元数据实现，不做整段解码：1 分钟内视频通常 <1s 返回，
 * 超长视频也只会解析头部的 moov/index，避免整段读取。
 *
 * 视频不再走 Tauri asset 协议（convertFileSrc），统一由内嵌 HTTP 服务器经
 * `/api/video?p=<绝对路径>`（自带 Range）提供。探测时用完整 URL（baseUrl + 相对源），
 * 主窗口（原生）传展示服务器 baseUrl（http://127.0.0.1:<port>）；
 * 浏览器源/编辑 iframe（同源）baseUrl 为空即可用相对 `/api/video` 地址。
 */

/** 本地视频绝对路径 → 浏览器源服务器可加载的相对 URL（与 danmaku.ts 内实现保持一致）。 */
export function videoServePath(path: string): string {
  return path ? `/api/video?p=${encodeURIComponent(path)}` : "";
}

/**
 * 拼接播放片段 src。WebView2(Chromium) 原生支持媒体片段语法 `#t=start,end`：
 *  - end > 0：`#t=start,end`（播 start 到 end）
 *  - 仅 start > 0：`#t=start`（从 start 播到末尾）
 *  - 都为 0：原始 src（播放整段）
 */
export function srcWithFragment(src: string, startSec: number, endSec: number): string {
  if (!src) return src;
  if (endSec > 0) return `${src}#t=${startSec},${endSec}`;
  if (startSec > 0) return `${src}#t=${startSec}`;
  return src;
}

/**
 * 读取本地视频时长（秒）。仅读元数据；失败/超时 reject。
 * @param path 本地视频绝对路径（经 /api/video 服务器提供）
 * @param baseUrl 展示服务器的完整 URL（如 http://127.0.0.1:25100）；同源环境可传 "" 用相对地址
 */
export function probeVideoDuration(path: string, baseUrl = "", timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    let duration = 0;
    let done = false;
    const timer = window.setTimeout(() => finish(new Error("读取视频时长超时")), timeoutMs);
    function finish(err?: Error) {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeAttribute("src");
      try {
        v.load();
      } catch {
        /* 忽略清理副作用 */
      }
      if (err) reject(err);
      else resolve(duration);
    }
    v.onloadedmetadata = () => {
      duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      finish();
    };
    v.onerror = () => finish(new Error("无法读取视频信息"));
    try {
      v.src = baseUrl ? `${baseUrl}${videoServePath(path)}` : videoServePath(path);
    } catch (e) {
      finish(e instanceof Error ? e : new Error("素材地址生成失败"));
    }
  });
}

/** 秒 → mm:ss */
export function secToTime(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** mm:ss → 秒；冒号可为英文 ":" 或中文 "："，也可省略（仅纯 4 位数字如 "0123" 自动识别为 01:23）。
 *  格式非法或秒数越界（秒 >59）返回 null。 */
export function timeToSec(s: string): number | null {
  const t = (s ?? "").trim();
  // 带冒号：mm:ss（分钟 1~3 位，秒 1~2 位），支持英文/中文冒号
  const m = /^(\d{1,3})[:：](\d{1,2})$/.exec(t);
  if (m) {
    const ss = Number(m[2]);
    if (ss > 59) return null;
    return Number(m[1]) * 60 + ss;
  }
  // 不带冒号的纯 4 位数字：前两位为分钟、后两位为秒
  const n = /^(\d{4})$/.exec(t);
  if (n) {
    const ss = Number(n[1].slice(2, 4));
    if (ss > 59) return null;
    return Number(n[1].slice(0, 2)) * 60 + ss;
  }
  return null;
}