import type { Metadata, Viewport } from "next";
import "./globals.css";
import ExternalLinkHandler from "@/components/ExternalLinkHandler";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import ToastHost from "@/components/ToastHost";
import GlobalContextMenuBlocker from "@/components/GlobalContextMenuBlocker";

// 字体改用系统字体栈（不再依赖 next/font/google 构建期从 Google CDN 拉取，
// 离线/桌面 Tauri 环境更稳定）。见 globals.css 中 --font-sans/--font-mono 的定义。

export const metadata: Metadata = {
  title: "Bili Live Revenue Viewer",
  description: "Browser-first Bilibili live consumption dashboard with QR fallback login.",
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
        <ExternalLinkHandler />
        <SafeAreaStyler />
        <ToastHost />
        <GlobalContextMenuBlocker />
        {children}
      </body>
    </html>
  );
}
