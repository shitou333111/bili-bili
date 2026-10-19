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

export const metadata: Metadata = {
  title: "B瓜 · B站直播消费数据分析工具",
  description: "B瓜 是专为 Bilibili 直播打造的个人消费数据分析工具。扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏，支持 Windows / Android / iOS 客户端使用。",
  referrer: "no-referrer",
  icons: {
    icon: "/orig_icon.png",
    apple: "/orig_icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
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
