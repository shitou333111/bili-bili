import { NextResponse } from "next/server";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");

/** 用户个人信息文件：重建时保留，避免丢失头像/昵称等元数据 */
const KEEP_FILES = new Set(["account-info.json"]);

export async function POST(request: Request) {
  // 认证：优先 cookie，fallback 到 query 参数
  const cookieHeader = request.headers.get("cookie") ?? "";
  const sidMatch = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`));
  let sid = sidMatch?.[1] ?? null;
  if (!sid) {
    const url = new URL(request.url);
    sid = url.searchParams.get("_sid") ?? null;
  }
  const session = await getActiveSessionFromCookie(sid);

  if (!session) {
    return NextResponse.json({ code: -1, message: "未登录" }, { status: 200 });
  }

  const userDir = path.join(DATA_DIR, `uid_${session.mid}`);
  try {
    await fs.access(userDir);
  } catch {
    return NextResponse.json({ code: 0, message: "数据目录不存在，无需清理" }, { status: 200 });
  }

  try {
    const entries = await fs.readdir(userDir, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (KEEP_FILES.has(entry.name)) continue;
      const filePath = path.join(userDir, entry.name);
      await fs.unlink(filePath);
      removed.push(entry.name);
    }
    console.log(`[rebuild-database] mid=${session.mid} uname=${session.uname} 删除 ${removed.length} 个文件: ${removed.join(", ")}`);
    return NextResponse.json(
      { code: 0, message: `已删除 ${removed.length} 个数据文件` },
      { status: 200 },
    );
  } catch (err: any) {
    console.error(`[rebuild-database] 删除失败:`, err?.message || err);
    return NextResponse.json(
      { code: 500, message: `删除失败: ${err?.message || String(err)}` },
      { status: 200 },
    );
  }
}
