/**
 * Tauri 构建脚本
 * Tauri 客户端是纯静态前端（output: export），不包含 API 路由。
 * 构建前临时移走 src/app/api 目录，构建完成后恢复，避免与静态导出冲突。
 */
import { execSync } from "child_process";
import { existsSync, renameSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const apiDir = path.join(root, "src", "app", "api");
const backupDir = path.join(root, ".api-backup");
const nextDir = path.join(root, ".next");

const moved = existsSync(apiDir);

try {
  if (moved) {
    // 移除历史备份
    if (existsSync(backupDir)) rmSync(backupDir, { recursive: true, force: true });
    renameSync(apiDir, backupDir);
    console.log("[build-tauri] 已临时移走 src/app/api");
  }

  // 清理缓存，避免类型校验器引用已移走的 API 路由
  if (existsSync(nextDir)) rmSync(nextDir, { recursive: true, force: true });

  execSync("cross-env TAURI_BUILD=1 next build", {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
} finally {
  // 无论成功失败都恢复
  if (moved && existsSync(backupDir)) {
    renameSync(backupDir, apiDir);
    console.log("[build-tauri] 已恢复 src/app/api");
  }
}