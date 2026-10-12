import { NextRequest, NextResponse } from "next/server";
import { getSessionBySid, getSessionCookieName } from "@/lib/auth/session";
import { upsertUserInList, type UserDeviceRecord } from "@/lib/user-data";

/**
 * 用户平台/设备信息上报
 *
 * POST /api/user/report
 * body: { mid?, uname?, device: { platform, brand?, os?, osVersion?, browser?, browserVersion?, ua? } }
 *
 * 身份识别双通道：
 * - Tauri 原生端：登录态保存在本地，请求体带 mid/uname
 * - Web 端：从会话 cookie（bili_live_sid）解析用户
 * 未识别到用户时不写入，返回 recorded:false。
 */

const PLATFORMS = new Set(["web", "desktop", "android", "ios"]);

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ code: 1, message: "invalid json" }, { status: 400 });
  }

  const deviceRaw = (body.device ?? {}) as Record<string, unknown>;
  const platform = cleanStr(deviceRaw.platform, 16);
  if (!platform || !PLATFORMS.has(platform)) {
    return NextResponse.json({ code: 1, message: "invalid platform" }, { status: 400 });
  }

  // 身份：body.mid（Tauri 端）优先，否则用会话 cookie（Web 端）
  let mid = Number(body.mid) || 0;
  let uname = cleanStr(body.uname, 64) ?? "";
  if (mid <= 0) {
    const sid = request.cookies.get(getSessionCookieName())?.value;
    const session = await getSessionBySid(sid);
    if (!session) {
      return NextResponse.json({ code: 0, data: { recorded: false } });
    }
    mid = session.mid;
    uname = session.uname;
  }
  if (!uname) uname = `uid_${mid}`;

  const device: Omit<UserDeviceRecord, "lastSeen"> = {
    platform,
    brand: cleanStr(deviceRaw.brand, 64),
    os: cleanStr(deviceRaw.os, 32),
    osVersion: cleanStr(deviceRaw.osVersion, 32),
    browser: cleanStr(deviceRaw.browser, 32),
    browserVersion: cleanStr(deviceRaw.browserVersion, 32),
  };

  await upsertUserInList(mid, uname, device);
  return NextResponse.json({ code: 0, data: { recorded: true } });
}
