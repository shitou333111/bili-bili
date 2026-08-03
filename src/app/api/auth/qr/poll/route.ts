import { NextRequest, NextResponse } from "next/server";
import { createSessionInput, getSessionCookieName, getUserTokenCookieName, saveSession } from "@/lib/auth/session";
import { fetchBilibiliJson } from "@/lib/bilibili/client";
import type { ApiResponse, QRPollResult } from "@/lib/bilibili/types";

export const dynamic = "force-dynamic";

function extractCookieValues(response: Response) {
  const headerList =
    typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie") as string]
        : [];

  const cookieValues: Record<string, string> = {};

  for (const header of headerList) {
    for (const part of header.split(/,(?=\s*[A-Za-z0-9_\-]+=)/g)) {
      const [nameValue] = part.split(";", 1);
      const equalsIndex = nameValue.indexOf("=");
      if (equalsIndex <= 0) continue;
      const name = nameValue.slice(0, equalsIndex).trim();
      const value = nameValue.slice(equalsIndex + 1).trim();
      if (name) cookieValues[name] = value;
    }
  }

  return cookieValues;
}

async function followRedirectAndGetCookies(redirectUrl: string, existingCookies: string[]): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Referer: "https://www.bilibili.com/",
  };
  if (existingCookies.length > 0) {
    headers["Cookie"] = existingCookies.join("; ");
  }

  const response = await fetch(redirectUrl, {
    redirect: "manual",
    headers,
    cache: "no-store",
  });

  const cookies = extractCookieValues(response);

  // 如果响应是重定向，继续跟随直到拿到最终Cookie
  const location = response.headers.get("location");
  if (location && (response.status === 302 || response.status === 301)) {
    const mergedCookies = existingCookies.map((c) => {
      const [name] = c.split("=", 1);
      return cookies[name] ? `${name}=${cookies[name]}` : c;
    });
    for (const [name, value] of Object.entries(cookies)) {
      if (!mergedCookies.some((c) => c.startsWith(`${name}=`))) {
        mergedCookies.push(`${name}=${value}`);
      }
    }
    return followRedirectAndGetCookies(
      location.startsWith("http") ? location : new URL(location, redirectUrl).toString(),
      mergedCookies,
    );
  }

  return cookies;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const qrcodeKey = url.searchParams.get("qrcode_key");

  if (!qrcodeKey) {
    return NextResponse.json<ApiResponse<QRPollResult>>(
      {
        code: 1,
        message: "qrcode_key is required",
      },
      { status: 200 },
    );
  }

  try {
    const response = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      {
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Referer: "https://www.bilibili.com/",
          Accept: "application/json, text/plain, */*",
        },
      },
    );

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      const html = await response.text();
      console.error("[QR Poll] B站返回HTML而非JSON，前200字符:", html.slice(0, 200));
      return NextResponse.json<ApiResponse<QRPollResult>>(
        { code: 1, message: "B站接口返回异常，请稍后重试" },
        { status: 200 },
      );
    }

    const rawText = await response.text();
    let data: { code: number; message: string; data?: QRPollResult };
    try {
      data = JSON.parse(rawText);
    } catch {
      console.error("[QR Poll] JSON解析失败，原始响应:", rawText.slice(0, 300));
      return NextResponse.json<ApiResponse<QRPollResult>>(
        { code: 1, message: "B站接口返回格式异常，请稍后重试" },
        { status: 200 },
      );
    }

    if (!data.data) {
      return NextResponse.json<ApiResponse<QRPollResult>>(
        {
          code: data.code,
          message: data.message,
        },
        { status: 200 },
      );
    }

    if (data.data.code === 0) {
      // 先从poll响应中提取Cookie
      let cookieValues = extractCookieValues(response);
      const pollCookies = Object.entries(cookieValues).map(([name, value]) => `${name}=${value}`);

      // 如果poll响应没有SESSDATA，跟随重定向URL获取
      if (!cookieValues.SESSDATA && data.data.url) {
        console.log("[QR Login] poll响应中未找到SESSDATA，跟随重定向URL获取Cookie...");
        try {
          const redirectCookies = await followRedirectAndGetCookies(data.data.url, pollCookies);
          cookieValues = { ...cookieValues, ...redirectCookies };
        } catch (err) {
          console.error("[QR Login] 跟随重定向URL失败:", err);
        }
      }

      const sessdata = cookieValues.SESSDATA ?? "";
      const dedeUserId = cookieValues.DedeUserID ?? "";
      const biliJct = cookieValues.bili_jct ?? "";
      const biliCookies = Object.entries(cookieValues).map(([name, value]) => `${name}=${value}`);

      console.log("[QR Login] 获取到的Cookie keys:", Object.keys(cookieValues).join(", "));
      console.log("[QR Login] SESSDATA 是否获取到:", Boolean(sessdata));

      if (!sessdata) {
        return NextResponse.json<ApiResponse<QRPollResult>>(
          {
            code: 1,
            message: "登录确认成功，但未能获取到SESSDATA，请重试",
          },
          { status: 200 },
        );
      }

      // 调用B站nav接口获取真实昵称和头像
      let uname = "B站用户";
      let mid = Number(dedeUserId || 0);
      let face = "";
      try {
        const navData = await fetchBilibiliJson<{ code: number; data?: { uname: string; mid: number; face?: string; isLogin: boolean } }>({
          url: "https://api.bilibili.com/x/web-interface/nav",
          cookie: `SESSDATA=${sessdata}`,
        });
        if (navData.code === 0 && navData.data?.isLogin) {
          uname = navData.data.uname || uname;
          mid = navData.data.mid || mid;
          face = navData.data.face || face;
          console.log("[QR Login] 获取到用户信息:", uname, mid, face);
        }
      } catch (err) {
        console.error("[QR Login] 获取用户昵称失败:", err);
      }

      // 获取或生成用户标识
      let userToken = request.cookies.get(getUserTokenCookieName())?.value;
      if (!userToken) {
        userToken = crypto.randomUUID();
      }

      const session = createSessionInput({
        uname,
        mid,
        face,
        biliSessdata: sessdata,
        biliRefreshToken: data.data.refresh_token || "",
        biliCookies,
        source: "qr",
        userToken,
      });

      const savedSession = await saveSession(session);

      const localResponse = NextResponse.json<ApiResponse<QRPollResult & { sid?: string; userToken?: string }>>(
        {
          code: data.code,
          message: data.message,
          data: { ...data.data, sid: savedSession.sid, userToken },
        },
        { status: 200 },
      );
      localResponse.cookies.set(getSessionCookieName(), savedSession.sid, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      });
      // 设置用户标识 Cookie（非 httpOnly，以便客户端可以读取）
      localResponse.cookies.set(getUserTokenCookieName(), userToken, {
        httpOnly: false,
        sameSite: "lax",
        path: "/",
        maxAge: 365 * 24 * 60 * 60, // 1年有效期
      });
      return localResponse;
    }

    return NextResponse.json<ApiResponse<QRPollResult>>(
      {
        code: data.code,
        message: data.message,
        data: data.data,
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json<ApiResponse<QRPollResult>>(
      {
        code: 1,
        message: error instanceof Error ? error.message : "二维码轮询失败",
      },
      { status: 200 },
    );
  }
}