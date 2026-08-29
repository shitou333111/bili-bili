/**
 * 直播间弹幕发送 - 客户端
 *
 * 平台差异：
 * - Tauri（原生）：直接连 B站 msg/send 接口（带登录 Cookie + CSRF）
 * - Web：受浏览器 CORS 限制，走服务器代理 /api/barrage/send
 *
 * 发送接口：https://api.live.bilibili.com/msg/send
 * 必要参数（来自 bilibili-API-collect 官方文档）：
 *   csrf（cookie 中的 bili_jct）、roomid、msg、rnd（当前秒时间戳，缺失则冷却 90s，携带则 5s）、
 *   fontsize、color（官方标注"实际无效果"，固定白色 16777215）
 * 非必要参数：mode（默认 1）、bubble、csrf_token、statistics、reply_* 等均省略。
 */

import { getPlatform, type Platform } from "./platform";
import { resolveSession } from "./stats-client";
import {
  ensureValidCredentialClient,
  extractCookieValue,
} from "./bilibili/cookie-refresh-client";
import { serverPost } from "./server-api";

/** B站 msg/send 返回结构 */
export type DanmakuResult = {
  code: number;
  message?: string;
  msg?: string;
  data?: unknown;
};

/**
 * 发送弹幕到指定直播间
 * @param roomId 直播间 id（长号）
 * @param message 弹幕内容
 */
export async function sendDanmaku(roomId: number, message: string): Promise<DanmakuResult> {
  const platform: Platform = await getPlatform();
  if (platform.isNative) {
    return sendDanmakuNative(platform, roomId, message);
  }
  // Web：走服务器代理
  try {
    const r = (await serverPost("/api/barrage/send", {
      roomid: roomId,
      message,
    })) as DanmakuResult;
    return r;
  } catch {
    return { code: -1, message: "发送弹幕失败，请检查网络" };
  }
}

/** 提取 cookie 字符串中的 csrf（bili_jct） */
function extractCsrf(cookies: string[], cookieHeader: string): string {
  const fromArray = extractCookieValue(cookies, "bili_jct");
  if (fromArray) return fromArray;
  return cookieHeader.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
}

/** 构建 msg/send 请求体（application/x-www-form-urlencoded） */
function buildSendBody(roomId: number, message: string, csrf: string): string {
  const rnd = Math.floor(Date.now() / 1000);
  return new URLSearchParams({
    roomid: String(roomId),
    msg: message,
    rnd: String(rnd),
    fontsize: "25",
    color: "16777215",
    csrf,
  }).toString();
}

/** Tauri 直连发送 */
async function sendDanmakuNative(
  platform: Platform,
  roomId: number,
  message: string,
): Promise<DanmakuResult> {
  try {
    const session = await resolveSession(platform);
    if (!session) return { code: -1, message: "未登录，无法发送弹幕" };
    if (session.source === "server") {
      return { code: -1, message: "该功能需要登录凭证，服务器账号无法使用" };
    }
    const cred = await ensureValidCredentialClient(platform, session);
    if (!cred.valid) return { code: -1, message: "登录凭证失效，请重新登录" };
    const csrf = extractCsrf(cred.session.biliCookies ?? [], cred.cookie);
    if (!csrf) return { code: -1, message: "未找到登录凭证(csrf)，请重新登录" };
    const data = await platform.fetchBilibiliJson<DanmakuResult>({
      url: "https://api.live.bilibili.com/msg/send",
      method: "POST",
      body: buildSendBody(roomId, message, csrf),
      cookie: cred.cookie,
      live: true,
    });
    return data ?? { code: -1, message: "发送弹幕失败" };
  } catch (err) {
    console.error("[Barrage] 直连发送弹幕失败:", err);
    return { code: -1, message: "发送弹幕失败，请检查网络" };
  }
}
