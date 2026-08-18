/**
 * 统一更新模块
 *
 * 两层更新策略：
 * 1. 热更新（前端资源 OTA）：tauri-plugin-hot-update，三平台通用，
 *    仅更新 JS/CSS/HTML，下次冷启动生效，支持自动回滚防砖。
 * 2. 原生包更新：替换整个安装包
 *    - Windows: tauri-plugin-updater 官方插件（下载+安装+自动重启）
 *    - Android: 自定义命令 download_and_install_apk（下载 APK + 触发系统安装器）
 *    - iOS: 自定义命令 download_and_open_ipa（下载 IPA + Open In 面板交自签工具）
 *
 * 版本显示格式：V1.0.0 (2026-08-18)
 *   - V1.0.0：原生版本号（来自 tauri.conf.json 的 version，仅原生更新会变）
 *   - 2026-08-18：前端构建日期（来自 NEXT_PUBLIC_BUILD_DATE，热更新会变）
 */

import { isTauri, serverFetch, serverApiUrl } from "./server-api";

/** 构建日期（CI 注入，本地开发取当前日期） */
const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || "开发版";

/** 服务器基础地址（用于拉取 versions.json） */
const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://192.168.1.2:3000";

export type UpdateType = "hot" | "native" | "none";

export interface HotUpdateInfo {
  available: boolean;
  version?: string;
  error?: string;
  /** shellTooOld = 热更新有新版本但原生版本太低，需要先装原生更新 */
  shellTooOld?: boolean;
  /** alreadyStaged = 热更新已下载暂存，下次冷启动生效 */
  alreadyStaged?: boolean;
}

export interface NativeUpdateInfo {
  available: boolean;
  currentVersion: string;
  serverVersion?: string;
  date?: string;
  downloadUrl?: string;
  error?: string;
  /** checkFailed = 检查本身失败（网络/CORS/JSON 解析等），与"无更新"区分 */
  checkFailed?: boolean;
}

export interface UpdateCheckResult {
  /** 热更新（前端资源 OTA） */
  hot: HotUpdateInfo;
  /** 原生包更新 */
  native: NativeUpdateInfo;
  /** 推荐的更新类型（热更新优先，无热更新再看原生） */
  recommended: UpdateType;
}

export interface VersionDisplay {
  /** "V1.0.0 (2026-08-18)" 格式 */
  full: string;
  /** 原生版本号 "1.0.0" */
  native: string;
  /** 构建日期 "2026-08-18" */
  date: string;
}

/** versions.json 结构（由 CI publish-artifacts 生成） */
interface VersionsJson {
  version?: string;
  windows?: string;
  android?: string;
  ios?: string;
  macos?: string;
  linux?: string;
  downloads?: {
    windows?: string;
    android?: string;
    ios?: string;
    macos?: string;
    linux?: string;
  };
}

/** 检测当前平台 */
export function detectPlatform(): "windows" | "android" | "ios" | "macos" | "linux" | "web" {
  if (!isTauri()) return "web";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    if (/android/i.test(ua)) return "android";
    if (/iphone|ipad|ipod/i.test(ua)) return "ios";
    if (/win/i.test(ua)) return "windows";
    if (/mac/i.test(ua)) return "macos";
    if (/linux/i.test(ua)) return "linux";
  }
  return "web";
}

/** 是否桌面端（用 tauri-plugin-updater） */
export function isDesktop(): boolean {
  const p = detectPlatform();
  return p === "windows" || p === "macos" || p === "linux";
}

/**
 * 获取版本显示信息
 * - Tauri 环境：V1.0.0 (2026-08-18)
 * - Web 开发：开发版
 */
export async function getVersionDisplay(): Promise<VersionDisplay> {
  if (!isTauri()) {
    return { full: "开发版", native: "0.0.0", date: BUILD_DATE };
  }
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const native = await getVersion();
    const date = BUILD_DATE;
    return {
      full: `V${native} (${date})`,
      native,
      date,
    };
  } catch {
    return { full: `V0.0.0 (${BUILD_DATE})`, native: "0.0.0", date: BUILD_DATE };
  }
}

/**
 * 检查更新（热更新 + 原生更新并行）
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isTauri()) {
    return {
      hot: { available: false },
      native: { available: false, currentVersion: "0.0.0" },
      recommended: "none",
    };
  }

  const [hot, native] = await Promise.all([
    checkHotUpdate(),
    checkNativeUpdate(),
  ]);

  // 推荐优先级：原生更新 > 热更新
  // 理由：原生更新涉及 Rust/配置/权限等核心变更，是热更新的"底座"。
  // 如果跳过原生更新直接应用热更新，前端代码可能调用了旧原生包里没有的
  // 命令/插件，导致功能异常或白屏。
  let recommended: UpdateType = "none";
  if (native.available) {
    recommended = "native";
  } else if (hot.available) {
    recommended = "hot";
  }
  // shellTooOld 场景：热更新有新版本但用户原生版本太低（不满足 --min-shell）。
  // 此时不推荐热更新，推荐逻辑保持 native（如果同时有原生更新）或 none。
  // hot.shellTooOld 标记会在 UI 上单独提示用户"先更新原生包"。

  return { hot, native, recommended };
}

/** 检查热更新（tauri-plugin-hot-update） */
async function checkHotUpdate(): Promise<HotUpdateInfo> {
  try {
    const { check } = await import("tauri-plugin-hot-update-api");
    const outcome = await check();
    // status: available | upToDate | blacklisted | shellTooOld | alreadyStaged
    // 注意：CheckOutcome 在 "available" 分支下 version 嵌套在 manifest.version，
    // 不是直接挂在 outcome 上；其他分支可能都没有 version 字段。
    // 用 any 做兜底安全访问，避免类型不匹配导致构建报错。
    const o = outcome as any;
    const version: string | undefined = o?.manifest?.version || o?.version;
    const shellTooOld = outcome.status === "shellTooOld";
    const alreadyStaged = outcome.status === "alreadyStaged";
    return {
      // alreadyStaged 也算"可更新"（只是下载过了），UI 会提示"重启即生效"
      available: outcome.status === "available" || alreadyStaged,
      version,
      shellTooOld,
      alreadyStaged,
    };
  } catch (e: any) {
    // 插件未启用（enabled:false 暗部署）或非 OTA bundle 时会返回 upToDate / 抛错
    return { available: false, error: String(e?.message || e) };
  }
}

/** 检查原生更新（拉取 versions.json 比对本地版本号） */
async function checkNativeUpdate(): Promise<NativeUpdateInfo> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const currentVersion = await getVersion();

    const versions = await serverFetch<VersionsJson>("/artifacts/versions.json", {
      cache: "no-store",
    });

    const platform = detectPlatform();
    const platformKey = (platform === "web" ? "windows" : platform) as keyof VersionsJson;
    const serverVersion = versions.version || "";
    const date = (versions as Record<string, any>)[platform] as string || "";
    const downloadUrlRaw = (versions.downloads as Record<string, string | undefined> | undefined)?.[platformKey] || "";
    // Rust reqwest 需绝对 URL，相对路径用 serverApiUrl 补全服务器地址
    const downloadUrl = downloadUrlRaw.startsWith("http")
      ? downloadUrlRaw
      : serverApiUrl(downloadUrlRaw);

    const hasUpdate = !!serverVersion && serverVersion !== currentVersion;

    return {
      available: hasUpdate,
      currentVersion,
      serverVersion,
      date,
      downloadUrl,
    };
  } catch (e: any) {
    // 区分"检查失败"（网络/CORS/JSON 解析等）与"无更新"。
    // shellTooOld 场景下，如果原生检查也失败，用户会陷入死循环：
    //   - 想装原生 → 卡片没按钮
    //   - 想装热更新 → 被提示先装原生
    // 所以 checkFailed 用于 UI 显示"原生检查失败，请稍后重试"，
    // 不引导用户去装不存在的原生更新。
    return {
      available: false,
      currentVersion: "0.0.0",
      error: String(e?.message || e),
      checkFailed: true,
    };
  }
}

export type DownloadProgress = { downloaded: number; total: number };
export type ProgressCb = (p: DownloadProgress) => void;

/** 热更新下载结果 */
export interface HotUpdateApplyResult {
  /** staged = 已暂存，下次冷启动生效；upToDate = 无需更新；alreadyStaged = 已暂存过 */
  status: "staged" | "upToDate" | "alreadyStaged" | "blacklisted" | "shellTooOld" | "error";
  version?: string;
  error?: string;
}

/**
 * 应用热更新（下载 + 验证 + stage，下次冷启动生效）
 * 进度回调通过 tauri-plugin-hot-update-api 的 onDownloadProgress 事件
 */
export async function applyHotUpdate(onProgress?: ProgressCb): Promise<HotUpdateApplyResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };
  try {
    const { download, onDownloadProgress } = await import("tauri-plugin-hot-update-api");
    let unlisten: (() => void) | null = null;
    if (onProgress) {
      unlisten = await onDownloadProgress((p) => onProgress(p));
    }
    try {
      const outcome = await download();
      // DownloadOutcome 的 version 可能在 outcome.manifest.version 或 outcome.version，
      // 用 any 做兜底安全访问，避免类型不匹配。
      const o = outcome as any;
      const version: string | undefined = o?.manifest?.version || o?.version;
      return {
        status: outcome.status as HotUpdateApplyResult["status"],
        version,
      };
    } finally {
      unlisten?.();
    }
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/** 原生更新应用结果 */
export interface NativeUpdateApplyResult {
  /**
   * installing: 正在安装（Windows updater 自动安装+重启；Android 系统安装器已弹出）
   * openIn: 已触发 Open In 面板（iOS，用户需选自签工具覆盖安装）
   * needRestart: 下载完成需手动重启（保留位，当前未使用）
   * error: 失败
   */
  status: "installing" | "openIn" | "needRestart" | "error";
  error?: string;
}

/**
 * 应用原生更新（平台特定）
 * - Windows: tauri-plugin-updater 下载+安装+自动重启
 * - Android: download_and_install_apk 命令（下载 APK + 触发系统安装器）
 * - iOS: download_and_open_ipa 命令（下载 IPA + 触发 Open In 面板）
 */
export async function applyNativeUpdate(
  downloadUrl: string,
  onProgress?: ProgressCb,
): Promise<NativeUpdateApplyResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };
  if (!downloadUrl) return { status: "error", error: "缺少下载地址" };

  const platform = detectPlatform();
  if (platform === "windows" || platform === "macos" || platform === "linux") {
    return applyDesktopUpdate(onProgress);
  }
  if (platform === "android") {
    return applyAndroidUpdate(downloadUrl);
  }
  if (platform === "ios") {
    return applyIosUpdate(downloadUrl);
  }
  return { status: "error", error: `不支持的平台: ${platform}` };
}

/**
 * 桌面端（Windows/macOS/Linux）：用官方 tauri-plugin-updater
 * 从 updater endpoints（tauri.conf.json 配置的 latest.json）拉取更新信息，
 * 自动下载 + 安装 + 重启。
 */
async function applyDesktopUpdate(onProgress?: ProgressCb): Promise<NativeUpdateApplyResult> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { status: "error", error: "无可用更新" };

    let total = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength || 0;
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress?.({ downloaded, total });
          break;
        case "Finished":
          break;
      }
    });

    // updater 插件安装完成后自动调用 relaunch（需 tauri-plugin-process）
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch {
      // process 插件不可用时，提示用户手动重启
      return { status: "needRestart" };
    }
    return { status: "installing" };
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/** Android：调用 download_and_install_apk 命令 */
async function applyAndroidUpdate(url: string): Promise<NativeUpdateApplyResult> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("download_and_install_apk", { url });
    // 命令返回 OK 后系统安装器已弹出，用户确认覆盖安装
    return { status: "installing" };
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/** iOS：下载 IPA + 触发 Open In 面板 */
async function applyIosUpdate(url: string): Promise<NativeUpdateApplyResult> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const ipaPath = await invoke<string>("download_and_open_ipa", { url });
    // 触发系统 "Open In" 面板，用户选择 Esign/Feather 等自签工具覆盖安装。
    // 注意：plugin-opener 的导出是 openPath（文件路径）与 openUrl（URL），不是 open。
    // openPath(ipaPath) 不传第二个 openWith 参数 → 系统弹 "Open With" 面板。
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(ipaPath);
    return { status: "openIn" };
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/**
 * 通知热更新插件：当前 bundle 已成功启动
 * 每次 APP 冷启动后调用一次（在 app shell 挂载后即可）。
 * 如果当前运行的是 OTA bundle 而未调用此方法，下次启动会自动回滚到上一个好 bundle。
 * 非 OTA bundle 或插件未启用时为 no-op，可无条件调用。
 */
export async function notifyAppReady(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { notifyAppReady: notify } = await import("tauri-plugin-hot-update-api");
    await notify();
  } catch {
    // 静默失败：插件未启用或非 OTA bundle 时为 no-op
  }
}

/**
 * 重置热更新状态（调试/支持用）
 * 清空所有 OTA 状态，下次启动回退到编译时内嵌的资源
 */
export async function resetHotUpdate(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { reset } = await import("tauri-plugin-hot-update-api");
    await reset();
  } catch {
    // 静默失败
  }
}

/**
 * 查询当前运行的 bundle 信息
 * 返回 { source: "ota" | "embedded", seq, version }
 */
export async function currentBundle(): Promise<{
  source: "ota" | "embedded";
  seq: number;
  version?: string;
} | null> {
  if (!isTauri()) return null;
  try {
    const { currentBundle: query } = await import("tauri-plugin-hot-update-api");
    const result = await query();
    // CurrentBundle 实际类型（source/seq/version 命名/值）可能与接口声明有细微差异，
    // 做一次结构化兜底后再返回，避免构建期类型不匹配。
    const r = result as any;
    if (!r) return null;
    return {
      source: r.source as "ota" | "embedded",
      seq: Number(r.seq) || 0,
      version: typeof r.version === "string" ? r.version : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 重启 APP（热更新暂存后调用，使新 bundle 在下次冷启动生效）
 * - 桌面端：用 @tauri-apps/plugin-process 的 relaunch() 真正退出并重启进程
 * - 移动端：无等价 API，返回 false 提示用户手动关闭再打开
 */
export async function restartApp(): Promise<boolean> {
  if (!isTauri()) return false;
  if (isDesktop()) {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return true;
    } catch {
      return false;
    }
  }
  // 移动端：热更新在下次冷启动生效，需用户手动关闭再打开 APP
  return false;
}
