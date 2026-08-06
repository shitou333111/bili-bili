/**
 * 平台抽象层 - 类型定义
 * 所有业务代码通过此接口调用平台能力，不感知 Web/Tauri 差异
 */

import type { AuthSession, SessionState } from "@/lib/auth/session";

// ==================== HTTP 请求 ====================

export type FetchJsonOptions = {
  url: string;
  cookie?: string;
  method?: "GET" | "POST";
  body?: string;
  mobile?: boolean;
  live?: boolean;
};

export type RawResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  headers: {
    getSetCookie?: () => string[];
  };
};

// ==================== 文件 I/O ====================

// ==================== 平台接口 ====================

export interface Platform {
  // ---------- 平台标识 ----------
  readonly name: "web" | "tauri";
  /** 是否是 Tauri 客户端（有原生能力） */
  readonly isNative: boolean;

  // ---------- B站 API 请求（解决 CORS） ----------
  /** 发起 B站 API 请求（带 UA/Referer 等头） */
  fetchBilibiliJson<T>(options: FetchJsonOptions): Promise<T>;
  /** 发起原始 HTTP 请求（用于获取 Set-Cookie 等） */
  fetchRaw(url: string, cookie?: string): Promise<RawResponse>;
  /** 获取 B站 buvid3 访客 Cookie */
  getBuvidCookie(): Promise<string>;

  // ---------- 文件 I/O ----------
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** 获取应用数据根目录（Tauri 下为原生应用数据目录，需异步解析） */
  getDataDir(): Promise<string>;

  // ---------- 会话管理 ----------
  getSessionState(): Promise<SessionState>;
  setSessionState(state: SessionState): Promise<void>;

  // ---------- 配置管理 ----------
  /** 从服务器拉取远程配置（admin-config.json） */
  fetchRemoteConfig(): Promise<Record<string, unknown> | null>;
  /** 上传数据文件到服务器 */
  uploadUserData(mid: number, uname: string, files: Record<string, string>): Promise<void>;
  /** 从服务器拉取指定用户的数据 */
  fetchRemoteUserData(mid: number, uname: string): Promise<Record<string, string>>;

  // ---------- 工具 ----------
  /** 获取项目根目录路径 */
  getProjectRoot(): string;
  /** 获取 crypto 模块的 randomUUID */
  randomUUID(): string;
  /** 获取 crypto 模块的 publicEncrypt */
  publicEncrypt?(key: string, data: Buffer): Buffer;
}