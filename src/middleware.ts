import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readGlobalSwitch } from "@/lib/global-switch";
import { getAdminSid, validateAdminSession } from "@/lib/admin-sessions";

/**
 * 全局中间件：CORS 兜底 + 全局访问开关（kill switch）
 *
 * CORS：Tauri WebView 的 origin 是 https://tauri.localhost，向 http://<server> 发请求是跨域。
 * 虽然 Tauri HTTP plugin 理论上会拦截 fetch，但某些情况下 WebView 原生 fetch 仍可能被使用，
 * 此中间件作为兜底方案，确保所有 API 请求都能正常返回。
 *
 * 全局访问开关：读取 .data/global-switch.json，disabled=true 时对所有 /api/* 返回 503 统一提示；
 * 以下请求放行（切断期间仍能进后台排查并恢复）：
 *   1) /api/admin/*（登录、开关自身等后台接口）
 *   2) 携带有效 admin sid 的请求（后台页面会调用非 admin 接口，如 /api/gift-catalog）
 * 需要 Node 运行时才能读本地文件（见下方 config 的 runtime: "nodejs"）。
 *
 * 注意：本文件不要直接 import node 内置模块（fs/path 等），也不要 import 会拉入
 * node:crypto 的模块（如 @/lib/auth/admin），否则 Turbopack 会把中间件按 edge 运行时
 * 编译并报 "does not support Node.js 'path' module"；需要读文件的逻辑一律放在
 * crypto-free 的 @/lib/* 模块里（如 global-switch、admin-sessions）。
 */
export async function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") || "*";

  // 统一 CORS 头
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie, X-Admin-Sid",
  };

  // 预检请求直接放行：若被开关拦成 503，浏览器将无法发起真实请求
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: cors });
  }

  // 全局访问开关：切断 /api/*（放行 /api/admin/* 与携带有效 admin sid 的请求）
  if (!request.nextUrl.pathname.startsWith("/api/admin/")) {
    const { disabled } = await readGlobalSwitch();
    if (disabled) {
      const sid = getAdminSid(request);
      const isAdmin = sid ? await validateAdminSession(sid) : false;
      if (!isAdmin) {
        return new NextResponse(
          JSON.stringify({ code: -1, message: "服务暂时不可用，请稍后重试" }),
          { status: 503, headers: { ...cors, "Content-Type": "application/json" } },
        );
      }
    }
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  // 需要读本地开关/会话文件：middleware 使用 Node 运行时（Next 16 支持）
  runtime: "nodejs",
  matcher: "/api/:path*",
};
