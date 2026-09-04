/**
 * 直播间弹幕发送 - 客户端
 *
 * 平台差异：
 * - Tauri（原生）：直接连 B站 msg/send 接口（带登录 Cookie + CSRF）
 * - Web：受浏览器 CORS 限制，走服务器代理 /api/barrage/send
 *
 * 发送接口：https://api.live.bilibili.com/msg/send
 * 必要参数（来自 bilibili-API-collect 官方文档）：
 *   csrf（cookie 中的 bili_jct）、roomid、msg、rnd（当前时间戳×1000000，即 16 位；
 *     缺失或格式不符则冷却 90s，正确携带则 5s。与官方客户端格式一致，
 *     避免主播在别处（官方客户端）刚发过弹幕后，混用格式导致服务端把本次发送判为无效而按 90s 冷却）、
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

/** 可自动重试的"瞬时失败"错误码：
 *  - 10030：直播 msg/send 的"发送频率过快"（实测返回码，注意不是视频接口的 36703）
 *  - 36703 / -352：兜底保留（视频接口/风控）
 *  常见于主播账号刚在别处（手机端/官方客户端）发过弹幕，占用了 B站 冷却窗口导致本次发送失败。
 *  注：1004（登录/会话类）非瞬时错误，重试无意义，故不纳入。 */
const RETRYABLE_CODES = new Set<number>([10030, 36703, -352]);

/** 每次重试前额外等待的时长（毫秒）。
 * 盲盒查询需要即时弹幕回应，不能长时间等待；实测命中频率限制后间隔 2s 重发可行。
 * 故仅等待 2s 重试一次即放弃，不做长退避。 */
const RETRY_DELAYS_MS = [2000];

/**
 * 发送弹幕，遇"瞬时失败"（频率过快/风控，RETRYABLE_CODES）时按 RETRY_DELAYS_MS 逐级等待并重试。
 * 返回最终结果：
 *  - 成功 / 非瞬时错误 → 返回首次结果；
 *  - 瞬时错误 → 逐级等待重试，全部失败则返回最后一次错误码与原因。
 * @param onRetry 可选回调：首次失败进入等待时触发一次（用于 UI 展示"正在自动重试"）。
 */
export async function sendDanmakuWithRetry(
  roomId: number,
  message: string,
  onRetry?: (code: number, message: string, waitMs: number) => void,
): Promise<DanmakuResult> {
  let res = await sendDanmaku(roomId, message);
  let attempt = 1;
  for (let i = 0; i < RETRY_DELAYS_MS.length && RETRYABLE_CODES.has(res.code); i++) {
    const waitMs = RETRY_DELAYS_MS[i];
    const reason = res.message || res.msg || "未知原因";
    onRetry?.(res.code, reason, waitMs);
    console.warn(`[Barrage] 第${attempt}次发送失败(code=${res.code} ${reason}) msg=${message}，${waitMs / 1000}s 后自动重试`);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt += 1;
    res = await sendDanmaku(roomId, message);
  }
  if (attempt > 1 && RETRYABLE_CODES.has(res.code)) {
    console.warn(`[Barrage] 重试 ${attempt - 1} 次后仍失败，最终 code=${res.code} ${res.message || res.msg || ""}`);
  }
  return res;
}

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
  // rnd 必须用官方 16 位格式：当前时间戳×1000000（Date.now()*1000 与之等价）。
  // 若用 10 位秒级时间戳，与官方客户端（16 位）混用时服务端会判定 rnd 无效，冷却被拉长到 90s。
  const rnd = Date.now() * 1000;
  // 其余字段与官方 Web 客户端一致：mode=1 普通弹幕、bubble=0 无气泡、csrf_token 与 csrf 相同、
  // statistics 官方客户端携带的客户端标识（appId=100 直播 web 端、platform=5）。缺这些字段的请求
  // 会被识别为非官方来源，命中更严格的频率限制（表现为 10030"发送频率过快"）。
  const statistics = JSON.stringify({ appId: 100, platform: 5 });
  return new URLSearchParams({
    roomid: String(roomId),
    msg: message,
    rnd: String(rnd),
    fontsize: "25",
    color: "16777215",
    mode: "1",
    bubble: "0",
    statistics,
    csrf,
    csrf_token: csrf,
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
    const body = buildSendBody(roomId, message, csrf);
    const data = await platform.fetchBilibiliJson<DanmakuResult>({
      url: "https://api.live.bilibili.com/msg/send",
      method: "POST",
      body,
      cookie: cred.cookie,
      live: true,
    });
    if (data && data.code !== 0) {
      // 输出实际发送的 rnd 与错误信息，便于定位"频率过快"等问题
      const rnd = new URLSearchParams(body).get("rnd");
      console.warn(`[Barrage] msg/send 失败 rnd=${rnd} → code=${data.code} message=${data.message ?? data.msg ?? ""}`);
    }
    return data ?? { code: -1, message: "发送弹幕失败" };
  } catch (err) {
    console.error("[Barrage] 直连发送弹幕失败:", err);
    return { code: -1, message: "发送弹幕失败，请检查网络" };
  }
}
