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
    const platform = await p();
    if (platform.isNative) {
      const { clientGetAccounts } = await import("./auth/client-auth");
      return clientGetAccounts(platform);
    }
    return webFetch("/api/auth/accounts");
  },

  /** 获取登录状态 */
  async getStatus(): Promise<{ code: number; message?: string; data: { loggedIn: boolean; reason?: string; expired?: boolean; sid?: string; uname?: string; mid?: number; face?: string } }> {
    const platform = await p();
    if (platform.isNative) {
      const { clientGetStatus } = await import("./auth/client-auth");
      return clientGetStatus(platform);
    }
    return webFetch("/api/auth/status");
  },

  /** 生成登录二维码 */
  async generateQR(): Promise<{ code: number; message: string; data?: { qrcode_key: string; url: string; image: string } }> {
    const platform = await p();
    if (platform.isNative) {
      const { clientQRGenerate } = await import("./auth/client-auth");
      return clientQRGenerate(platform);
    }
    return webFetch("/api/auth/qr/generate");
  },

  /** 轮询二维码登录状态 */
  async pollQR(qrcodeKey: string): Promise<{ code: number; message: string; data?: { code: number; message: string; url: string; refresh_token: string; timestamp: number; sid?: string; userToken?: string } }> {
    const platform = await p();
    if (platform.isNative) {
      const { clientQRPoll } = await import("./auth/client-auth");
      return clientQRPoll(platform, qrcodeKey);
    }
    return webFetch(`/api/auth/qr/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
  },

  /** 切换账号 */
  async switchAccount(sid: string): Promise<{ code: number }> {
    const platform = await p();
    if (platform.isNative) {
      const { clientSwitch } = await import("./auth/client-auth");
      return clientSwitch(platform, sid);
    }
    return webPost("/api/auth/switch", { sid });
  },

  /** 登出 */
  async logout(): Promise<void> {
    const platform = await p();
    if (platform.isNative) {
      const { clientLogout } = await import("./auth/client-auth");
      return clientLogout(platform);
    }
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
      return fetchAnchorGifts(platform, { refresh });
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