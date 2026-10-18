/**
 * 管理员鉴权入口。
 *
 * 会话持久化/校验（fs/path）已拆到 @/lib/admin-sessions（crypto-free），
 * 以便 middleware 直接使用该模块而不会被 Turbopack 判定为 edge 运行时；
 * 本模块额外提供密码校验与 sid 生成（依赖 node:crypto，仅服务端路由使用）。
 */

import {
  appendAdminSession,
  getAdminSid,
  validateAdminSession,
  getAdminCookieName,
} from "@/lib/admin-sessions";

export { getAdminSid, validateAdminSession, getAdminCookieName };

export function verifyAdmin(username: string | undefined, password: string): boolean {
  // 仅校验密码（管理员账号固定为 admin，用户名无需校验）。
  // 密码从环境变量 ADMIN_PASSWORD 读取（本地：.env.local；生产：GitHub Actions Secrets 注入），
  // 避免硬编码在源码中导致仓库泄露。
  return password === (process.env.ADMIN_PASSWORD ?? "");
}

export async function createAdminSession(): Promise<string> {
  const { randomUUID } = await import("crypto");
  const sid = randomUUID();
  await appendAdminSession({ sid, loginAt: new Date().toISOString() });
  return sid;
}
