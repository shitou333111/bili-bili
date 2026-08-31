import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// 仅允许代理 B站 的 API 域名，避免 SSRF；host 精确匹配。
const ALLOWED_HOSTS = [
  "api.live.bilibili.com",
  "api.bilibili.com",
  "passport.bilibili.com",
];

/**
 * B站 API 透传代理（供 /moniqi Web 镜像页使用）。
 *
 * 背景：原生 WebView 加载活动 H5 时 origin 与 api.live.bilibili.com 同源，
 * 背景接口（时间/用户信息/房间语音等）直连即可。而 Web 镜像页跑在自有域名下，
 * 这些非 mock 的背景接口直连会被 CORS 拦截。此路由同源转发 B站 真实响应，
 * 让镜像外壳完整初始化并正确切到目标玩法标签；玩法规类接口仍由 mock-shim 本地处理。
 */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) {
    return Response.json({ code: -1, message: "missing url" }, { status: 400 });
  }
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return Response.json({ code: -1, message: "invalid url" }, { status: 400 });
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return Response.json({ code: -1, message: "protocol not allowed" }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.includes(u.host)) {
    return Response.json({ code: -1, message: "host not allowed" }, { status: 400 });
  }

  try {
    const upstream = await fetch(u.toString(), {
      headers: {
        "User-Agent":
          req.headers.get("user-agent") ||
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        Referer: "https://live.bilibili.com/",
        Accept: "application/json, text/plain, */*",
      },
      redirect: "follow",
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    return new Response(buf, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return Response.json({ code: -500, message: "proxy error" }, { status: 502 });
  }
}