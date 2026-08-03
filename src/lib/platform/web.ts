/**
 * Web 平台实现 - 通过 Next.js API routes 和 Node.js 模块
 */

import { randomUUID, publicEncrypt, constants } from "crypto";
import { promises as fs } from "fs";
import path from "path";
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

const DATA_DIR = path.join(process.cwd(), ".data");

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

  // ========== 文件 I/O ==========

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, "utf-8");
  },

  async writeFile(filePath: string, data: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data, "utf-8");
  },

  async mkdir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  },

  async readdir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch {
      return [];
    }
  },

  async unlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {}
  },

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },

  getDataDir(): string {
    return DATA_DIR;
  },

  // ========== 会话管理 ==========

  async getSessionState() {
    const { readState } = await import("@/lib/auth/session");
    return readState();
  },

  async setSessionState(state) {
    const { writeState } = await import("@/lib/auth/session");
    return writeState(state);
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
    return process.cwd();
  },

  randomUUID(): string {
    return randomUUID();
  },

  publicEncrypt(key: string, data: Buffer): Buffer {
    return publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      data,
    );
  },
};