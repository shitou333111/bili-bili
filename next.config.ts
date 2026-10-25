import type { NextConfig } from "next";
import tauriConf from "./src-tauri/tauri.conf.json";

/**
 * 应用版本号（单一来源 = src-tauri/tauri.conf.json）。
 * Web 端没有原生包，但版本显示要与客户端统一为 V{版本}-{日期}，
 * 因此直接沿用客户端原生版本号。这里用静态 JSON import（构建期求值并内联），
 * 不读文件系统——否则 Next 的产物追踪会误把整个项目打进 standalone。
 */
const appVersion =
  process.env.NEXT_PUBLIC_APP_VERSION ||
  (typeof tauriConf?.version === "string" ? tauriConf.version : "");


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
  // 本地开发默认使用 localhost，避免切换网络环境后 IP 变化导致页面/API 请求失败。
  allowedDevOrigins: [
    "http://localhost:3000",
    "http://localhost",
    "localhost",
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
  // 上传大文件（如 pay-records.json 可超 10MB）：提高 proxy 对请求体的缓冲上限，
  // 否则 "Request body exceeded 10MB" 截断导致 formData/JSON 解析失败。
  // 密文为 Base64（比明文大 ~33%），需留足余量。
  experimental: {
    proxyClientMaxBodySize: "100mb",
  },
  // 构建期环境变量（Tauri 客户端通过 platform 层获取）
  // 必须在这里显式映射：next.config 的 env 会在构建时把值内联进产物，
  // 而服务端（standalone server.js）运行时拿不到 CI 的环境变量。
  // PWA 的 /sw.js 与 /api/pwa/version 需要读取构建序号来标识版本，因此必须内联。
  env: {
    NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL || "",
    NEXT_PUBLIC_BUILD_SEQ: process.env.NEXT_PUBLIC_BUILD_SEQ || "",
    NEXT_PUBLIC_BUILD_DATE: process.env.NEXT_PUBLIC_BUILD_DATE || "",
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
};

export default nextConfig;
