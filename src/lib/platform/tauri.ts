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
const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.1.2:3000";

export const tauriPlatform: Platform = {
  name: "tauri",
  isNative: true,

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

  async fetchRaw(url: string, cookie?: string): Promise<RawResponse> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const headers: Record<string, string> = { ...BILIBILI_WEB_HEADERS };
    if (cookie) headers["Cookie"] = cookie;

    const response = await tauriFetch(url, {
      method: "GET",
      headers,
    });

    // Tauri HTTP plugin 返回的 Response 与 Web 标准兼容
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
      headers: {
        getSetCookie: () => [],
      },
    };
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
    const formData = new FormData();
    formData.append("mid", String(mid));
    formData.append("uname", uname);
    for (const [filename, content] of Object.entries(files)) {
      const blob = new Blob([content], { type: "application/json" });
      formData.append("files", blob, filename);
    }
    await tauriFetch(`${SERVER_BASE_URL}/api/upload`, {
      method: "POST",
      body: formData,
    });
  },

  async fetchRemoteUserData(mid: number, uname: string): Promise<Record<string, string>> {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const resp = await tauriFetch(
      `${SERVER_BASE_URL}/api/upload?mid=${mid}&uname=${encodeURIComponent(uname)}`,
      { method: "GET", headers: { "Accept": "application/json" } },
    );
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

  publicEncrypt(_key: string, _data: Buffer): Buffer {
    // Tauri 中 crypto 模块不可用，使用 Web Crypto API
    // 注意：OAEP 加密需要 SubtleCrypto，这里简化处理
    throw new Error("RSA-OAEP not available in Tauri; use Web Crypto API instead");
  },
};