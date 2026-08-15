import type { NextConfig } from "next";

const isTauri = process.env.TAURI_BUILD === "1";
const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";

const nextConfig: NextConfig = {
  // Tauri 构建时使用静态导出，Web 部署时使用 standalone
  output: isTauri ? "export" : "standalone",
  // Tauri 构建时排除 .ts 扩展名（API routes 都是 route.ts），避免与静态导出冲突
  pageExtensions: isTauri ? ["tsx", "jsx", "js"] : undefined,
  // Turbopack 根目录（消除多 lockfile 警告）
  turbopack: { root: __dirname },
  // standalone 追踪时排除 src-tauri/target 等大目录，避免把整个 Rust 构建产物复制进 .next/standalone
  outputFileTracingExcludes: {
    "/*": ["./src-tauri/**", "./.data/**", "./.next/**"],
  },
  // 允许局域网/设备通过开发服务器 IP 访问（否则客户端 JS 不加载，页面交互失效）
  allowedDevOrigins: [
    "http://192.168.1.2:3000",
    "http://192.168.1.2",
    "192.168.1.2",
    "http://192.168.31.100:3000",
    "http://192.168.31.100",
    "192.168.31.100",
  ],
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
