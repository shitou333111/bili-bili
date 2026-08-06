/**
 * 统一 API 层
 * 
 * 在 Web 模式下：调用 Next.js API routes (fetch('/api/...'))
 * 在 Tauri 模式下：调用平台层直接处理（B站 API 通过原生层，文件 I/O 本地执行）
 * 
 * 前端组件导入此模块，无需感知平台差异。
 */

import { getPlatform } from "./platform";
import type { Platform } from "./platform/types";
import { serverApiUrl } from "./server-api";

// ==================== 内部工具 ====================

let _platformCache: Platform | null = null;

async function p(): Promise<Platform> {
  if (!_platformCache) {
    _platformCache = await getPlatform();
  }
  return _platformCache;
}

/** Web 模式：通用 fetch 封装（Tauri 下自动转发到服务器） */
async function webFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(serverApiUrl(path), { cache: "no-store", ...options });
  return res.json();
}

/** Web 模式：POST 封装（Tauri 下自动转发到服务器） */
async function webPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(serverApiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  return res.json();
}

// ==================== 认证 API ====================

export const authApi = {
  /** 获取账号列表 */
  async getAccounts(): Promise<{ code: number; data: { accounts: unknown[] } }> {
    return webFetch("/api/auth/accounts");
  },

  /** 获取登录状态 */
  async getStatus(): Promise<{ code: number; data: { isLoggedIn: boolean; uname?: string; mid?: number } }> {
    return webFetch("/api/auth/status");
  },

  /** 切换账号 */
  async switchAccount(sid: string): Promise<{ code: number }> {
    return webPost("/api/auth/switch", { sid });
  },

  /** 登出 */
  async logout(): Promise<void> {
    await fetch(serverApiUrl("/api/auth/logout"), { method: "POST" });
  },
};

// ==================== 主播数据 API ====================

export const anchorApi = {
  /** 获取主播礼物数据（触发B站数据拉取） */
  async getGifts(refresh?: boolean): Promise<unknown> {
    const platform = await p();
    if (platform.isNative) {
      // Tauri: 直接调用 B站 API 并本地处理
      // 这里需要导入完整的礼物拉取逻辑
      const { fetchAnchorGifts } = await import("./anchor-gifts-client");
      return fetchAnchorGifts(platform, refresh);
    }
    const url = refresh ? "/api/anchor/gifts?refresh=true" : "/api/anchor/gifts";
    return webFetch(url);
  },
};

// ==================== 收益记录 API ====================

export const revenueApi = {
  /** 获取收益记录 */
  async getPayRecord(refresh?: boolean): Promise<unknown> {
    const platform = await p();
    if (platform.isNative) {
      const { fetchPayRecords } = await import("./pay-record-client");
      return fetchPayRecords(platform, refresh);
    }
    const url = refresh ? "/api/revenue/pay-record?refresh=true" : "/api/revenue/pay-record";
    return webFetch(url);
  },
};

// ==================== 统计 API ====================

export const statsApi = {
  async getSynthesis(): Promise<unknown> {
    return webFetch("/api/stats/synthesis");
  },
  async getCertification(): Promise<unknown> {
    return webFetch("/api/stats/certification");
  },
  async getOther(): Promise<unknown> {
    return webFetch("/api/stats/other");
  },
  async getBlindBox(): Promise<unknown> {
    return webFetch("/api/stats/blind-box");
  },
};

// ==================== 工具 API ====================

export const toolsApi = {
  async removeFan(body: unknown): Promise<unknown> {
    return webPost("/api/tools/remove-fan", body);
  },
  async deleteMedal(body: unknown): Promise<unknown> {
    return webPost("/api/tools/delete-medal", body);
  },
  async getFans(): Promise<unknown> {
    return webFetch("/api/tools/fans");
  },
  async getMedals(): Promise<unknown> {
    return webFetch("/api/tools/medals");
  },
  async getUserInfo(): Promise<unknown> {
    return webFetch("/api/tools/user-info");
  },
};

// ==================== 礼物数据库 API ====================

export const giftDbApi = {
  async getGiftDb(): Promise<unknown> {
    const platform = await p();
    if (platform.isNative) {
      const giftDbPath = `${await platform.getDataDir()}/gift-db.json`;
      // 先尝试读取本地缓存
      let localDb: unknown = null;
      if (await platform.exists(giftDbPath)) {
        try {
          const raw = await platform.readFile(giftDbPath);
          localDb = JSON.parse(raw);
        } catch {}
      }
      // 后台从服务器同步最新版本（不阻塞返回）
      this.syncFromServer(platform, giftDbPath).catch(() => {});
      return localDb || { gifts: {} };
    }
    return webFetch("/api/gift-db");
  },

  /** 从服务器拉取 gift-db.json 并保存到本地 */
  async syncFromServer(platform: Platform, localPath: string): Promise<void> {
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const resp = await tauriFetch(`${serverApiUrl("/api/gift-db")}`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });
      if (!resp.ok) return;
      const data = await resp.json() as { code: number; data?: Record<number, { name: string; img: string }> };
      if (data.code === 0 && data.data) {
        const db = { gifts: data.data, exportedAt: new Date().toISOString() };
        await platform.writeFile(localPath, JSON.stringify(db, null, 2));
        console.log(`[GiftDb] 已从服务器同步 ${Object.keys(data.data).length} 条礼物数据`);
      }
    } catch (e) {
      console.warn("[GiftDb] 从服务器同步失败:", e instanceof Error ? e.message : String(e));
    }
  },
};

// ==================== 配置 API ====================

export const configApi = {
  /** 从服务器拉取远程配置 */
  async fetchRemote(): Promise<Record<string, unknown> | null> {
    const platform = await p();
    return platform.fetchRemoteConfig();
  },

  /** 上传用户数据到服务器 */
  async uploadData(mid: number, uname: string, files: Record<string, string>): Promise<void> {
    const platform = await p();
    return platform.uploadUserData(mid, uname, files);
  },

  /** 从服务器拉取指定用户的数据 */
  async fetchUserData(mid: number, uname: string): Promise<Record<string, string>> {
    const platform = await p();
    return platform.fetchRemoteUserData(mid, uname);
  },
};

// ==================== 类型导出 ====================

export type { Platform } from "./platform/types";