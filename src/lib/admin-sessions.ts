/**
 * 管理员会话的持久化与校验（crypto-free）。
 *
 * 为什么单独拆一份：middleware 运行在 Node 运行时，需要校验 admin sid 以在全局开关
 * 切断期间放行后台请求；但 middleware **不能** indirect/直接 import 会拉入 node:crypto
 * 的模块，否则 Turbopack 会把中间件按 edge 运行时编译（报不支持 Node 内置模块）。
 * 因此这里只依赖 fs/path，不引入 crypto；sid 的生成放在 @/lib/auth/admin.ts。
 */

import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".data");
const ADMIN_STATE_FILE = path.join(STATE_DIR, "admin-sessions.json");
const ADMIN_COOKIE_NAME = "admin_sid";

export type AdminSession = {
  sid: string;
  loginAt: string;
};

async function ensureAdminFile() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  try {
    await fs.access(ADMIN_STATE_FILE);
  } catch {
    await fs.writeFile(ADMIN_STATE_FILE, JSON.stringify([]), "utf8");
  }
}

export async function readAdminSessions(): Promise<AdminSession[]> {
  await ensureAdminFile();
  const raw = await fs.readFile(ADMIN_STATE_FILE, "utf8");
  try {
    return JSON.parse(raw) as AdminSession[];
  } catch {
    return [];
  }
}

async function writeAdminSessions(sessions: AdminSession[]) {
  await ensureAdminFile();
  await fs.writeFile(ADMIN_STATE_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

/** 追加一条管理员会话 */
export async function appendAdminSession(session: AdminSession): Promise<void> {
  const sessions = await readAdminSessions();
  sessions.push(session);
  await writeAdminSessions(sessions);
}

export async function validateAdminSession(sid: string | null): Promise<boolean> {
  if (!sid) return false;
  const sessions = await readAdminSessions();
  return sessions.some((s) => s.sid === sid);
}

export function getAdminCookieName() {
  return ADMIN_COOKIE_NAME;
}

/**
 * 从请求中解析管理员会话标识，按优先级：
 *   1. query 参数 admin_sid
 *   2. 请求头 X-Admin-Sid
 *   3. Cookie admin_sid
 *
 * 原因：Tauri (iOS/Android) 中前端与服务器跨源（tauri://localhost → http://服务器），
 * 且登录 cookie 用 SameSite=lax，跨源 fetch 不会携带该 cookie，导致 admin 页面内容为空。
 * 因此改为在登录成功后由前端把 sid 显式带在请求头/查询串里，绕开跨源 cookie 限制。
 */
export function getAdminSid(request: Request): string | null {
  const url = new URL(request.url);
  const qs = url.searchParams.get("admin_sid");
  if (qs) return qs;
  const header = request.headers.get("x-admin-sid");
  if (header) return header;
  const cookieHeader = request.headers.get("cookie") ?? "";
  return cookieHeader.match(new RegExp(`${ADMIN_COOKIE_NAME}=([^;]+)`))?.[1] ?? null;
}
