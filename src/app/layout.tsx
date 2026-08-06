import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import ExternalLinkHandler from "@/components/ExternalLinkHandler";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import ToastHost from "@/components/ToastHost";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bili Live Revenue Viewer",
  description: "Browser-first Bilibili live consumption dashboard with QR fallback login.",
  referrer: "no-referrer",
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
        className={`${spaceGrotesk.variable} ${jetBrainsMono.variable} h-full antialiased`}
        suppressHydrationWarning
      >
      <body className="min-h-full flex flex-col">
        <ExternalLinkHandler />
        <SafeAreaStyler />
        <ToastHost />
        {children}
      </body>
    </html>
  );
}
