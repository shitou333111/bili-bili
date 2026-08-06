import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { readState, getSessionCookieName } from "@/lib/auth/session";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

/** 获取用户上传数据的最后更新时间 */
async function getLastUploadDate(mid: number, uname: string): Promise<string | null> {
  try {
    const safeName = uname.replace(/[\\/:*?"<>|]/g, "_");
    const metaPath = path.join(process.cwd(), ".data", "uploads", `uid_${mid}_${safeName}`, "_upload_meta.json");
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

  const state = await readState();
  // 按 mid 去重，保留最新的记录
  const seen = new Map<number, typeof state.sessions[0]>();
  for (const s of state.sessions) {
    const existing = seen.get(s.mid);
    if (!existing || new Date(s.updatedAt) > new Date(existing.updatedAt)) {
      seen.set(s.mid, s);
    }
  }

  const users = await Promise.all(
    Array.from(seen.values()).map(async (s) => {
      const lastUpload = await getLastUploadDate(s.mid, s.uname);
      return {
        sid: s.sid,
        uname: s.uname,
        mid: s.mid,
        face: s.face,
        source: s.source,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastUpload: lastUpload || undefined,
        // 默认选中当前浏览器登录账号（而非全局 currentSid）
        isCurrent: s.sid === currentSid,
      };
    })
  );

  return NextResponse.json({ code: 0, data: { users, currentSid } });
}