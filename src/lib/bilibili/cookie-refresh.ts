/**
 * B站 Cookie 刷新机制
 *
 * B站的 SESSDATA 会逐渐失效，需要定期用 refresh_token 刷新。
 * 刷新流程：
 * 1. 检查是否需要刷新：GET /x/passport-login/web/cookie/info
 * 2. 生成 CorrespondPath：RSA-OAEP 加密 refresh_${timestamp}
 * 3. 获取 refresh_csrf：GET /correspond/1/{CorrespondPath}
 * 4. 刷新 Cookie：POST /x/passport-login/web/cookie/refresh
 * 5. 确认更新：POST /x/passport-login/web/confirm/refresh
 */

import { publicEncrypt, constants } from "crypto";
import { fetchBilibiliJson } from "@/lib/bilibili/client";
import type { AuthSession } from "@/lib/auth/session";
import { updateSessionCredentials } from "@/lib/auth/session";

// B站提供的 RSA-OAEP 公钥（PEM 格式）
const BILI_REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

/** 刷新结果 */
export type RefreshCookieResult = {
  success: boolean;
  newCookies?: string[]; // 新的 cookie 数组（如 ["SESSDATA=xxx", "bili_jct=xxx"]）
  newRefreshToken?: string;
  newSessdata?: string;
  error?: string;
};

/** 从 cookie 数组中提取指定字段值 */
export function extractCookieValue(cookies: string[], name: string): string {
  for (const c of cookies) {
    const match = c.match(new RegExp(`^${name}=(.+)$`));
    if (match) return match[1];
  }
  return "";
}

/** 从 session 构建 cookie header */
export function buildCookieHeader(session: AuthSession): string {
  return session.biliCookies?.length
    ? session.biliCookies.join("; ")
    : `SESSDATA=${session.biliSessdata}`;
}

/** 生成 CorrespondPath（RSA-OAEP 加密 refresh_${timestamp}） */
function generateCorrespondPath(timestamp: number): string {
  const data = Buffer.from(`refresh_${timestamp}`, "utf8");
  const encrypted = publicEncrypt(
    {
      key: BILI_REFRESH_PUBLIC_KEY,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    data,
  );
  return encrypted.toString("hex");
}

/** 获取 refresh_csrf（从 correspond 页面解析） */
async function getRefreshCsrf(cookie: string): Promise<string | null> {
  // 用 B站服务端时间戳生成 correspondPath：correspond 对时间戳严格校验，
  // 本地系统时钟与 B站服务器不同步时 Date.now() 会产生"过期"路径 → 404「出错啦」。
  // 先取 cookie/info 返回的服务端当前毫秒时间戳，取不到再回退本地时钟。
  let timestamp = Date.now();
  try {
    const infoRes = await fetch(
      "https://passport.bilibili.com/x/passport-login/web/cookie/info",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Cookie: cookie,
        },
        cache: "no-store",
      },
    );
    const infoBody = (await infoRes.json()) as { code?: number; data?: { timestamp?: number } };
    if (infoRes.ok && infoBody.code === 0 && infoBody.data?.timestamp) {
      timestamp = infoBody.data.timestamp;
    }
  } catch { /* 拿不到服务端时间则回退本地时钟 */ }
  const correspondPath = generateCorrespondPath(timestamp);
  const url = `https://www.bilibili.com/correspond/1/${correspondPath}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Cookie: cookie,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      console.error("[CookieRefresh] correspond 请求失败:", response.status);
      return null;
    }

    const html = await response.text();
    // 解析 refresh_csrf：B站对应页结构可能变动，做多层兜底
    const matches: string[] = [];
    const m1 = html.match(/id="1-name"\s+data-id="([^"]+)"/);
    if (m1) matches.push(m1[1]);
    if (!matches.length) {
      const m2 = html.match(/id="1-name"[^>]*>([^<]+)<\/div>/);
      if (m2) matches.push(m2[1].trim());
    }
    if (!matches.length) {
      const m3 = html.match(/data-id\s*=\s*["']([^"']{8,})["']/);
      if (m3) matches.push(m3[1]);
    }
    if (!matches.length) {
      const m4 = html.match(/name\s*=\s*["'](?:csrf|refresh_csrf|bili_jct)["'][^>]*?value\s*=\s*["']([^"']+)["']/i);
      if (m4) matches.push(m4[1]);
    }
    if (matches.length) {
      return matches[0];
    }

    console.error("[CookieRefresh] 无法从 correspond 页面解析 refresh_csrf");
    console.error("[CookieRefresh] correspond HTML 片段:", html.slice(0, 400).replace(/\s+/g, " "));
    return null;
  } catch (err) {
    console.error("[CookieRefresh] 获取 refresh_csrf 失败:", err);
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
 * 刷新 B站 Cookie
 * 当 SESSDATA 失效时调用，使用 refresh_token 获取新的凭证
 */
export async function refreshBiliCookie(session: AuthSession): Promise<RefreshCookieResult> {
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

  console.log("[CookieRefresh] 开始刷新 B站 Cookie...");

  // 步骤1：获取 refresh_csrf
  const refreshCsrf = await getRefreshCsrf(cookie);
  if (!refreshCsrf) {
    return { success: false, error: "获取 refresh_csrf 失败" };
  }

  // 步骤2：刷新 Cookie
  const refreshUrl = "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
  const refreshBody = `csrf=${encodeURIComponent(biliJct)}&refresh_csrf=${encodeURIComponent(refreshCsrf)}&refresh_token=${encodeURIComponent(session.biliRefreshToken)}&source=main_web`;

  try {
    // 必须用原生 fetch 读取 Set-Cookie 响应头：官方文档验证，
    // 刷新成功后新 Cookie 通过 Set-Cookie 头下发，而非 JSON body。
    const res = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.bilibili.com/",
        Cookie: cookie,
      },
      body: refreshBody,
    });
    const refreshResult = (await res.json()) as CookieRefreshResponse;

    if (refreshResult.code !== 0) {
      let reason = `刷新失败: ${refreshResult.code} ${refreshResult.message}`;
      if (refreshResult.code === -101) reason = "刷新失败：账号未登录(-101)";
      else if (refreshResult.code === -111) reason = "刷新失败：csrf 校验失败(-111)";
      else if (refreshResult.code === 86095)
        reason = "刷新失败：refresh_csrf 错误或 refresh_token 与 cookie 不匹配(86095)";
      console.error("[CookieRefresh]", reason);
      return { success: false, error: reason };
    }

    // 成功（code===0）：从 Set-Cookie 头解析新 cookie
    let newCookies: string[] = [];
    try {
      newCookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    } catch {
      newCookies = [];
    }
    const newRefreshToken = refreshResult.data?.refresh_token || "";
    const newSessdata = extractCookieValue(newCookies, "SESSDATA");
    const newBiliJct = extractCookieValue(newCookies, "bili_jct");

    // 兜底：个别环境取不到 set-cookie 头时回退 body 的 cookie_info（旧结构）
    if (newCookies.length === 0 && refreshResult.data?.cookie_info?.cookies) {
      newCookies = refreshResult.data.cookie_info.cookies.map(
        (c) => `${c.name}=${c.value}`,
      );
    }

    if (!newSessdata || !newBiliJct) {
      console.error("[CookieRefresh] 刷新响应缺少必要 cookie; Set-Cookie=", JSON.stringify(newCookies));
      return { success: false, error: "刷新响应缺少 SESSDATA 或 bili_jct" };
    }

    // 步骤3：确认更新（使用新 cookie 和旧 refresh_token）
    const confirmUrl = "https://passport.bilibili.com/x/passport-login/web/confirm/refresh";
    const confirmBody = `csrf=${encodeURIComponent(newBiliJct)}&refresh_token=${encodeURIComponent(session.biliRefreshToken)}`;

    try {
      const confirmResult = await fetchBilibiliJson<ConfirmRefreshResponse>({
        url: confirmUrl,
        method: "POST",
        cookie: newCookies.join("; "),
        body: confirmBody,
      });

      if (confirmResult.code !== 0) {
        console.warn("[CookieRefresh] 确认更新失败（不影响新 cookie 使用）:", confirmResult.code, confirmResult.message);
      }
    } catch (err) {
      console.warn("[CookieRefresh] 确认更新请求异常（不影响新 cookie 使用）:", err);
    }

    console.log("[CookieRefresh] B站 Cookie 刷新成功");
    return {
      success: true,
      newCookies,
      newRefreshToken,
      newSessdata,
    };
  } catch (err) {
    console.error("[CookieRefresh] 刷新请求异常:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "刷新请求异常",
    };
  }
}

/** 检查 B站 API 返回是否表示凭证失效 */
export function isBiliCredentialExpired(code: number): boolean {
  return code === -101 || code === 3;
}

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

// ==================== 单飞锁 / 缓存 / 刷新节流（与服务端一致） ====================
// 多个请求并发调用 ensureValidCredential 时，若不锁会同时用同一 refresh_token 刷新，
// 但 token 在刷新后被消耗/轮换，只有一个成功，其余失败并触发 86095 / correspond 404。
const REVALIDATE_MS = 5 * 60 * 1000; // 验证有效缓存：5 分钟内不重复调 nav
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 实际刷新节流：12 小时最多刷一次
const _okCache = new Map<string, number>();
const _lastRefreshAt = new Map<string, number>();
const _inflightBySid = new Map<string, Promise<CredentialCheckResult>>();

export async function ensureValidCredential(session: AuthSession): Promise<CredentialCheckResult> {
  const okTs = _okCache.get(session.sid);
  if (okTs && Date.now() - okTs < REVALIDATE_MS) {
    return { valid: true, session, cookie: buildCookieHeader(session) };
  }
  const inflight = _inflightBySid.get(session.sid);
  if (inflight) return inflight;
  const promise = _doEnsureValidCredential(session);
  _inflightBySid.set(session.sid, promise);
  try {
    return await promise;
  } finally {
    _inflightBySid.delete(session.sid);
  }
}

async function _doEnsureValidCredential(session: AuthSession): Promise<CredentialCheckResult> {
  const cookie = buildCookieHeader(session);

  // 步骤1：用 nav 接口验证凭证（412/网络错误时重试 3 次，指数退避）
  // 这是切号后偶发"伪失效"的主因——短时间内并发请求B站导致临时限流
  let navResult: NavResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchBilibiliJson<NavResponse>({
        url: "https://api.bilibili.com/x/web-interface/nav",
        cookie,
      });
      navResult = res;
      if (navResult.code === 0 && navResult.data?.isLogin) {
        _okCache.set(session.sid, Date.now());
        return { valid: true, session, cookie };
      }
      // code!==0 或 isLogin=false：不是网络/限流问题，是凭证真失效，跳出重试
      if (navResult.code === -101 || navResult.code === 3 || !navResult.data?.isLogin) break;
      // 其他错误（-412 限流）：重试
    } catch (err) {
      console.error(`[CredentialCheck] nav 接口请求失败 attempt=${attempt + 1}:`, err);
    }
    if (attempt < 2) {
      const delay = 1500 * Math.pow(2, attempt); // 1.5s / 3s
      console.log(`[CredentialCheck] nav 接口失败，等待 ${delay}ms 后重试`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (navResult) {
    console.log("[CredentialCheck] B站凭证疑似失效，尝试刷新...", navResult.code, navResult.message);
  }

  // 刷新节流：距上次刷新间隔过短则跳过（旧 cookie 可能仍可用），避免高频死循环与 token 消耗。
  // 服务端 refresh 失败（如 correspond 404、refresh_token 不匹配）时尤其需要节流，防止每请求都刷。
  const lastRf = _lastRefreshAt.get(session.sid);
  if (lastRf && Date.now() - lastRf < REFRESH_INTERVAL_MS) {
    console.log(`[CredentialCheck] 距上次刷新 ${((Date.now() - lastRf) / 3600000).toFixed(1)}h，跳过本次刷新`);
  } else {
    _lastRefreshAt.set(session.sid, Date.now());

    // 步骤2：凭证失效，尝试刷新（也加重试）
    let refreshResult: RefreshCookieResult | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      refreshResult = await refreshBiliCookie(session);
      if (refreshResult.success && refreshResult.newCookies) break;
      if (attempt < 1) {
        console.log(`[CredentialCheck] 刷新失败 attempt=${attempt + 1}，重试...`, refreshResult.error);
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt))); // 2s / 4s
      }
    }
    if (!refreshResult || !refreshResult.success || !refreshResult.newCookies) {
      return {
        valid: false,
        needsRelogin: true,
        reason: refreshResult?.error || "刷新失败",
      };
    }

    // 步骤3：更新 session 中的凭证
    const updatedSession = await updateSessionCredentials(session.sid, {
      biliSessdata: refreshResult.newSessdata,
      biliRefreshToken: refreshResult.newRefreshToken,
      biliCookies: refreshResult.newCookies,
    });

    if (!updatedSession) {
      return {
        valid: false,
        needsRelogin: true,
        reason: "无法更新会话凭证",
      };
    }

    // 步骤4：用新凭证验证一次（加重试）
    const newCookie = refreshResult.newCookies.join("; ");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const retryNav = await fetchBilibiliJson<NavResponse>({
          url: "https://api.bilibili.com/x/web-interface/nav",
          cookie: newCookie,
        });
        if (retryNav.code === 0 && retryNav.data?.isLogin) {
          console.log("[CredentialCheck] 凭证刷新成功");
          _okCache.set(session.sid, Date.now());
          return { valid: true, session: updatedSession, cookie: newCookie };
        }
        if (retryNav.code === -101 || retryNav.code === 3 || !retryNav.data?.isLogin) break;
      } catch (err) {
        console.error(`[CredentialCheck] 刷新后验证 attempt=${attempt + 1} 失败:`, err);
      }
      if (attempt < 2) {
        const delay = 1500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    return {
      valid: false,
      needsRelogin: true,
      reason: "刷新后验证仍失败",
    };
  }

  // 刷新被节流跳过：返回需重新登录（旧 cookie 已确认失效，nav 验证失败），
  // 但先记录 okCache 避免同一秒内再次触发不必要的 nav 重试风暴
  _okCache.set(session.sid, Date.now());
  return {
    valid: false,
    needsRelogin: true,
    reason: "刷新节流跳过，等待重新登录",
  };
}
