import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 全局 CORS 中间件
 * Tauri WebView 的 origin 是 https://tauri.localhost，向 http://localhost:3000 发请求是跨域。
 * 虽然 Tauri HTTP plugin 理论上会拦截 fetch，但某些情况下 WebView 原生 fetch 仍可能被使用，
 * 此中间件作为兜底方案，确保所有 API 请求都能正常返回。
 */
export function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") || "*";
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");

  if (isApiRoute) {
    const response = NextResponse.next();

    // 允许所有跨域请求（API routes 不涉及敏感数据，服务器仅供客户端调用）
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Cookie, X-Admin-Sid",
    );

    // 处理 OPTIONS 预检请求
    if (request.method === "OPTIONS") {
      return new NextResponse(null, { status: 204, headers: response.headers });
    }

    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};