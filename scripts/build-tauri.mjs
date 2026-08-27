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
    "[build-tauri] ⚠️  未设置 NEXT_PUBLIC_SERVER_URL，将使用默认值 http://192.168.1.2:3000\n" +
    "   请确保后端服务器正在运行（npm run dev 或 npm start），否则客户端所有 API 请求将失败。\n" +
    "   设置方式：创建 .env.local 文件，写入 NEXT_PUBLIC_SERVER_URL=http://your-server.com",
  );
  return "http://192.168.1.2:3000";
}

const serverUrl = getServerUrl();
console.log(`[build-tauri] 服务器地址: ${serverUrl}`);

// 内置热更新 sequence：CI 由 workflow 注入（= github.run_number，与热更新包同 sequence）。
// 原生包内置该值为"已含最新内容"的水位线：热更新检查时若服务器 sequence ≤ 此值则视为
// 已内建、不提示（修复"刚装原生包仍误报热更新"）。本地开发未注入 → 0（不抑制）。
const buildSeq = Number(process.env.NEXT_PUBLIC_BUILD_SEQ) || 0;
console.log(`[build-tauri] 内置热更新 sequence: ${buildSeq}${buildSeq > 0 ? "" : " （未注入，不抑制热更新误报）"}`);

// 构建日期：CI 环境由 workflow 传入；本地开发取当前日期（东八区）
const buildDate = process.env.NEXT_PUBLIC_BUILD_DATE
  || (() => {
    const now = new Date();
    // 东八区 (Asia/Shanghai) 日期：避免 CI 服务器 UTC 时区导致日期偏移一天
    const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
    return shanghai.toISOString().slice(0, 10);
  })();
console.log(`[build-tauri] 构建日期: ${buildDate}`);

// 确保 FoamTree 补丁已应用（CI 环境 npm ci 可能不执行 postinstall）
console.log("[build-tauri] 应用 FoamTree 补丁...");
execSync("node scripts/patch-foamtree.mjs", { stdio: "inherit", cwd: root });

console.log("[build-tauri] 开始构建前端（output: export, 排除 API routes）...");

execSync(
  `cross-env TAURI_BUILD=1 NEXT_PUBLIC_SERVER_URL=${serverUrl} NEXT_PUBLIC_BUILD_DATE=${buildDate} NEXT_PUBLIC_IS_TAURI_PROD=1 NEXT_PUBLIC_BUILD_SEQ=${buildSeq} next build`,
  {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    env: {
      ...process.env,
      TAURI_BUILD: "1",
      NEXT_PUBLIC_SERVER_URL: serverUrl,
      NEXT_PUBLIC_BUILD_DATE: buildDate,
      NEXT_PUBLIC_IS_TAURI_PROD: "1",
      NEXT_PUBLIC_BUILD_SEQ: String(buildSeq),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
);

console.log("[build-tauri] 前端构建完成");