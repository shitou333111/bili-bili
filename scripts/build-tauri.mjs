/**
 * Tauri 构建脚本
 *
 * 设置 TAURI_BUILD=1 触发 next.config.ts 中的 Tauri 专用配置：
 *   - output: "export"（静态导出）
 *   - pageExtensions: ["tsx", "jsx", "js"]（排除 .ts 即 API routes）
 *
 * 重要：Tauri 客户端需要 NEXT_PUBLIC_SERVER_URL 指向后端服务器。
 * 可通过以下方式设置：
 *   1. 环境变量：cross-env NEXT_PUBLIC_SERVER_URL=http://... npm run build:tauri
 *   2. 创建 .env.local 文件：NEXT_PUBLIC_SERVER_URL=http://...
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** 从 .env.local 或 .env 中读取环境变量 */
function readEnvFile(key) {
  const envFiles = [path.join(root, ".env.local"), path.join(root, ".env")];
  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
      if (match) return match[1].trim();
    }
  }
  return null;
}

/** 获取服务器地址 */
function getServerUrl() {
  if (process.env.NEXT_PUBLIC_SERVER_URL) return process.env.NEXT_PUBLIC_SERVER_URL;
  const fromFile = readEnvFile("NEXT_PUBLIC_SERVER_URL");
  if (fromFile) return fromFile;

  console.warn(
    "[build-tauri] ⚠️  未设置 NEXT_PUBLIC_SERVER_URL，将使用默认值 http://localhost:3000\n" +
    "   请确保后端服务器正在运行（npm run dev 或 npm start），否则客户端所有 API 请求将失败。\n" +
    "   设置方式：创建 .env.local 文件，写入 NEXT_PUBLIC_SERVER_URL=http://your-server.com",
  );
  return "http://localhost:3000";
}

const serverUrl = getServerUrl();
console.log(`[build-tauri] 服务器地址: ${serverUrl}`);
console.log("[build-tauri] 开始构建前端（output: export, 排除 API routes）...");

execSync(
  `cross-env TAURI_BUILD=1 NEXT_PUBLIC_SERVER_URL=${serverUrl} next build`,
  {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    env: {
      ...process.env,
      TAURI_BUILD: "1",
      NEXT_PUBLIC_SERVER_URL: serverUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
);

console.log("[build-tauri] 前端构建完成");