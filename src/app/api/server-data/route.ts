import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

/**
 * /api/server-data
 *
 * 供主页“服务器账号（source=server）”的刷新按钮使用：从自建服务器拉取该账号的数据文件，
 * 客户端据此覆盖本机 uid_<mid> 本地缓存，实现“从服务器重新加载数据”。
 *
 * 数据属于敏感信息，仅管理员可读取（与 /api/upload 的 GET 同一鉴权口径）：
 * 客户端携带 admin_sid（query 参数或 X-Admin-Sid 头），未通过校验返回 403，
 * 防止第三方仅凭 uid 枚举读取任意用户数据。
 */
export async function GET(request: NextRequest) {
  const isAdmin = await validateAdminSession(getAdminSid(request));
  if (!isAdmin) {
    return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });
  }

  const mid = parseInt(request.nextUrl.searchParams.get("mid") || "0");
  if (!mid) {
    return NextResponse.json({ code: -1, message: "missing mid" }, { status: 400 });
  }

  const files: Record<string, string> = {};
  // 读规范每用户数据目录 .data/uid_<mid>/
  try {
    const dir = path.join(process.cwd(), ".data", `uid_${mid}`);
    const names = await fs.readdir(dir);
    for (const name of names) {
      if (name.startsWith("_")) continue;
      files[name] = await fs.readFile(path.join(dir, name), "utf-8");
    }
  } catch { /* 目录不存在则忽略 */ }

  // 附带全局盲盒信息（名称/单价/爆出礼物对照表），供盲盒/合成页正确显示。
  const blindboxInfo: Record<string, unknown> = {};
  try {
    const dir = path.join(process.cwd(), ".data", "blindbox_info");
    const names = await fs.readdir(dir);
    for (const name of names) {
      const m = name.match(/^(\d+)\.json$/);
      if (!m) continue;
      blindboxInfo[m[1]] = JSON.parse(await fs.readFile(path.join(dir, name), "utf-8"));
    }
  } catch { /* 目录不存在则忽略 */ }

  return NextResponse.json({ code: 0, data: { files, blindboxInfo } });
}
