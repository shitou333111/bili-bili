import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { readState, getSessionCookieName } from "@/lib/auth/session";
import { readUsersList, type UsersListEntry } from "@/lib/user-data";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

/** 获取用户上传数据的最后更新时间（用 uid_<mid> 目录） */
async function getLastUploadDate(mid: number): Promise<string | null> {
  try {
    const metaPath = path.join(process.cwd(), ".data", "uploads", `uid_${mid}`, "_upload_meta.json");
    const raw = await fs.readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    return meta.last_upload || null;
  } catch {
    return null;
  }
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
  // 本机登录标识：用于标记“本机登录”账号并置顶
  const deviceToken = url.searchParams.get("_device_token") ?? null;

  const state = await readState();
  // 本机会话（bili-live-state.json 只存本机登录账号）。
  // 只有携带了与客户端一致的 deviceToken 时，才把对应账号标记为"本机"。
  // 未携带/不匹配 deviceToken 时一律不标记为"本机"（避免把服务器上残留的其他设备账号误标为"本机"）。
  const localSessions = deviceToken
    ? state.sessions.filter((s) => s.userToken === deviceToken)
    : [];

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
      isLocal: true,
    });
  }

  const users = await Promise.all(
    Array.from(map.values()).map(async (u) => {
      const lastUpload = await getLastUploadDate(u.mid);
      return {
        sid: u.sid ?? null, // 本机登录账号才有本地会话 sid（可用于切换）
        uname: u.uname,
        mid: u.mid,
        face: u.face,
        source: u.source ?? "upload",
        createdAt: "",
        updatedAt: u.updatedAt,
        lastUpload: lastUpload || undefined,
        isCurrent: u.sid !== null && u.sid === currentSid, // 标记当前激活账号
        isLocal: !!u.isLocal,
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