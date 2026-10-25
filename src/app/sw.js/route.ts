import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { BUILD_SEQ } from "@/lib/build-info";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

/**
 * PWA Service Worker 脚本（Web 端专用，Tauri 构建时该 .ts 路由被 pageExtensions 排除）。
 *
 * 为什么用路由动态生成而不是 public/sw.js 静态文件：
 * 浏览器判定"有新版本"的唯一依据是 sw.js 的字节内容是否变化。静态文件的字节永远不变，
 * 因此必须把 CI 构建序号注入到脚本里，让每次部署的内容都不同，更新检测才会生效。
 *
 * kill switch：服务器上存在 .data/pwa-disable 文件时，脚本退化为"卸载并清空缓存"，
 * 用于线上 PWA 出问题时无需发版即可让所有客户端回到普通网页。
 */
const SW_TEMPLATE = `/**
 * B瓜 Web PWA Service Worker
 * 本文件由 /sw.js 路由动态生成（src/app/sw.js/route.ts），构建序号在构建期注入。
 *
 * 缓存策略（保守优先，避免任何"缓存旧页面导致白屏"的事故）：
 *  - 导航请求：network-first（永远优先拿新 HTML），断网才回退缓存
 *  - /_next/static/* 与静态图片/字体：cache-first（内容带 hash，天然安全）
 *  - /api/*、/admin、/moniqi、/display、/artifacts、跨域请求：完全不拦截
 *  - 新版本不在 install 阶段 skipWaiting，必须等用户点击横幅后才切换
 */
const BUILD_SEQ = "__BUILD_SEQ__";
const ENABLED = __ENABLED__;

const CACHE_PREFIX = "bguagua-web-";
const CACHE_NAME = CACHE_PREFIX + BUILD_SEQ;

const OFFLINE_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>B瓜 · 离线</title>' +
  '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
  "background:#f5f5f5;color:#1f1c17;font:15px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}" +
  '.box{text-align:center;padding:24px}.t{font-size:16px;font-weight:600;margin-bottom:8px}' +
  '.d{font-size:13px;color:rgba(0,0,0,.55)}</style></head><body><div class="box">' +
  '<div class="t">当前处于离线状态</div>' +
  '<div class="d">已缓存的页面可以直接使用；需要联网的功能请恢复网络后重试。</div>' +
  "</div></body></html>";

if (!ENABLED) {
  // 管理端关闭 PWA：自杀式卸载并清空本应用缓存，回到普通网页
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.indexOf("bguagua-") === 0).map((k) => caches.delete(k))
        );
        try {
          await self.registration.unregister();
        } catch (e) {}
      })()
    );
  });
} else {
  self.addEventListener("install", (event) => {
    // 预缓存清单与图标（失败不影响安装）；不 skipWaiting，等待用户在横幅上确认
    event.waitUntil(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(
          ["/manifest.webmanifest", "/orig_icon.png", "/icon-192.png", "/icon-512.png"].map((u) =>
            cache.add(u).catch(() => {})
          )
        );
      })()
    );
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        // 清掉旧版本缓存，避免"新 SW 配旧资源"
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        );
        await self.clients.claim();
      })()
    );
  });

  self.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "SKIP_WAITING") {
      self.skipWaiting();
      return;
    }
    if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
      event.ports[0].postMessage({ type: "VERSION", seq: Number(BUILD_SEQ) || 0 });
    }
  });

  // 这些路径既不缓存也不拦截：API 必须实时，后台/镜像/展示页缓存会造成难以排查的问题
  const PASSTHROUGH = ["/api/", "/admin", "/moniqi", "/display", "/artifacts/", "/landing"];

  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    let url;
    try {
      url = new URL(req.url);
    } catch (e) {
      return;
    }

    // 跨域（B站 CDN / HLS / 礼物图等）一律直连，不缓存、不代理
    if (url.origin !== self.location.origin) return;
    for (let i = 0; i < PASSTHROUGH.length; i++) {
      if (url.pathname.indexOf(PASSTHROUGH[i]) === 0) return;
    }
    // RSC（客户端路由预取/导航）请求交给浏览器，缓存会破坏 App Router 的数据一致性
    if (req.headers.get("RSC") === "1") return;

    if (req.mode === "navigate") {
      event.respondWith(networkFirst(req));
      return;
    }

    if (
      url.pathname.indexOf("/_next/static/") === 0 ||
      /\\.(?:png|jpg|jpeg|webp|avif|gif|svg|ico|woff2?)$/i.test(url.pathname)
    ) {
      event.respondWith(cacheFirst(req));
    }
  });

  async function networkFirst(req) {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === "basic" && !res.redirected) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      const root = await caches.match("/");
      if (root) return root;
      return new Response(OFFLINE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  async function cacheFirst(req) {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res && res.ok && res.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }
}
`;

/**
 * 开发构建用的极简 Service Worker：
 * 只保留 fetch 事件（Chrome 判定"可安装"的必要条件之一），不做任何缓存，
 * 避免本地开发时 HMR / 热更新被旧资源干扰。
 */
const DEV_SW_TEMPLATE = `/* B瓜 dev Service Worker（不缓存） */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.indexOf("bguagua-") === 0).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: "VERSION", seq: 0 });
  }
});
self.addEventListener("fetch", () => {});
`;

export async function GET() {
  // 开发构建（本地 localhost 调试）：浏览器只有在「安全上下文 + 注册了带 fetch 处理器的
  // Service Worker」时才可能触发 beforeinstallprompt。dev 下如果不注册 SW，
  // 安卓手机上永远拿不到系统安装对话框，无法验证「添加到主屏幕」。
  // 因此 dev 版本也注册，但不缓存任何资源（避免 HMR / 热更新时命中旧 chunk）。
  if (process.env.NODE_ENV !== "production") {
    return new NextResponse(DEV_SW_TEMPLATE, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        "Service-Worker-Allowed": "/",
      },
    });
  }

  // kill switch：运维只需在服务器 .data 下创建 pwa-disable 文件（无需重启/发版）
  let enabled = true;
  try {
    await fs.access(path.join(process.cwd(), ".data", "pwa-disable"));
    enabled = false;
  } catch {
    enabled = true;
  }

  const body = SW_TEMPLATE.replace(/__BUILD_SEQ__/g, BUILD_SEQ || "0").replace(
    /__ENABLED__/g,
    enabled ? "true" : "false",
  );

  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // SW 脚本必须永不缓存，否则浏览器永远检测不到新版本
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
