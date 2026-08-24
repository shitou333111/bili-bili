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
  serverTimestampMs?: number,
): Promise<string | null> {
  // 用 B站服务端时间戳生成 correspondPath：correspond 对时间戳严格校验（RS256 解密后需在合理窗口内），
  // 若本地系统时钟与 B站服务器不同步，Date.now() 会产出"过期"的路径 → 404「出错啦」。
  // cookie/info 返回的 data.timestamp 即服务端当前毫秒时间戳，应优先使用。
  const timestamp = serverTimestampMs && serverTimestampMs > 0 ? serverTimestampMs : Date.now();
  const correspondPath = await generateCorrespondPath(timestamp);
  const url = `https://www.bilibili.com/correspond/1/${correspondPath}`;

  try {
    // 用 fetchArrayBuffer 拿原始字节，避免 text() 把压缩/二进制当 UTF-8 产生乱码
    const buf = await platform.fetchArrayBuffer(url, cookie);
    const bytes = new Uint8Array(buf);
    let html: string;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // gzip：解压
      try {
        const ds = new DecompressionStream("gzip");
        const stream = new Blob([buf.slice(0)]).stream().pipeThrough(ds);
        html = await new Response(stream).text();
      } catch (e) {
        console.error("[CookieRefresh-Client] gzip 解压失败:", e);
        return null;
      }
    } else {
      html = new TextDecoder("utf-8").decode(bytes);
    }
    // 解析 refresh_csrf：B站对应页结构可能变动，做多层兜底
    const matches: string[] = [];
    // 1) 旧结构：<div id="1-name" data-id="xxx">
    const m1 = html.match(/id="1-name"\s+data-id="([^"]+)"/);
    if (m1) matches.push(m1[1]);
    // 2) 旧结构变体：<div id="1-name">xxx</div>
    if (!matches.length) {
      const m2 = html.match(/id="1-name"[^>]*>([^<]+)<\/div>/);
      if (m2) matches.push(m2[1].trim());
    }
    // 3) 任意元素的 data-id（B站可能改了元素 id，但 token 仍放在 data-id）
    if (!matches.length) {
      const m3 = html.match(/data-id\s*=\s*["']([^"']{8,})["']/);
      if (m3) matches.push(m3[1]);
    }
    // 4) name/value 形式的 csrf 输入
    if (!matches.length) {
      const m4 = html.match(/name\s*=\s*["'](?:csrf|refresh_csrf|bili_jct)["'][^>]*?value\s*=\s*["']([^"']+)["']/i);
      if (m4) matches.push(m4[1]);
    }
    if (matches.length) {
      return matches[0];
    }

    console.error("[CookieRefresh-Client] 无法从 correspond 页面解析 refresh_csrf");
    console.error("[CookieRefresh-Client] correspond content-type 未知; 首字节hex:",
      Array.from(bytes.slice(0, 24)).map((b) => b.toString(16).padStart(2, "0")).join(" "));
    console.error("[CookieRefresh-Client] correspond 解码后片段:", html.slice(0, 300).replace(/\s+/g, " "));
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
    status?: number;
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
  serverTimestampMs?: number,
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

  // 社区共识：B站 现要求 Cookie 携带 buvid3，否则按不完整会话处理（可能 code=0 也不下发新 Cookie）
  let cookieWithBuvid = cookie;
  try {
    if (!/buvid3\s*=/i.test(cookie)) {
      const buvidCookie = await platform.getBuvidCookie();
      if (buvidCookie) cookieWithBuvid = `${buvidCookie}; ${cookie}`;
    }
  } catch {
    // buvid 获取失败不阻断流程，沿用原 cookie
  }

  console.log("[CookieRefresh-Client] 开始刷新 B站 Cookie...");

  // 步骤1：获取 refresh_csrf
  const refreshCsrf = await getRefreshCsrf(platform, cookieWithBuvid, serverTimestampMs);
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
    // 必须用 fetchRaw 以便读取 Set-Cookie 响应头：官方文档验证，
    // 刷新成功后新的 Cookie 通过 HTTP Set-Cookie 头下发，而非 JSON body。
    const refreshResponse = await platform.fetchRaw(refreshUrl, cookieWithBuvid, {
      method: "POST",
      body: refreshBody,
    });
    const refreshResult: CookieRefreshResponse = await refreshResponse.json();

    if (refreshResult.code !== 0) {
      // -101 未登录 / -111 csrf校验失败 / 86095 refresh_csrf错误或 token 与 cookie 不匹配
      let reason = `刷新失败: ${refreshResult.code} ${refreshResult.message}`;
      if (refreshResult.code === -101) reason = "刷新失败：账号未登录(-101)";
      else if (refreshResult.code === -111) reason = "刷新失败：csrf 校验失败(-111)";
      else if (refreshResult.code === 86095)
        reason = "刷新失败：refresh_csrf 错误或 refresh_token 与 cookie 不匹配(86095)";
      console.error("[CookieRefresh-Client]", reason, JSON.stringify(refreshResult).slice(0, 400));
      return { success: false, error: reason };
    }

    // 成功（code===0）：从 Set-Cookie 头解析新 cookie，JSON body 里的 status 恒为 0，仅携带新 refresh_token
    let newCookies: string[] = [];
    try {
      newCookies = (
        refreshResponse.headers.getSetCookie?.() || []
      ).map((c) => c.split(";")[0]);
    } catch {
      newCookies = [];
    }
    const newRefreshToken = refreshResult.data?.refresh_token || "";
    const newSessdata = extractCookieValue(newCookies, "SESSDATA");
    const newBiliJct = extractCookieValue(newCookies, "bili_jct");

    // 兜底：个别平台 getSetCookie 取不到时，尝试从 body 的 cookie_info 解析（旧结构）
    if (newCookies.length === 0 && refreshResult.data?.cookie_info?.cookies) {
      newCookies = refreshResult.data.cookie_info.cookies.map(
        (c) => `${c.name}=${c.value}`,
      );
    }

    if (!newSessdata || !newBiliJct) {
      // code=0 但未返回新 SESSDATA：B站 常见两种情况 ——
      // ① 触发「2 分钟最小刷新间隔」限流（data.status!=0，官方返回 code=0、无 Set-Cookie）；
      // ② 仅续期 refresh_token、不轮换主 token 的正常续期（旧 SESSDATA 仍有效）。
      // 两种都不该判失败：沿用旧 cookie、仅更新 refresh_token，按成功处理，避免每次刷新都报错。
      const dataStatus = refreshResult.data?.status;
      const oldCookies =
        session.biliCookies?.length
          ? session.biliCookies
          : [`SESSDATA=${session.biliSessdata}`];
      let rawSetCookie: string[] = [];
      try {
        rawSetCookie = refreshResponse.headers.getSetCookie?.() ?? [];
      } catch {
        rawSetCookie = [];
      }
      // 有 refresh_token 时正常续期，沿用旧 cookie
      if (newRefreshToken) {
        console.warn(
          "[CookieRefresh-Client] code=0 未返回新 SESSDATA; data.status=",
          dataStatus,
          "; 沿用旧 cookie 并更新 refresh_token",
        );
        return {
          success: true,
          newCookies: newCookies.length ? newCookies : oldCookies,
          newRefreshToken,
          newSessdata: session.biliSessdata,
        };
      }
      // 连 refresh_token 都没有：视为失败，保留诊断
      console.error(
        "[CookieRefresh-Client] 刷新响应缺少必要 cookie; platform=",
        platform.name,
        "; data.status=",
        dataStatus,
        "; rawSetCookie=",
        JSON.stringify(rawSetCookie),
        "; newCookies=",
        JSON.stringify(newCookies),
        "; status=",
        refreshResponse.status,
      );
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

// ==================== 单飞锁 / 缓存 / 刷新节流 ====================
// 背景：pay-record、anchor-gifts、gift-replay 等多个模块在加载时"各自独立"调用
// ensureValidCredentialClient，且并发发起 → 若无锁会同时用同一个 refresh_token 刷新，
// 但 refresh_token 在"刷新-确认"后被消耗/轮换，只有一个成功，其余返回 86095"token与cookie不匹配"失败。
// 因此必须：① 同一 session 的刷新只允许同时一个在跑（单飞锁）；② 验证结果短窗缓存，避免每个请求都调 B站；
// ③ 即使 cookie/info 说 refresh=true，也按间隔节流，避免高频死循环。
const REVALIDATE_MS = 5 * 60 * 1000; // 验证结果缓存：5 分钟内不再重复调 cookie/info
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 实际刷新节流：12 小时最多刷新一次

/** sid -> 最近一次验证为"有效"的时间戳（用旧 cookie 继续用即可，不必每次调 B站） */
const _okCache = new Map<string, number>();
/** sid -> 最近一次发起刷新的时间戳（用于节流，防止每次请求都刷） */
const _lastRefreshAt = new Map<string, number>();
/** sid -> 正在进行的刷新 Promise（单飞锁） */
const _inflightBySid = new Map<string, Promise<CredentialCheckResult>>();

/**
 * 确保 B站凭证有效（客户端版，带单飞锁 + 缓存 + 节流）
 * 多个调用方并发请求时，同一 session 只执行一次刷新，其余共享同一结果；
 * 验证通过后短窗内直接返回缓存，不重复请求 B站。
 */
export async function ensureValidCredentialClient(
  platform: Platform,
  session: AuthSession,
): Promise<CredentialCheckResult> {
  // 短窗缓存命中：刚验证过有效，跳过 cookie/info
  const okTs = _okCache.get(session.sid);
  if (okTs && Date.now() - okTs < REVALIDATE_MS) {
    return { valid: true, session, cookie: buildCookieHeader(session) };
  }
  // 单飞锁：同一 session 已有刷新在跑则直接复用它
  const inflight = _inflightBySid.get(session.sid);
  if (inflight) return inflight;
  const promise = _doEnsureValidCredential(platform, session);
  _inflightBySid.set(session.sid, promise);
  try {
    return await promise;
  } finally {
    _inflightBySid.delete(session.sid);
  }
}

async function _doEnsureValidCredential(
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
  // 服务端时钟：cookie/info 返回的 data.timestamp 是"用于获取 refresh_csrf 的服务端时间戳"，
  // 用它生成 correspondPath 可避免本地时钟偏移导致对应接口 404。
  let serverTimestampMs: number | undefined;

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
        serverTimestampMs = info.data.timestamp; // 记录服务端时间戳，用于对应接口
        console.log("[CredentialCheck-Client] cookie/info 提示需要刷新（SESSDATA 仍有效）");
      } else {
        // 无需刷新，凭证有效
        _okCache.set(session.sid, Date.now());
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
          _okCache.set(session.sid, Date.now());
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
    _okCache.set(session.sid, Date.now());
    return { valid: true, session, cookie };
  }

  // 刷新节流：距上次刷新间隔过短则跳过本次刷新，直接用旧 cookie 继续。
  // cookie/info 说 refresh=true 时 SESSDATA 尚未过期、旧 cookie 仍可用，
  // 避免"每次请求都触发刷新、刷新又失败"的死循环（也避免消耗 refresh_token）。
  const lastRf = _lastRefreshAt.get(session.sid);
  if (lastRf && Date.now() - lastRf < REFRESH_INTERVAL_MS) {
    console.log(`[CredentialCheck-Client] 距上次刷新 ${((Date.now() - lastRf) / 3600000).toFixed(1)}h，跳过本次刷新，使用旧 cookie`);
    _okCache.set(session.sid, Date.now());
    return { valid: true, session, cookie };
  }
  _lastRefreshAt.set(session.sid, Date.now());

  // 步骤2：SESSDATA 仍有效但需要刷新，执行刷新（重试 2 次）
  let refreshResult: RefreshCookieResult | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    refreshResult = await refreshBiliCookieClient(platform, session, serverTimestampMs);
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
    _okCache.set(session.sid, Date.now());
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
