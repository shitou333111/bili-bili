import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readGlobalSwitch } from "@/lib/global-switch";
import { getAdminSid, validateAdminSession } from "@/lib/admin-sessions";

/**
 * 全局中间件：CORS 兜底 + 全局访问开关（kill switch）+ 网页端开关
 *
 * CORS：Tauri WebView 的 origin 是 https://tauri.localhost，向 http://<server> 发请求是跨域。
 * 虽然 Tauri HTTP plugin 理论上会拦截 fetch，但某些情况下 WebView 原生 fetch 仍可能被使用，
 * 此中间件作为兜底方案，确保所有 API 请求都能正常返回。
 *
 * 全局访问开关：读取 .data/global-switch.json，disabled=true 时对所有 /api/* 返回 503 统一提示；
 * 以下请求放行（切断期间仍能进后台排查并恢复）：
 *   1) /api/admin/*（登录、开关自身等后台接口）
 *   2) 携带有效 admin sid 的请求（后台页面会调用非 admin 接口，如 /api/gift-catalog）
 *
 * 网页端开关：webDisabled=true 时，浏览器访问应用页面（app.bili-bili.icu）不再返回软件，
 * 而是返回「由于官方限制，当前网页端不可用，请下载客户端使用」提示页。
 * 客户端为 Tauri（加载本地 out 资源），不经过本服务器的文档请求，因此不受影响；
 * /admin（管理后台）与 /landing（官网）始终放行。
 *
 * 需要 Node 运行时才能读本地文件（见下方 config 的 runtime: "nodejs"）。
 *
 * 注意：本文件不要直接 import node 内置模块（fs/path 等），也不要 import 会拉入
 * node:crypto 的模块（如 @/lib/auth/admin），否则 Turbopack 会把中间件按 edge 运行时
 * 编译并报 "does not support Node.js 'path' module"；需要读文件的逻辑一律放在
 * crypto-free 的 @/lib/* 模块里（如 global-switch、admin-sessions）。
 */

/** 网页端关闭时的提示页（纯 HTML，不依赖前端 bundle） */
function webDisabledHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>B瓜 · 网页端暂停使用</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f5f3ef;
    color: #1f1c17;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: rgba(255, 255, 255, .9);
    border: 1px solid rgba(0, 0, 0, .1);
    border-radius: 20px;
    padding: 32px 24px 28px;
    text-align: center;
    box-shadow: 0 20px 80px rgba(31, 28, 23, .08);
  }
  .icon { width: 64px; height: 64px; border-radius: 18px; display: block; margin: 0 auto; }
  h1 { margin: 16px 0 0; font-size: 20px; font-weight: 600; }
  p { margin: 12px auto 0; max-width: 320px; font-size: 14px; line-height: 1.7; color: rgba(0, 0, 0, .6); }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    max-width: 320px;
    margin-top: 26px;
    padding: 12px 24px;
    border-radius: 999px;
    background: #1f1c17;
    color: #fff;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
  }
  .btn:hover { opacity: .9; }
  .link {
    display: inline-block;
    margin-top: 14px;
    font-size: 12px;
    color: rgba(0, 0, 0, .45);
    text-decoration: none;
  }
  .link:hover { color: rgba(0, 0, 0, .75); text-decoration: underline; text-underline-offset: 2px; }
</style>
</head>
<body>
  <main class="card">
    <img class="icon" src="/orig_icon.png" alt="B瓜" width="64" height="64">
    <h1>网页端暂停使用</h1>
    <p>由于官方限制，当前网页端不可用，请下载客户端使用。</p>
    <a class="btn" href="https://bili-bili.icu/#download">下载客户端</a>
    <br>
    <a class="link" href="https://bili-bili.icu/">访问网站首页</a>
  </main>
</body>
</html>`;
}

export async function middleware(request: NextRequest) {
  const origin = request.headers.get("origin") || "*";
  const { pathname } = request.nextUrl;

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

  // ==================== /api/*：全局访问开关 ====================
  if (pathname.startsWith("/api")) {
    // 切断 /api/*（放行 /api/admin/* 与携带有效 admin sid 的请求）
    if (!pathname.startsWith("/api/admin/")) {
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

  // ==================== 页面文档：网页端开关 ====================
  // 只拦浏览器直接打开的 HTML 文档；静态资源（含 . 的路径）不会进入本中间件。
  // 管理后台 /admin 与官网 /landing 始终放行。
  // 本机地址（http://localhost:3000）不拦：Tauri dev 客户端的 devUrl 指向本地 dev server，
  // 若在此拦截会把桌面开发客户端也挡在门外；正式包的客户端加载本地 out 资源，不会走到这里。
  const host = request.nextUrl.hostname;
  const isLocalDev = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const accept = request.headers.get("accept") || "";
  const isDocument =
    (request.method === "GET" || request.method === "HEAD") && accept.includes("text/html");
  if (
    isDocument &&
    !isLocalDev &&
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/landing") &&
    // 公开黑白榜不依赖登录，网页端关闭时仍保持可访问
    !pathname.startsWith("/hbb")
  ) {
    const { webDisabled } = await readGlobalSwitch();
    if (webDisabled) {
      return new NextResponse(request.method === "HEAD" ? null : webDisabledHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, max-age=0",
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = {
  // 需要读本地开关/会话文件：middleware 使用 Node 运行时（Next 16 支持）
  runtime: "nodejs",
  // 覆盖 /api/* 与所有页面文档（排除 _next 静态资源与带扩展名的文件）
  matcher: ["/api/:path*", "/((?!_next|api|.*\\..*).*)"],
};
