/**
 * B站 Cookie 刷新机制 - 客户端版（Tauri/Web 环境）
 *
 * 使用 Web Crypto API (crypto.subtle) 替代 Node.js crypto 模块，
 * 在 Tauri WebView 中直接运行，无需 Rust 后端桥接。
 *
 * 刷新流程：
 * 1. 检查是否需要刷新：GET /x/passport-login/web/cookie/info
 * 2. 生成 CorrespondPath：RSA-OAEP 加密 refresh_${timestamp}
 * 3. 获取 refresh_csrf：GET /correspond/1/{CorrespondPath}
 * 4. 刷新 Cookie：POST /x/passport-login/web/cookie/refresh
 * 5. 确认更新：POST /x/passport-login/web/confirm/refresh
 *
 * 文档参考：https://github.com/pskdje/bilibili-API-collect/blob/main/docs/login/cookie_refresh.md
 */

import type { Platform } from "@/lib/platform/types";
import type { AuthSession, SessionState } from "@/lib/auth/session";

// ==================== 公钥与加密 ====================

// B站官方提供的 RSA-OAEP 公钥（JWK 格式，来自 Web 首页 wasm 逆向）
// 文档：https://github.com/pskdje/bilibili-API-collect/blob/main/docs/login/cookie_refresh.md
const BILI_REFRESH_JWK = {
  kty: "RSA" as const,
  n: "y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE",
  e: "AQAB" as const,
};

// 缓存的 CryptoKey（避免每次刷新都重新 importKey）
let _cachedPublicKey: CryptoKey | null = null;

async function getPublicKey(): Promise<CryptoKey> {
  if (_cachedPublicKey) return _cachedPublicKey;
  _cachedPublicKey = await crypto.subtle.importKey(
    "jwk",
    BILI_REFRESH_JWK,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  return _cachedPublicKey;
}

/** 生成 CorrespondPath：RSA-OAEP 加密 refresh_${timestamp}，输出小写 hex 字符串 */
async function generateCorrespondPath(timestamp: number): Promise<string> {
  const publicKey = await getPublicKey();
  const data = new TextEncoder().encode(`refresh_${timestamp}`);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, data),
  );
  // 转为小写 hex 字符串
  return Array.from(encrypted)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ==================== 辅助函数 ====================

/** 构建 B站 Cookie header */
export function buildCookieHeader(session: AuthSession): string {
  return session.biliCookies?.length
    ? session.biliCookies.join("; ")
    : `SESSDATA=${session.biliSessdata}`;
}

/** 从 cookie 数组中提取指定字段值 */
export function extractCookieValue(cookies: string[], name: string): string {
  for (const c of cookies) {
    const match = c.match(new RegExp(`^${name}=(.+)$`));
    if (match) return match[1];
  }
  return "";
}

/** 检查 B站 API 返回是否表示凭证失效 */
export function isBiliCredentialExpired(code: number, message?: string): boolean {
  return (
    code === -101 ||
    code === 3 ||
    (typeof message === "string" && message.includes("未登录"))
  );
}

// ==================== 刷新流程 ====================

/** 刷新结果 */
export type RefreshCookieResult = {
  success: boolean;
  newCookies?: string[];
  newRefreshToken?: string;
  newSessdata?: string;
  error?: string;
};

/** 获取 refresh_csrf（从 correspond 页面 HTML 解析） */
async function getRefreshCsrf(
  platform: Platform,
  cookie: string,
): Promise<string | null> {
  const timestamp = Date.now();
  const correspondPath = await generateCorrespondPath(timestamp);
  const url = `https://www.bilibili.com/correspond/1/${correspondPath}`;

  try {
    const response = await platform.fetchRaw(url, cookie);
    if (!response.ok) {
      console.error(`[CookieRefresh-Client] correspond 请求失败: ${response.status}`);
      return null;
    }

    const html = await response.text();
    // 解析 <div id="1-name" data-id="xxx"> 或 <div id="1-name">xxx</div>
    const match =
      html.match(/id="1-name"\s+data-id="([^"]+)"/) ||
      html.match(/id="1-name"[^>]*>([^<]+)<\/div>/);
    if (match) {
      return match[1];
    }

    console.error("[CookieRefresh-Client] 无法从 correspond 页面解析 refresh_csrf");
    return null;
  } catch (err) {
    console.error("[CookieRefresh-Client] 获取 refresh_csrf 失败:", err);
    return null;
  }
}

/** B站 cookie 刷新接口响应 */
type CookieRefreshResponse = {
  code: number;
  message: string;
  data?: {
    cookie_info?: {
      cookies: Array<{ name: string; value: string }>;
    };
    refresh_token?: string;
  };
};

/** 确认更新响应 */
type ConfirmRefreshResponse = {
  code: number;
  message: string;
};

/**
 * 刷新 B站 Cookie（客户端版）
 * 当 SESSDATA 失效时调用，使用 refresh_token 获取新的凭证
 */
export async function refreshBiliCookieClient(
  platform: Platform,
  session: AuthSession,
): Promise<RefreshCookieResult> {
  const cookie = buildCookieHeader(session);
  const biliJct = session.biliCookies
    ? extractCookieValue(session.biliCookies, "bili_jct")
    : "";

  if (!session.biliRefreshToken) {
    return { success: false, error: "无 refresh_token" };
  }
  if (!biliJct) {
    return { success: false, error: "无 bili_jct (CSRF token)" };
  }

  console.log("[CookieRefresh-Client] 开始刷新 B站 Cookie...");

  // 步骤1：获取 refresh_csrf
  const refreshCsrf = await getRefreshCsrf(platform, cookie);
  if (!refreshCsrf) {
    return { success: false, error: "获取 refresh_csrf 失败" };
  }

  // 步骤2：刷新 Cookie
  const refreshUrl =
    "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
  const refreshBody =
    `csrf=${encodeURIComponent(biliJct)}` +
    `&refresh_csrf=${encodeURIComponent(refreshCsrf)}` +
    `&refresh_token=${encodeURIComponent(session.biliRefreshToken)}` +
    `&source=main_web`;

  try {
    const refreshResult = await platform.fetchBilibiliJson<CookieRefreshResponse>({
      url: refreshUrl,
      method: "POST",
      cookie,
      body: refreshBody,
    });

    if (refreshResult.code !== 0 || !refreshResult.data?.cookie_info?.cookies) {
      console.error(
        "[CookieRefresh-Client] 刷新失败:",
        refreshResult.code,
        refreshResult.message,
      );
      return {
        success: false,
        error: `刷新失败: ${refreshResult.code} ${refreshResult.message}`,
      };
    }

    const newCookies = refreshResult.data.cookie_info.cookies.map(
      (c) => `${c.name}=${c.value}`,
    );
    const newRefreshToken = refreshResult.data.refresh_token || "";
    const newSessdata = extractCookieValue(newCookies, "SESSDATA");
    const newBiliJct = extractCookieValue(newCookies, "bili_jct");

    if (!newSessdata || !newBiliJct) {
      console.error("[CookieRefresh-Client] 刷新响应缺少必要 cookie");
      return { success: false, error: "刷新响应缺少 SESSDATA 或 bili_jct" };
    }

    // 步骤3：确认更新（使用新 cookie 和旧 refresh_token）
    const confirmUrl =
      "https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
    const confirmBody =
      `csrf=${encodeURIComponent(newBiliJct)}` +
      `&refresh_token=${encodeURIComponent(session.biliRefreshToken)}`;

    try {
      const confirmResult =
        await platform.fetchBilibiliJson<ConfirmRefreshResponse>({
          url: confirmUrl,
          method: "POST",
          cookie: newCookies.join("; "),
          body: confirmBody,
        });

      if (confirmResult.code !== 0) {
        console.warn(
          "[CookieRefresh-Client] 确认更新失败（不影响新 cookie 使用）:",
          confirmResult.code,
          confirmResult.message,
        );
      }
    } catch (err) {
      console.warn(
        "[CookieRefresh-Client] 确认更新请求异常（不影响新 cookie 使用）:",
        err,
      );
    }

    console.log("[CookieRefresh-Client] B站 Cookie 刷新成功");
    return { success: true, newCookies, newRefreshToken, newSessdata };
  } catch (err) {
    console.error("[CookieRefresh-Client] 刷新请求异常:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "刷新请求异常",
    };
  }
}

// ==================== 凭证验证与自动刷新 ====================

/** B站 nav 接口响应 */
type NavResponse = {
  code: number;
  message: string;
  data?: {
    isLogin: boolean;
    mid: number;
  };
};

/** 凭证验证结果 */
export type CredentialCheckResult =
  | { valid: true; session: AuthSession; cookie: string }
  | { valid: false; needsRelogin: true; reason: string };

/** cookie/info 接口响应 */
type CookieInfoResponse = {
  code: number;
  message: string;
  data?: { refresh: boolean; timestamp: number };
};

/**
 * 更新平台会话状态中指定 session 的凭证
 * 客户端版：通过 platform.setSessionState 全量更新
 */
async function updateClientSessionCredentials(
  platform: Platform,
  sid: string,
  credentials: {
    biliSessdata?: string;
    biliRefreshToken?: string;
    biliCookies?: string[];
  },
): Promise<AuthSession | null> {
  const state = await platform.getSessionState();
  const session = state.sessions.find((s) => s.sid === sid);
  if (!session) return null;

  if (credentials.biliSessdata) session.biliSessdata = credentials.biliSessdata;
  if (credentials.biliRefreshToken)
    session.biliRefreshToken = credentials.biliRefreshToken;
  if (credentials.biliCookies) session.biliCookies = credentials.biliCookies;
  session.updatedAt = new Date().toISOString();

  await platform.setSessionState(state);
  return session;
}

/**
 * 确保 B站凭证有效（客户端版）
 *
 * 使用 cookie/info API 主动检查是否需要刷新：
 * - refresh=false → 凭证有效，直接返回
 * - refresh=true → SESSDATA 仍有效但需要刷新，此时 correspond 页面可正常访问
 * - code=-101 → SESSDATA 已完全过期，correspond 会 404，无法刷新，需重新登录
 *
 * 关键：必须在 SESSDATA 完全过期前（cookie/info 返回 refresh=true 时）刷新，
 * 而非等 nav 返回 -101 后才刷新（那时 correspond 已 404）。
 *
 * @returns 凭证有效则返回 session 和 cookie，否则返回需要重新登录
 */
export async function ensureValidCredentialClient(
  platform: Platform,
  session: AuthSession,
): Promise<CredentialCheckResult> {
  const cookie = buildCookieHeader(session);
  const biliJct = session.biliCookies
    ? extractCookieValue(session.biliCookies, "bili_jct")
    : "";

  // 步骤1：用 cookie/info API 检查是否需要刷新
  // 此接口在 SESSDATA 仍有效时返回 refresh=true，在完全过期时返回 -101
  let needsRefresh = false;
  let cookieInfoFailed = false;

  try {
    const infoUrl = biliJct
      ? `https://passport.bilibili.com/x/passport-login/web/cookie/info?csrf=${encodeURIComponent(biliJct)}`
      : "https://passport.bilibili.com/x/passport-login/web/cookie/info";
    const info = await platform.fetchBilibiliJson<CookieInfoResponse>({
      url: infoUrl,
      cookie,
    });

    if (info.code === 0 && info.data) {
      if (info.data.refresh) {
        // SESSDATA 仍有效但需要刷新 → correspond 页面可正常访问
        needsRefresh = true;
        console.log("[CredentialCheck-Client] cookie/info 提示需要刷新（SESSDATA 仍有效）");
      } else {
        // 无需刷新，凭证有效
        return { valid: true, session, cookie };
      }
    } else if (isBiliCredentialExpired(info.code)) {
      // SESSDATA 已完全过期（-101），correspond 会 404，无法刷新
      console.warn(`[CredentialCheck-Client] cookie/info 返回 code=${info.code}，SESSDATA 已完全过期，需重新登录`);
      return {
        valid: false,
        needsRelogin: true,
        reason: "SESSDATA 已完全过期",
      };
    } else {
      // 其他错误码，不确定状态，继续用 nav 验证
      console.warn(`[CredentialCheck-Client] cookie/info 返回未知 code=${info.code}，回退到 nav 检查`);
      cookieInfoFailed = true;
    }
  } catch (err) {
    // cookie/info 网络请求失败，回退到 nav API
    console.warn("[CredentialCheck-Client] cookie/info 请求失败，回退到 nav 检查:", err);
    cookieInfoFailed = true;
  }

  // 步骤1b：cookie/info 失败或返回未知码时，用 nav API 验证（重试 3 次）
  if (cookieInfoFailed) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nav = await platform.fetchBilibiliJson<NavResponse>({
          url: "https://api.bilibili.com/x/web-interface/nav",
          cookie,
        });
        if (nav.code === 0 && nav.data?.isLogin) {
          return { valid: true, session, cookie };
        }
        if (isBiliCredentialExpired(nav.code) || !nav.data?.isLogin) {
          // nav 也说失效 → SESSDATA 已过期，correspond 会 404
          console.warn(`[CredentialCheck-Client] nav 返回 code=${nav.code}，SESSDATA 已过期，需重新登录`);
          return {
            valid: false,
            needsRelogin: true,
            reason: "SESSDATA 已过期",
          };
        }
        // -412 限流等：重试
      } catch (err) {
        console.error(
          `[CredentialCheck-Client] nav 接口请求失败 attempt=${attempt + 1}:`,
          err,
        );
      }
      if (attempt < 2) {
        const delay = 1500 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // nav 也无法确定（持续网络错误），保守起见返回有效（让数据请求自行处理）
    return { valid: true, session, cookie };
  }

  if (!needsRefresh) {
    return { valid: true, session, cookie };
  }

  // 步骤2：SESSDATA 仍有效但需要刷新，执行刷新（重试 2 次）
  let refreshResult: RefreshCookieResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    refreshResult = await refreshBiliCookieClient(platform, session);
    if (refreshResult.success && refreshResult.newCookies) break;
    if (attempt < 1) {
      console.log(
        `[CredentialCheck-Client] 刷新失败 attempt=${attempt + 1}，重试...`,
        refreshResult.error,
      );
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
    }
  }

  if (!refreshResult || !refreshResult.success || !refreshResult.newCookies) {
    // 刷新失败，但旧 SESSDATA 仍有效（cookie/info 说 refresh=true 时仍可使用）
    // 返回有效，让数据请求用旧 cookie 继续
    console.warn("[CredentialCheck-Client] 刷新失败，使用旧 cookie 继续（下次再试）");
    return { valid: true, session, cookie };
  }

  // 步骤3：更新会话中的凭证
  const updatedSession = await updateClientSessionCredentials(
    platform,
    session.sid,
    {
      biliSessdata: refreshResult.newSessdata,
      biliRefreshToken: refreshResult.newRefreshToken,
      biliCookies: refreshResult.newCookies,
    },
  );

  if (!updatedSession) {
    return {
      valid: false,
      needsRelogin: true,
      reason: "无法更新会话凭证",
    };
  }

  // 步骤4：刷新成功，直接返回新凭证（不再额外验证，减少 API 调用）
  const newCookie = refreshResult.newCookies.join("; ");
  console.log("[CredentialCheck-Client] 凭证刷新成功");
  return { valid: true, session: updatedSession, cookie: newCookie };
}
