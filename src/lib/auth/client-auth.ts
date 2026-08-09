/**
 * Tauri 客户端 - 认证/会话本地化
 * 在 Tauri 环境下，二维码登录、账号切换、登出全部在本机完成，
 * 登录凭证（SESSDATA/refresh_token/Cookie）只存本地 plugin-store，
 * 不上传服务器。
 *
 * 与 src/app/api/auth/* 各 route 对应，但运行在客户端。
 */

import QRCode from "qrcode";
import type { Platform } from "@/lib/platform/types";
import type { AuthSession } from "./session";

// ==================== 类型定义 ====================

type QRGenerateData = { qrcode_key: string; url: string; image: string };

type QRPollData = {
  code: number;
  message: string;
  url: string;
  refresh_token: string;
  timestamp: number;
  sid?: string;
  userToken?: string;
};

// ==================== Cookie 提取 ====================

/** 从响应头的 set-cookie 中提取 cookie 键值对 */
function extractCookieValues(response: {
  headers: { getSetCookie?: () => string[] };
}): Record<string, string> {
  const list = response.headers.getSetCookie?.() ?? [];
  const values: Record<string, string> = {};
  for (const header of list) {
    for (const part of header.split(/,(?=\s*[A-Za-z0-9_\-]+=)/g)) {
      const [nameValue] = part.split(";", 1);
      const eq = nameValue.indexOf("=");
      if (eq <= 0) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();
      if (name) values[name] = value;
    }
  }
  return values;
}

// ==================== 会话本地保存 ====================

/** 将新登录的会话保存到本地 store（按 mid 去重，更新 currentSid） */
async function saveLocalSession(
  platform: Platform,
  input: Omit<AuthSession, "sid" | "createdAt" | "updatedAt">,
): Promise<AuthSession> {
  const state = await platform.getSessionState();
  const now = new Date().toISOString();
  const existing = state.sessions.find((s) => s.mid === input.mid);

  const session: AuthSession = {
    ...input,
    sid: existing?.sid ?? platform.randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const sessions = state.sessions
    .filter((s) => s.sid !== session.sid)
    .concat(session);

  await platform.setSessionState({ currentSid: session.sid, sessions });
  return session;
}

// ==================== 二维码生成 ====================

export async function clientQRGenerate(platform: Platform): Promise<{
  code: number;
  message: string;
  data?: QRGenerateData;
}> {
  try {
    const data = await platform.fetchBilibiliJson<{
      code: number;
      message: string;
      data?: { qrcode_key: string; url: string };
    }>({
      url: "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
    });

    if (data.code !== 0 || !data.data?.qrcode_key) {
      return { code: 1, message: data.message || "二维码生成失败" };
    }

    let image = "";
    try {
      image = await QRCode.toDataURL(data.data.url, {
        width: 280,
        margin: 1,
        errorCorrectionLevel: "M",
      });
    } catch {
      // 二维码图片生成失败，前端可用 url 兜底
    }

    return { code: 0, message: "ok", data: { ...data.data, image } };
  } catch (err) {
    return { code: 1, message: err instanceof Error ? err.message : "二维码生成失败" };
  }
}

// ==================== 二维码轮询 ====================

export async function clientQRPoll(
  platform: Platform,
  qrcodeKey: string,
): Promise<{ code: number; message: string; data?: QRPollData }> {
  try {
    const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`;
    const response = await platform.fetchRaw(url);
    const text = await response.text();

    let data: { code: number; message: string; data?: QRPollData };
    try {
      data = JSON.parse(text);
    } catch {
      return { code: 1, message: "登录接口返回格式异常，请重试" };
    }

    if (!data.data) {
      return { code: data.code, message: data.message };
    }

    if (data.data.code === 0) {
      // 从 poll 响应头提取 Cookie
      let cookieValues = extractCookieValues(response);

      // 若 poll 未返回 SESSDATA，跟随重定向 URL 兜底获取
      if (!cookieValues.SESSDATA && data.data.url) {
        try {
          const redir = await platform.fetchRaw(data.data.url);
          cookieValues = { ...cookieValues, ...extractCookieValues(redir) };
        } catch {
          // 忽略，沿用 poll 已获取的 cookie
        }
      }

      const sessdata = cookieValues.SESSDATA ?? "";
      if (!sessdata) {
        return { code: 1, message: "登录确认成功，但未能获取到SESSDATA，请重试" };
      }

      // 调用 nav 接口获取真实昵称和头像
      let uname = "B站用户";
      let mid = Number(cookieValues.DedeUserID || 0);
      let face = "";
      try {
        const nav = await platform.fetchBilibiliJson<{
          code: number;
          data?: { uname: string; mid: number; face?: string; isLogin: boolean };
        }>({
          url: "https://api.bilibili.com/x/web-interface/nav",
          cookie: `SESSDATA=${sessdata}`,
        });
        if (nav.code === 0 && nav.data?.isLogin) {
          uname = nav.data.uname || uname;
          mid = nav.data.mid || mid;
          face = nav.data.face || face;
        }
      } catch {
        // 昵称获取失败时使用默认值
      }

      const biliCookies = Object.entries(cookieValues).map(([k, v]) => `${k}=${v}`);

      // 保存会话到本地
      const saved = await saveLocalSession(platform, {
        uname,
        mid,
        face,
        biliSessdata: sessdata,
        biliRefreshToken: data.data.refresh_token || "",
        biliCookies,
        source: "qr",
        userToken: platform.randomUUID(),
      });

      return { code: 0, message: data.message, data: { ...data.data, sid: saved.sid } };
    }

    return { code: data.code, message: data.message, data: data.data };
  } catch (err) {
    return { code: 1, message: err instanceof Error ? err.message : "二维码轮询失败" };
  }
}

// ==================== 账号列表 ====================

export async function clientGetAccounts(platform: Platform): Promise<{
  code: number;
  data: { accounts: unknown[]; hasAccounts: boolean };
}> {
  const state = await platform.getSessionState();
  const accounts = state.sessions.map((s) => ({
    sid: s.sid,
    uname: s.uname,
    mid: s.mid,
    face: s.face ?? "",
    source: s.source,
    updatedAt: s.updatedAt,
  }));
  return {
    code: 0,
    data: { accounts, hasAccounts: accounts.length > 0 },
  };
}

// ==================== 登录状态 ====================

export async function clientGetStatus(platform: Platform): Promise<{
  code: number;
  message: string;
  data: { loggedIn: boolean; reason?: string; expired?: boolean; sid?: string; uname?: string; mid?: number; face?: string };
}> {
  const state = await platform.getSessionState();
  const session = state.sessions.find((s) => s.sid === state.currentSid);
  if (!session) {
    return { code: 0, message: "no active site session", data: { loggedIn: false, reason: "no session" } };
  }
  // 本地优先：存在会话即视为已登录（凭证有效性由数据拉取时校验）
  return {
    code: 0,
    message: "active",
    data: {
      loggedIn: true,
      sid: session.sid,
      uname: session.uname,
      mid: session.mid,
      face: session.face,
    },
  };
}

// ==================== 切换账号 ====================

export async function clientSwitch(platform: Platform, sid: string): Promise<{ code: number; message?: string }> {
  const state = await platform.getSessionState();
  if (!state.sessions.some((s) => s.sid === sid)) {
    return { code: 1, message: "会话不存在" };
  }
  await platform.setSessionState({ ...state, currentSid: sid });
  return { code: 0 };
}

/**
 * 为"纯服务器收集、本机无 B站 凭证"的账号创建本机会话并切换过去。
 * source="server"、无 biliSessdata/biliCookies，本地架构无法用 B站 Cookie 拉取数据，
 * 数据展示完全依赖已保存到 uid_<mid> 的本地文件（由 admin 页从自建服务器拉取）。
 */
export async function clientCreateServerSession(
  platform: Platform,
  input: { mid: number; uname: string; face?: string },
): Promise<{ code: number; message?: string; data?: { sid: string } }> {
  const saved = await saveLocalSession(platform, {
    uname: input.uname,
    mid: input.mid,
    face: input.face ?? "",
    biliSessdata: "",
    biliRefreshToken: "",
    biliCookies: [],
    source: "server",
    userToken: platform.randomUUID(),
  });
  return { code: 0, data: { sid: saved.sid } };
}

// ==================== 登出 ====================

export async function clientLogout(platform: Platform): Promise<void> {
  const state = await platform.getSessionState();
  await platform.setSessionState({ ...state, currentSid: null });
}
