/**
 * Tauri 平台实现 - 通过 Tauri 插件调用原生能力
 * 使用 @tauri-apps/plugin-http 解决 CORS
 * 使用 @tauri-apps/plugin-fs 读写本地文件
 * 使用 @tauri-apps/plugin-store 管理会话
 */

import type { Platform, FetchJsonOptions, RawResponse } from "./types";
import type { AuthSession } from "../auth/session";

const BILIBILI_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BILIBILI_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 os/android model/SM-G9910 build/8870400 osVer/13 sdkInt/33 network/2 BiliApp/8870400 mobi_app/android";

const BILIBILI_WEB_HEADERS: Record<string, string> = {
  "User-Agent": BILIBILI_WEB_UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.bilibili.com/",
  "Origin": "https://www.bilibili.com",
};

const BILIBILI_MOBILE_HEADERS: Record<string, string> = {
  "User-Agent": BILIBILI_MOBILE_UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};

const BILIBILI_LIVE_HEADERS: Record<string, string> = {
  "User-Agent": BILIBILI_WEB_UA,
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};

/** 服务器地址（配置中心 + 数据收集） */
const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

/** 稳定内容哈希：用于增量上传判断文件是否有变化 */
function contentHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c ^ (i & 0xff)), 31) >>> 0;
  }
  return h1.toString(16) + h2.toString(16) + "-" + s.length.toString(16);
}

/**
 * 易变元数据字段：仅记录"最近导出/拉取时间"，不影响数据本身。
 * 这些字段在每次刷新时都会重新写入（如 pay-records/盲盒/合成记录的 exportedAt、
 * 盲盒信息的 updated_at、主播礼物的 last_fetch），若参与哈希比较会导致
 * "数据没变但文件每次都要重传"（33MB 全量重加密+重传 → 绿按钮长时间转、主线程卡顿）。
 */
const VOLATILE_META_KEYS = ["exportedAt", "updated_at", "last_fetch", "updatedAt"];

/** 稳定内容哈希：剔除易变元数据时间戳后再哈希，用于增量上传判断"数据是否有实质变化" */
function stableContentHash(content: string): string {
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const copy: Record<string, unknown> = { ...obj };
      for (const k of VOLATILE_META_KEYS) delete copy[k];
      return contentHash(JSON.stringify(copy));
    }
  } catch {
    // 非 JSON 文件（或无法解析）按原样哈希
  }
  return contentHash(content);
}

/** 检测运行系统（Tauri WebView 沿用 navigator 即可，无需额外插件权限） */
function detectOs(): Platform["os"] {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  const plat = navigator.platform || "";
  if (/windows|win32|win64/i.test(ua) || /win32|win64/i.test(plat)) return "windows";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/linux/i.test(ua)) return "linux";
  if (/macintosh|mac os|darwin/i.test(ua)) return "macos";
  return "other";
}

export const tauriPlatform: Platform = {
  name: "tauri",
  isNative: true,
  os: detectOs(),

  async fetchBilibiliJson<T>(options: FetchJsonOptions): Promise<T> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const { url, cookie, method = "GET", body, mobile = false, live = false } = options;
    const headerMap = mobile ? BILIBILI_MOBILE_HEADERS : live ? BILIBILI_LIVE_HEADERS : BILIBILI_WEB_HEADERS;
    const headers: Record<string, string> = { ...headerMap };
    if (cookie) headers["Cookie"] = cookie;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await tauriFetch(url, {
      method,
      headers,
      body,
    });

    if (!response.ok) {
      throw new Error(`Bilibili request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  },

  async fetchRaw(
    url: string,
    cookie?: string,
    options?: { method?: "GET" | "POST"; body?: string },
  ): Promise<RawResponse> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const headers: Record<string, string> = { ...BILIBILI_WEB_HEADERS };
    if (cookie) headers["Cookie"] = cookie;
    if (options?.body) headers["Content-Type"] = "application/x-www-form-urlencoded";

    const response = await tauriFetch(url, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body,
    });

    // Tauri HTTP plugin 返回的 Response 已暴露 set-cookie 响应头（见 plugin-http dist-js）
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
      headers: {
        getSetCookie: () => {
          try {
            if (typeof response.headers.getSetCookie === "function") {
              return response.headers.getSetCookie();
            }
            const raw = response.headers.get("set-cookie");
            return raw ? [raw] : [];
          } catch {
            return [];
          }
        },
      },
    };
  },

  async fetchArrayBuffer(url: string, cookie?: string): Promise<ArrayBuffer> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const headers: Record<string, string> = {
      "User-Agent": BILIBILI_WEB_UA,
      "Referer": "https://live.bilibili.com/",
      "Origin": "https://live.bilibili.com",
    };
    if (cookie) headers["Cookie"] = cookie;
    const response = await tauriFetch(url, { method: "GET", headers });
    if (!response.ok) {
      throw new Error(`二进制下载失败 HTTP ${response.status}`);
    }
    return await response.arrayBuffer();
  },

  async getBuvidCookie(): Promise<string> {
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const resp = await tauriFetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: BILIBILI_WEB_HEADERS,
      });
      if (!resp.ok) throw new Error(`SPI failed: ${resp.status}`);
      const data = await resp.json() as { code: number; data?: { b_3: string; b_4: string } };
      if (data.code === 0 && data.data?.b_3) {
        return `buvid3=${data.data.b_3};buvid4=${data.data.b_4 || ""}`;
      }
      throw new Error(`SPI code=${data.code}`);
    } catch {
      return "";
    }
  },

  // ========== 文件 I/O ==========

  async readFile(filePath: string): Promise<string> {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(filePath);
  },

  async writeFile(filePath: string, data: string): Promise<void> {
    const { writeTextFile, mkdir: fsMkdir } = await import("@tauri-apps/plugin-fs");
    // 确保父目录存在
    const parentDir = filePath.replace(/[/\\][^/\\]+$/, "");
    if (parentDir && parentDir !== filePath) {
      try {
        await fsMkdir(parentDir, { recursive: true });
      } catch {}
    }
    await writeTextFile(filePath, data);
  },

  async mkdir(dirPath: string): Promise<void> {
    const { mkdir: fsMkdir } = await import("@tauri-apps/plugin-fs");
    await fsMkdir(dirPath, { recursive: true });
  },

  async readdir(dirPath: string): Promise<string[]> {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    try {
      const entries = await readDir(dirPath);
      return entries.map((e) => e.name);
    } catch {
      return [];
    }
  },

  async unlink(filePath: string): Promise<void> {
    const { remove } = await import("@tauri-apps/plugin-fs");
    try {
      await remove(filePath);
    } catch {}
  },

  async exists(filePath: string): Promise<boolean> {
    const { exists: fsExists } = await import("@tauri-apps/plugin-fs");
    try {
      return await fsExists(filePath);
    } catch {
      return false;
    }
  },

  async getDataDir(): Promise<string> {
    // 使用原生 FS API 的应用数据目录（Android: files/, iOS: Library/Application Support）
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    return join(await appDataDir(), "data");
  },

  // ========== 会话管理 ==========

  async getSessionState() {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("bili-live-state.json", { autoSave: false });
    const state = await store.get<{ currentSid: string | null; sessions: AuthSession[] }>("state");
    return state ?? { currentSid: null, sessions: [] };
  },

  async setSessionState(state) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("bili-live-state.json", { autoSave: false });
    await store.set("state", state);
    await store.save();
  },

  // ========== 配置/数据 ==========

  async fetchRemoteConfig(): Promise<Record<string, unknown> | null> {
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const resp = await tauriFetch(`${SERVER_BASE_URL}/api/config`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      const data = await resp.json() as { code: number; data?: Record<string, unknown> };
      return data.code === 0 ? (data.data ?? null) : null;
    } catch {
      return null;
    }
  },

  async uploadUserData(mid: number, uname: string, files: Record<string, string>): Promise<void> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs");

    // 增量上传：记录每个文件上次上传的内容哈希，只上传有变化的文件
    const statePath = await join(await appDataDir(), "data", "upload-state.json");
    let prev: Record<string, Record<string, string>> = {};
    try { prev = JSON.parse(await readTextFile(statePath)); } catch { /* 首次无记录 */ }
    const userPrev = prev[String(mid)] ?? {};

    // 诊断日志（仅 console，不影响 UI）：确认上传阶段是不是慢/卡顿的瓶颈
    const totalBytes = Object.values(files).reduce((s, c) => s + new TextEncoder().encode(c).length, 0);
    console.log(
      `[Upload] 开始：待检查文件 ${Object.keys(files).length} 个，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    const tHash0 = performance.now();
    const toSend: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
      const h = stableContentHash(content);
      if (userPrev[name] !== h) toSend[name] = content;
    }
    const hashMs = performance.now() - tHash0;
    console.log(`[Upload] contentHash 比较耗时 ${hashMs.toFixed(0)} ms，需上传 ${Object.keys(toSend).length} 个文件`);

    if (Object.keys(toSend).length === 0) {
      // 无变化文件，直接跳过（保留一行日志便于观察是否每次都误判为有变化）
      console.log("[Upload] 无变化文件，跳过上传");
      return;
    }

    // 分批加密+上传：重建数据库等场景下 toSend 可能非常大（所有文件全量重传），
    // 一次性对整个 payload 做 AES-256-GCM 加密会长时间占满主线程（CPU/内存暴涨）且
    // 超过单请求超时导致"Request cancelled"。按大小分批后逐批加密上传：
    //  - 每批加密数据量小，主线程不会被长时间阻塞
    //  - 每批 15s 超时足够，避免误杀
    // 服务器 /api/upload 本身就是"增量只写本次携带的文件"，分批多次 POST 等价于一次全量 POST。
    const { encryptUploadPayload } = await import("../upload-crypto");
    const BATCH_BYTES = 1_000_000; // 每批约 1MB 明文
    const batches: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    let curBytes = 0;
    for (const [name, content] of Object.entries(toSend)) {
      const bytes = new TextEncoder().encode(content).length;
      if (curBytes > 0 && curBytes + bytes > BATCH_BYTES) {
        batches.push(cur);
        cur = {};
        curBytes = 0;
      }
      cur[name] = content;
      curBytes += bytes;
    }
    if (Object.keys(cur).length > 0) batches.push(cur);

    // 诊断日志：打印每批字节数，确认是否存在"单个大文件独占一个巨型批次"导致主线程长时间阻塞
    console.log(
      `[Upload] 分 ${batches.length} 批，各批明文字节 [${batches
        .map((b) => Object.values(b).reduce((s, c) => s + new TextEncoder().encode(c).length, 0))
        .join(", ")}]`,
    );

    const tTotal0 = performance.now();
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const batchBytes = Object.values(batch).reduce((s, c) => s + new TextEncoder().encode(c).length, 0);
      // 诊断日志：加密前先打印，若此条出现而"批次完成"未出现，则卡点在加密或上传
      console.log(`[Upload] 批次 ${bi + 1}/${batches.length} 开始：明文 ${(batchBytes / 1024).toFixed(1)} KB`);
      // 加密整个 batch（隐藏 uid_<mid> 目录结构、文件名与内容）后再上传，
      // 服务器用同一密钥解密后按原方案落盘。抓包者只能看到密文。
      const tEnc0 = performance.now();
      let enc: { iv: string; data: string };
      try {
        enc = await encryptUploadPayload({ mid, uname, files: batch });
      } catch (err) {
        // 诊断日志：加密异常不再静默吞掉，便于定位（正常不应发生）
        console.log(`[Upload] 批次 ${bi + 1}/${batches.length} 加密失败：${String(err)}`);
        return;
      }
      const encMs = performance.now() - tEnc0;
      // 每批带超时（AbortController），避免 /api/upload 挂起时永久 pending、
      // 导致 finishRefresh→fetchData 不返回、绿按钮一直转且控制台无任何输出。
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      let resp: Response;
      const tUp0 = performance.now();
      // 诊断日志：请求体大小 + 请求开始，若此条出现而"上传完成/异常"未出现，则卡在请求或服务端
      console.log(
        `[Upload] 批次 ${bi + 1}/${batches.length} 开始上传请求：请求体约 ${((enc.data.length + 64) / 1024 / 1024).toFixed(1)} MB → ${SERVER_BASE_URL}/api/upload`,
      );
      try {
        resp = await tauriFetch(`${SERVER_BASE_URL}/api/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enc }),
          signal: ctrl.signal,
        });
      } catch (err) {
        // 诊断日志：请求失败/超时中止不再静默吞掉，便于定位（真实原因可能是 44MB 超时或服务端无响应）
        console.log(`[Upload] 批次 ${bi + 1}/${batches.length} 上传请求异常/超时：${String(err)}`);
        return;
      } finally {
        clearTimeout(timer);
      }
      const upMs = performance.now() - tUp0;
      console.log(
        `[Upload] 批次 ${bi + 1}/${batches.length}：明文 ${(batchBytes / 1024).toFixed(1)} KB，加密 ${encMs.toFixed(0)} ms，上传 ${upMs.toFixed(0)} ms，HTTP ${resp.status}`,
      );
      if (!resp.ok) {
        // 绝对静默：上传失败不落哈希（下次重传），不打印任何日志、不阻塞整体流程
        return;
      }
    }
    console.log(`[Upload] 全部批次完成，总耗时 ${(performance.now() - tTotal0).toFixed(0)} ms`);

    // 全部批次上传成功后才更新哈希，下次据此判断哪些文件有变化
    const next = { ...userPrev };
    for (const [name, content] of Object.entries(toSend)) next[name] = stableContentHash(content);
    prev[String(mid)] = next;
    try { await writeTextFile(statePath, JSON.stringify(prev)); } catch { /* ignore */ }
  },

  async fetchRemoteUserData(mid: number, uname: string): Promise<Record<string, string>> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    // 下载服务器数据也带超时，避免挂起
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let resp: Response;
    try {
      resp = await tauriFetch(
        `${SERVER_BASE_URL}/api/upload?mid=${mid}&uname=${encodeURIComponent(uname)}`,
        { method: "GET", headers: { "Accept": "application/json" }, signal: ctrl.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    const data = await resp.json() as { code: number; data?: { files?: Record<string, string> } };
    return data.code === 0 ? (data.data?.files ?? {}) : {};
  },

  // ========== 工具 ==========

  getProjectRoot(): string {
    // Tauri 中不使用 process.cwd()，返回空串表示使用 Tauri 插件自己的路径
    return "";
  },

  randomUUID(): string {
    return crypto.randomUUID();
  },
};