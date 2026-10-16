import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readState, getSessionCookieName, getUserTokenCookieName, getSessionBySid } from "@/lib/auth/session";
import { readUsersList, readAccountStreamerStatus, type UsersListEntry, type UserDeviceRecord } from "@/lib/user-data";
import { resolveDeviceBrand } from "@/lib/device-model";
import { promises as fs } from "fs";
import path from "path";

/** 设备记录 → 返回给 admin 的展示形态：把机型代号（如 V2301A）解析为「品牌 市场名」（如 Vivo iQOO Neo8） */
function resolveDevices(devices?: UserDeviceRecord[]) {
  return devices?.map((d) => ({ ...d, brand: resolveDeviceBrand(d.brand) ?? d.brand }));
}

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

/** 获取用户数据的最后更新时间（读规范每用户数据目录 .data/uid_<mid>/ 中最新数据文件的 mtime）。 */
async function getLastUploadDate(mid: number): Promise<string | null> {
  try {
    const dir = path.join(process.cwd(), ".data", `uid_${mid}`);
    const names = await fs.readdir(dir);
    let latest = 0;
    for (const name of names) {
      if (name.startsWith("_")) continue;
      const st = await fs.stat(path.join(dir, name));
      if (st.mtimeMs > latest) latest = st.mtimeMs;
    }
    if (latest > 0) return new Date(latest).toISOString();
  } catch { /* 目录不存在则忽略 */ }
  return null;
}

export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  // 当前浏览器登录账号：优先 cookie，fallback 到 query 参数（Tauri WebView 可能不发送 cookie）
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookieSid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  const currentSid = url.searchParams.get("_sid") ?? cookieSid ?? null;
  // 本机登录标识：优先 query 参数，fallback 到 cookie（Tauri 下 localStorage 可能跨源未同步）
  const queryDeviceToken = url.searchParams.get("_device_token") ?? null;
  const cookieDeviceToken = cookieHeader.match(new RegExp(`${getUserTokenCookieName()}=([^;]+)`))?.[1] ?? null;
  const deviceToken = queryDeviceToken || cookieDeviceToken || null;

  const state = await readState();
  // 本机会话（web-login-state.json 只存本机登录账号）。
  const localSessions = deviceToken
    ? state.sessions.filter((s) => s.userToken === deviceToken)
    : [];

  // 通过 currentSid 查找当前登录用户（即使 deviceToken 为空也能标记当前用户）
  const currentSession = currentSid ? await getSessionBySid(currentSid) : null;
  const currentMid = currentSession?.mid ?? null;

  // users-list.json 是服务器上的"使用用户表"，包含所有（含服务器收集的）用户
  const usersList: UsersListEntry[] = await readUsersList();

  // 以 mid 为主键合并：本机会话提供 face/source/是否本机；users-list 提供昵称与更新时间
  const map = new Map<number, any>();
  for (const entry of usersList) {
    map.set(entry.mid, {
      mid: entry.mid,
      uname: entry.uname,
      updatedAt: entry.updatedAt,
      isLocal: false,
      platform: entry.platform,
      devices: entry.devices,
    });
  }
  for (const s of localSessions) {
    const existing = map.get(s.mid);
    map.set(s.mid, {
      sid: s.sid,
      mid: s.mid,
      uname: s.uname,
      face: s.face,
      source: s.source,
      updatedAt: existing ? existing.updatedAt : s.updatedAt,
      // 本机 = 有 B站 登录凭证（source!=="server"）的账号；服务器收集账号仅可查看，不算本机
      isLocal: s.source !== "server",
      platform: existing?.platform,
      devices: existing?.devices,
    });
  }

  const users = await Promise.all(
    Array.from(map.values()).map(async (u) => {
      const lastUpload = await getLastUploadDate(u.mid);
      // 是否为主播：三态判定（有收益记录=主播；已确认无收益=非主播；其余=未判定）。
      // 仅依据本地已有数据，每次加载实时计算——本地数据更新后状态自动跟随变化。
      const streamerStatus = await readAccountStreamerStatus(u.mid, u.uname);
      return {
        sid: u.sid ?? null, // 本机登录账号才有本地会话 sid（可用于切换）
        uname: u.uname,
        mid: u.mid,
        face: u.face,
        source: u.source ?? "upload",
        createdAt: "",
        updatedAt: u.updatedAt,
        lastUpload: lastUpload || undefined,
        isCurrent: (u.sid !== null && u.sid === currentSid) || (currentMid !== null && u.mid === currentMid), // 标记当前激活账号
        isLocal: !!u.isLocal,
        platform: u.platform, // 最近使用平台：web/desktop/android/ios
        devices: resolveDevices(u.devices), // 设备记录列表（品牌型号/系统版本/浏览器等）
        streamerStatus, // 主播三态：streamer=有收益记录 / non-streamer=已确认无收益 / unknown=未判定
      };
    })
  );

  // 本机登录账号置顶，其余按更新时间倒序
  users.sort((a, b) => {
    if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return NextResponse.json({ code: 0, data: { users, currentSid, deviceToken } });
}