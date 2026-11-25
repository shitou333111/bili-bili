/**
 * 构建本地音乐解析服务（Go）
 *
 * 产物：
 *   .tools/music-service/music-service.exe          （Windows）
 *   .tools/music-service/music-service-linux-amd64  （Linux 交叉编译）
 *
 * 单独运行：node scripts/build-music-service.mjs
 *
 * 若 .tools/go 不存在，会下载官方 Windows amd64 便携版 Go 并解压到 .tools/go，
 * 不会修改系统 PATH。
 */
import { spawnSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { once } from "events";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const toolsDir = path.join(root, ".tools");
const goDir = path.join(toolsDir, "go");
const goExe = path.join(goDir, "bin", process.platform === "win32" ? "go.exe" : "go");
const serviceDir = path.join(root, "music-service");
const outDir = path.join(toolsDir, "music-service");

const GO_VERSION_JSON = "https://go.dev/dl/?mode=json";

function log(msg) {
  console.log(`[build-music-service] ${msg}`);
}

function fail(msg) {
  console.error(`\n[build-music-service] ❌ ${msg}\n`);
  process.exit(1);
}

function runGo(args, extraEnv = {}) {
  const env = {
    ...process.env,
    GOPROXY: process.env.GOPROXY || "https://goproxy.cn,direct",
    GOFLAGS: process.env.GOFLAGS || "-mod=mod",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    ...extraEnv,
  };
  log(`go ${args.join(" ")}${extraEnv.GOOS ? ` (GOOS=${extraEnv.GOOS})` : ""}`);
  const res = spawnSync(goExe, args, { cwd: serviceDir, env, stdio: "inherit" });
  if (res.error) fail(`无法执行 go：${res.error.message}`);
  if (res.status !== 0) fail(`命令失败（exit ${res.status}）：go ${args.join(" ")}`);
}

async function downloadFile(url, dest) {
  log(`下载 ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  let lastReport = 0;
  const file = createWriteStream(dest);
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!file.write(value)) await once(file, "drain");
      if (total && received - lastReport > 16 * 1024 * 1024) {
        lastReport = received;
        log(`  已下载 ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
      }
    }
  } finally {
    file.end();
    await once(file, "close");
  }
  if (total && received < total) {
    throw new Error(`下载不完整：收到 ${received} 字节，期望 ${total} 字节`);
  }
  return dest;
}

function extractZip(zipPath, destDir) {
  log(`解压 ${path.basename(zipPath)} -> ${destDir}`);
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: "inherit" },
  );
  if (res.error) throw new Error(`调用 PowerShell 解压失败：${res.error.message}`);
  if (res.status !== 0) throw new Error(`Expand-Archive 失败（exit ${res.status}）`);
}

async function ensureGo() {
  if (existsSync(goExe)) {
    log(`使用已存在的 Go：${path.relative(root, goExe)}`);
    return;
  }
  if (process.platform !== "win32") {
    fail(`未找到 Go，且当前仅支持自动下载 Windows 便携版（当前平台：${process.platform}）`);
  }

  log("未找到 .tools/go，开始下载便携版 Go…");
  let release;
  try {
    const res = await fetch(GO_VERSION_JSON, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    release = await res.json();
  } catch (err) {
    fail(`获取 Go 版本信息失败：${err.message}`);
  }

  const latest = release?.[0];
  const file = latest?.files?.find(
    (f) => f.os === "windows" && f.arch === "amd64" && f.kind === "archive",
  );
  if (!latest?.version || !file?.filename) {
    fail("无法从 go.dev/dl/?mode=json 解析出 Windows amd64 安装包信息");
  }

  mkdirSync(toolsDir, { recursive: true });
  const zipPath = path.join(toolsDir, file.filename);
  if (!existsSync(zipPath) || statSync(zipPath).size !== file.size) {
    try {
      await downloadFile(`https://dl.google.com/go/${file.filename}`, zipPath);
    } catch (err) {
      fail(`下载 Go 失败：${err.message}`);
    }
  } else {
    log(`复用已下载的 ${file.filename}`);
  }

  try {
    extractZip(zipPath, toolsDir);
  } catch (err) {
    fail(err.message);
  }
  if (!existsSync(goExe)) fail(`解压后仍未找到 ${path.relative(root, goExe)}`);
  try {
    rmSync(zipPath, { force: true });
  } catch {
    // 清理失败不影响构建
  }
  log(`Go 已就绪：${latest.version}`);
}

async function main() {
  if (!existsSync(path.join(serviceDir, "go.mod"))) {
    fail(`未找到 ${path.relative(root, path.join(serviceDir, "go.mod"))}`);
  }

  await ensureGo();

  const version = spawnSync(goExe, ["version"], { encoding: "utf8" });
  if (version.status !== 0) fail(`Go 不可用：${version.stderr || version.stdout || "未知错误"}`);
  log(version.stdout.trim());

  mkdirSync(outDir, { recursive: true });

  runGo(["mod", "tidy"]);
  runGo(["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, "music-service.exe"), "."], {
    GOOS: "windows",
    GOARCH: "amd64",
  });
  runGo(
    ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(outDir, "music-service-linux-amd64"), "."],
    { GOOS: "linux", GOARCH: "amd64" },
  );

  for (const name of ["music-service.exe", "music-service-linux-amd64"]) {
    const p = path.join(outDir, name);
    if (!existsSync(p)) fail(`构建产物缺失：${path.relative(root, p)}`);
    log(`✅ ${path.relative(root, p)} (${(statSync(p).size / 1024 / 1024).toFixed(2)} MB)`);
  }
  log("构建完成");
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
