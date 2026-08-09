/**
 * Web 平台实现 - 浏览器环境
 *
 * Web 模式下，所有 B站 数据与本地文件操作均通过服务器路由（/api/...）完成，
 * 浏览器端不需要（也无法）直接读写服务器文件系统或直连 B站。
 *
 * 该实现只用于：
 * 1. 检测 isNative = false（决定走服务器路由）
 * 2. 提供浏览器可用的 fetchBilibiliJson / fetchRaw / getBuvidCookie / randomUUID
 *
 * 依赖 Node 内置模块（fs/path/crypto publicEncrypt）的方法在浏览器中不可用，
 * 且在本架构下不会被调用（数据流走服务器路由），故统一抛错以避免误用。
 */

import type { Platform, FetchJsonOptions, RawResponse } from "./types";

// B站请求头（与 bilibili/client.ts 保持一致）
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

/** Web 浏览器下不可用的能力（数据流走服务器路由，不应被调用） */
function unavailable(name: string): never {
  throw new Error(`[webPlatform] ${name} 在浏览器不可用，请通过服务器路由访问`);
}

export const webPlatform: Platform = {
  name: "web",
  isNative: false,

  async fetchBilibiliJson<T>(options: FetchJsonOptions): Promise<T> {
    const { url, cookie, method = "GET", body, mobile = false, live = false } = options;
    const headers = new Headers(
      mobile ? BILIBILI_MOBILE_HEADERS : live ? BILIBILI_LIVE_HEADERS : BILIBILI_WEB_HEADERS
    );
    if (cookie) headers.set("Cookie", cookie);
    if (body) headers.set("Content-Type", "application/x-www-form-urlencoded");

    const response = await fetch(url, { method, headers, body, cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Bilibili request failed: ${response.status}`);
    }
    return (await response.json()) as T;
  },

  async fetchRaw(url: string, cookie?: string): Promise<RawResponse> {
    const headers = new Headers(BILIBILI_WEB_HEADERS);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
    return {
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
      headers: {
        getSetCookie: () => {
          try {
            return response.headers.getSetCookie?.() ?? [];
          } catch {
            return [];
          }
        },
      },
    };
  },

  async getBuvidCookie(): Promise<string> {
    try {
      const resp = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: BILIBILI_WEB_HEADERS,
        cache: "no-store",
      });
      if (!resp.ok) throw new Error(`SPI failed: ${resp.status}`);
      const data = await resp.json() as { code: number; data?: { b_3: string; b_4: string } };
      if (data.code === 0 && data.data?.b_3) {
        return `buvid3=${data.data.b_3};buvid4=${data.data.b_4 || ""}`;
      }
      throw new Error(`SPI code=${data.code}`);
    } catch {
      // Fallback: 访问首页从 Set-Cookie 获取
      try {
        const resp = await fetch("https://www.bilibili.com/", {
          headers: BILIBILI_WEB_HEADERS,
          cache: "no-store",
          redirect: "follow",
        });
        const cookies = resp.headers.getSetCookie?.() || [];
        const buvid3 = cookies.find((c: string) => c.startsWith("buvid3="));
        if (buvid3) return buvid3.split(";")[0];
      } catch {}
      return "";
    }
  },

  // ========== 文件 I/O（浏览器不可用）==========

  async readFile(_filePath: string): Promise<string> {
    return unavailable("readFile");
  },

  async writeFile(_filePath: string, _data: string): Promise<void> {
    unavailable("writeFile");
  },

  async mkdir(_dirPath: string): Promise<void> {
    unavailable("mkdir");
  },

  async readdir(_dirPath: string): Promise<string[]> {
    return unavailable("readdir");
  },

  async unlink(_filePath: string): Promise<void> {
    unavailable("unlink");
  },

  async exists(_filePath: string): Promise<boolean> {
    return unavailable("exists");
  },

  async getDataDir(): Promise<string> {
    return unavailable("getDataDir");
  },

  // ========== 会话管理（浏览器走服务器路由）==========

  async getSessionState() {
    return { currentSid: null as string | null, sessions: [] };
  },

  async setSessionState() {
    unavailable("setSessionState");
  },

  // ========== 配置/数据 ==========

  async fetchRemoteConfig(): Promise<Record<string, unknown> | null> {
    try {
      const resp = await fetch("/api/admin/config");
      const data = await resp.json();
      return (data.code === 0 && data.data) ? data.data : null;
    } catch {
      return null;
    }
  },

  async uploadUserData(mid: number, uname: string, files: Record<string, string>): Promise<void> {
    await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mid, uname, files }),
    });
  },

  async fetchRemoteUserData(mid: number, uname: string): Promise<Record<string, string>> {
    const resp = await fetch(`/api/upload?mid=${mid}&uname=${encodeURIComponent(uname)}`);
    const data = await resp.json();
    return data.code === 0 ? data.data?.files ?? {} : {};
  },

  // ========== 工具 ==========

  getProjectRoot(): string {
    return unavailable("getProjectRoot");
  },

  randomUUID(): string {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID) return c.randomUUID();
    // 降级：Math.random 拼接（仅 Web 浏览器，非安全场景）
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  },

  publicEncrypt(): Buffer {
    return unavailable("publicEncrypt");
  },
};
