import type { NextConfig } from "next";

const isTauri = process.env.TAURI_BUILD === "1";
const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";

const nextConfig: NextConfig = {
  // Tauri 构建时使用静态导出，Web 部署时使用 standalone
  output: isTauri ? "export" : "standalone",
  allowedDevOrigins: ["http://192.168.1.2:3000", "http://192.168.1.2", "192.168.1.2"],
  // 静态导出需要禁用图片优化
  images: isTauri ? { unoptimized: true } : undefined,
  // 开发模式下需要配置 assetPrefix 以支持 Tauri 加载资源
  assetPrefix: isTauri && !isProd ? `http://${internalHost}:3000` : undefined,
  // 服务器端环境变量（Tauri 客户端通过 platform 层获取）
  env: {
    NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL || "",
  },
};

export default nextConfig;
