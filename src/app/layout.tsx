import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PAGE_MAX_WIDTH_NUM } from "@/lib/layout";
import ExternalLinkHandler from "@/components/ExternalLinkHandler";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import ToastHost from "@/components/ToastHost";
import GlobalContextMenuBlocker from "@/components/GlobalContextMenuBlocker";
import RawRecordAutoStarter from "@/components/RawRecordAutoStarter";
import DeviceReporter from "@/components/DeviceReporter";

// 字体改用系统字体栈（不再依赖 next/font/google 构建期从 Google CDN 拉取，
// 离线/桌面 Tauri 环境更稳定）。见 globals.css 中 --font-sans/--font-mono 的定义。

/** Tauri 静态导出构建：不输出 PWA 清单（客户端不需要 Service Worker） */
const isTauriBuild = process.env.TAURI_BUILD === "1";

export const metadata: Metadata = {
  title: "B瓜 · B站直播消费数据分析工具",
  description: "B瓜 是专为 Bilibili 直播打造的个人消费数据分析工具。扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏，支持 Windows / Android / iOS 客户端使用。",
  referrer: "no-referrer",
  // Web 端：可安装 PWA（清单 + iOS 全屏/图标）；Tauri 端保持原样
  ...(isTauriBuild
    ? {}
    : {
        manifest: "/manifest.webmanifest",
        appleWebApp: {
          capable: true,
          title: "B瓜",
          statusBarStyle: "black-translucent" as const,
        },
        formatDetection: { telephone: false },
        // Next 16 只把 capable 渲染成标准 mobile-web-app-capable，
        // 而 iOS Safari 至今仍只认 apple- 前缀这一版，缺了它「添加到主屏幕」不会全屏。
        other: { "apple-mobile-web-app-capable": "yes" },
      }),
  icons: isTauriBuild
    ? {
        icon: "/orig_icon.png",
        apple: "/orig_icon.png",
      }
    : {
        icon: [
          { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
        apple: "/apple-touch-icon.png",
      },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#f5f5f5",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
        lang="zh-CN"
        className="h-full antialiased"
        suppressHydrationWarning
      >
      <body className="min-h-full flex flex-col">
        {/* iOS Web 首帧预置：必须在第一帧绘制之前给 html 打上 ios-web 类、并把根背景透明化。
            这些状态原本只由 SafeAreaStyler 在 useEffect 里设置，而 useEffect 在首帧之后才执行：
            独立 PWA 冷启动会先按「锁定外壳」渲染（html/body 锁高 + 根背景 #f5f5f5），
            底部于是先露出一条背景条，挂载后才切换成文档级滚动 + 透明背景（闪变）。
            判定条件与 SafeAreaStyler 内的 iosWeb / dockBottom 保持一致。 */}
        {!isTauriBuild && (
          <script
            dangerouslySetInnerHTML={{
              __html:
                "(function(){var ua=navigator.userAgent;" +
                "if(!/iPad|iPhone|iPod/.test(ua)||('__TAURI_INTERNALS__' in window))return;" +
                "var d=document.documentElement;" +
                "d.classList.add('ios-web');" +
                "d.style.setProperty('--background','transparent');" +
                "if(navigator.standalone===true)d.style.setProperty('--dock-bottom','24px');" +
                "})();",
            }}
          />
        )}
        {/* Web 端：尽早登记 PWA 安装事件。
            Chrome 的 beforeinstallprompt 可能在 React 挂载前就触发，晚监听会漏掉；
            这里先 preventDefault 压住浏览器自带的迷你提示，交给 PwaInstallPrompt 卡片
            在用户点击时调用 prompt() 弹出系统安装对话框。 */}
        {!isTauriBuild && (
          <script
            dangerouslySetInnerHTML={{
              __html:
                "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__bguaguaInstallPrompt=e;window.dispatchEvent(new Event('bguagua:pwa-installable'));});" +
                "window.addEventListener('appinstalled',function(){window.__bguaguaInstallPrompt=null;});",
            }}
          />
        )}
        {/* 页面最大宽度 CSS 变量：构建期由 page-config.json（单一源头）静态注入到 :root，
            随初始 HTML 一起下发，避免首帧先用 fallback 宽度渲染、再跳变为设定宽度的布局闪烁 */}
        <style
          dangerouslySetInnerHTML={{
            __html: `:root{--page-max-width:${PAGE_MAX_WIDTH_NUM}px}`,
          }}
        />
        <ExternalLinkHandler />
        <SafeAreaStyler />
        <ToastHost />
        <GlobalContextMenuBlocker />
        <RawRecordAutoStarter />
        <DeviceReporter />
        {children}
      </body>
    </html>
  );
}
