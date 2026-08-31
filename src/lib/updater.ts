/**
 * 统一更新模块
 *
 * 两层更新策略：
 * 1. 热更新（前端资源 OTA）：tauri-plugin-hotswap，三平台通用，
 *    仅更新 JS/CSS/HTML。运行时替换 asset provider，apply/activate 后
 *    window.location.reload() 立即生效（无需重启进程，iOS/Android 也可用中更新）。
 * 2. 原生包更新：替换整个安装包
 *    - Windows: 自定义命令 download_exe 静默下载新版本 + apply_in_place_update 原地替换
 *      （绿色单文件免安装方案的持久化更新；官方 updater 只支持 NSIS/MSI，裸 exe 更新会"假成功"）
 *    - Android: 自定义命令 download_apk 下载 APK + tauri-plugin-android-installer 安装
 *    - iOS: 自定义命令 download_ipa + Open In 面板（交自签工具覆盖安装）
 *
 * 版本显示格式：V1.4.0-20260816
 *   - V1.4.0：原生版本号（来自 tauri.conf.json 的 version，仅原生更新会变，完整三位显示，不裁剪）
 *   - 20260816：前端构建日期（来自 NEXT_PUBLIC_BUILD_DATE，热更新会变，紧凑 8 位）
 *
 * 热更新 UX（与原生更新统一）：
 *   - 冷启动：首页渲染前自动检查 + 一步下载并应用（applyUpdate）→ reload 立即生效（无需重启进程）
 *   - 应用内：更新卡片按状态显示"点击刷新/点击重装"，一键应用
 *   - 防砖：每次启动 notifyReady() 确认当前版本可用，未确认则下次启动自动回滚
 */

import { isTauri, isTauriProduction, serverFetch, serverApiUrl } from "./server-api";

/** 构建日期（CI 注入，本地开发取当前日期） */
const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || "开发版";

/**
 * 内置前端资源对应的热更新序号（sequence）。
 * CI 构建时注入（NEXT_PUBLIC_BUILD_SEQ = github.run_number，与热更新包同一 SEQUENCE）。
 * 原生包内置资源 = 该 sequence 对应的源码，服务器 sequence 不高于此值即视为"已含最新内容"。
 * 用于修复：hotswap 插件本地无热更新缓存时 current_sequence=0，只要服务器发布过
 * 任何热更新就会误报（新装/刚更新的原生包必然中招，所有平台一致）。
 * 本地开发无注入 → 0（不抑制任何热更新，仅 dev 场景，无影响）。
 * 说明：热更新识别仅依赖 sequence > 当前原生包内置 run_number，与前端内容是否变化无关——
 * 因此"仅注释/无实质改动"的提交（keyword=hot）同样会产出更高序列，供热更新链路联调验证。
 */
const BUILTIN_HOTSWAP_SEQUENCE = Number(process.env.NEXT_PUBLIC_BUILD_SEQ) || 0;

/** 服务器基础地址（用于拉取 versions.json） */
const SERVER_BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:3000";

export type UpdateType = "hot" | "native" | "none";

export interface HotUpdateInfo {
  available: boolean;
  version?: string;
  /** 热更新单调递增序号（hotswap 的唯一排序依据） */
  sequence?: number;
  error?: string;
  /** shellTooOld = 热更新有新版本但原生版本太低（min_binary_version 不满足），需要先装原生更新 */
  shellTooOld?: boolean;
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
  /** 每平台版本号（未构建平台无此键，随旧包保留旧版本） */
  version?: Record<string, string>;
  windows?: string;
  android?: string;
  ios?: string;
  downloads?: {
    windows?: string;
    android?: string;
    ios?: string;
  };
}

/** 检测当前平台（仅支持 Windows / Android / iOS / Web） */
export function detectPlatform(): "windows" | "android" | "ios" | "web" {
  if (!isTauri()) return "web";
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || "";
    if (/android/i.test(ua)) return "android";
    if (/iphone|ipad|ipod/i.test(ua)) return "ios";
    if (/win/i.test(ua)) return "windows";
  }
  return "web";
}

/**
 * 构建日期紧凑显示："20260816-123456" → "20260816"、"2026-08-16" → "20260816"。
 * 无日期信息时原样返回。
 */
export function compactBuildDate(d: string): string {
  const m = d.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  return m ? `${m[1]}${m[2]}${m[3]}` : d;
}

/**
 * 热更新版本显示格式化（与原生版本格式统一："V1.3.4-20260819"）。
 * 热更新 manifest.version 是 semver 预发布号（version 仅显示用，排序看 sequence）：
 *   - 新格式 1.3.4-20260819.123456 → "V1.3.4-20260819"
 *   - 旧格式 1.3.4-ota.75（历史包）→ 退化为 "V1.3.4"
 */
export function formatHotUpdateVersion(v: string): string {
  const m = v.match(/^(\d+\.\d+\.\d+)-(\d{4})(\d{2})(\d{2})(?:\.|$)/);
  if (m) return `V${m[1]}-${m[2]}${m[3]}${m[4]}`;
  const base = v.split("-")[0];
  return base ? `V${base}` : "";
}

/**
 * 获取版本显示信息
 * - Tauri 环境：V1.4.0-20260816（完整三位版本号 + 紧凑日期，无括号）
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
      full: `V${native}-${compactBuildDate(date)}`,
      native,
      date,
    };
  } catch {
    return {
      full: `V0.0.0-${compactBuildDate(BUILD_DATE)}`,
      native: "0.0.0",
      date: BUILD_DATE,
    };
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

  // Tauri 开发模式（tauri dev，走 Next dev server）：不执行更新检查。
  // dev server 上没有生产 Nginx 托管的 /artifacts/（versions.json / hotswap.json），
  // 请求会 404 返回 HTML 页 → JSON.parse 失败 → 误报"原生更新检查失败"。
  // 更新检查仅对生产构建有意义，dev 直接返回"无更新"，UI 显示"已是最新"。
  if (!isTauriProduction()) {
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

/** 简单 semver 比较（忽略 prerelease/build 段），返回 a < b */
function isVersionLt(a: string, b: string): boolean {
  const pa = (a.split("-")[0] || a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = (b.split("-")[0] || b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** 检查热更新（tauri-plugin-hotswap） */
async function checkHotUpdate(): Promise<HotUpdateInfo> {
  try {
    const { checkUpdate } = await import("tauri-plugin-hotswap-api");
    const result = await checkUpdate();
    // checkUpdate() 内部已做两道门（见插件 updater.rs check_update）：
    //   1. min_binary_version 门：当前原生版本 < manifest.min_binary_version → 跳过（available=false，不暴露原因）
    //   2. sequence 门：manifest.sequence <= 当前 sequence → 无更新
    // 因此 shellTooOld 无法从 checkUpdate 直接判断，需自己拉 hotswap.json
    // 比对 min_binary_version 与当前原生版本。

    // 内置资源抑制门：原生包与热更新包在 CI 同一次 run 构建、sequence 相同
    // （NEXT_PUBLIC_BUILD_SEQ = run_number = 热更新 manifest 的 sequence）。
    // 插件本地无缓存时 current_sequence=0，只要服务器发布过热更新就误报"有更新"；
    // 服务器 sequence 不高于本次内置 sequence → 原生包已内建该内容，视为无更新。
    let available = result.available;
    if (
      available &&
      typeof result.sequence === "number" &&
      BUILTIN_HOTSWAP_SEQUENCE > 0 &&
      result.sequence <= BUILTIN_HOTSWAP_SEQUENCE
    ) {
      available = false;
    }

    let shellTooOld = false;
    let version: string | undefined = result.version || undefined;
    if (!available) {
      try {
        const manifest = await serverFetch<{
          version?: string;
          min_binary_version?: string;
        }>("/artifacts/webapp/hotswap.json", { cache: "no-store" });
        const { getVersion } = await import("@tauri-apps/api/app");
        const native = await getVersion();
        const min = manifest?.min_binary_version;
        if (min && native && isVersionLt(native, min)) {
          shellTooOld = true;
          version = manifest.version || undefined;
        }
      } catch {
        // 拉不到 hotswap.json 就当作无更新
      }
    }
    return {
      available,
      version,
      sequence: result.sequence || undefined,
      shellTooOld,
    };
  } catch (e: any) {
    // 网络失败 / 插件未启用等：返回错误，与"无更新"区分
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
    // 版本号按平台独立：某平台未构建时取不到新版本 → 不误报更新（与它实际安装包一致）
    const serverVersion = versions.version?.[platformKey] || "";
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

/** 热更新应用结果（hotswap：apply = 下载+校验+激活一步） */
export interface HotUpdateApplyResult {
  /** applied = 已下载+激活，reload 即生效；error = 失败 */
  status: "applied" | "error";
  version?: string;
  error?: string;
}

/**
 * 应用热更新（下载 + 验证 + 激活一步，hotswap applyUpdate）
 * 激活后 asset provider 已切换，window.location.reload() 立即生效（无需重启进程）。
 * 进度回调通过 tauri-plugin-hotswap-api 的 onDownloadProgress 事件
 */
export async function applyHotUpdate(onProgress?: ProgressCb): Promise<HotUpdateApplyResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };
  try {
    const { applyUpdate, onDownloadProgress } = await import("tauri-plugin-hotswap-api");
    let unlisten: (() => void) | null = null;
    if (onProgress) {
      unlisten = await onDownloadProgress((p) =>
        onProgress({ downloaded: p.downloaded, total: p.total || 0 }),
      );
    }
    try {
      const version = await applyUpdate();
      return { status: "applied", version };
    } finally {
      unlisten?.();
    }
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/** 原生更新静默下载结果 */
export interface NativeDownloadResult {
  status: "downloaded" | "downloading" | "error";
  /** 本地文件路径 */
  filePath?: string;
  /** 当前平台 */
  platform?: "windows" | "android" | "ios";
  error?: string;
}

/** 原生更新应用结果 */
export interface NativeUpdateApplyResult {
  /**
   * installing: 正在安装（Windows 原地替换自动重启；Android 系统安装器已弹出）
   * openIn: 已触发 Open In 面板（iOS，用户需选自签工具覆盖安装）
   * cancelled: 用户取消了分享面板（iOS，非错误）
   * error: 失败
   */
  status: "installing" | "openIn" | "cancelled" | "error";
  error?: string;
}

/**
 * 静默下载原生更新安装包（统一体验：先后台下，再点按钮安装）
 * - Windows: 自定义 download_exe 后台静默下载新版本 exe 到当前文件夹（应用目录，版本化命名复用）
 * - Android: 后台静默下载 APK 到 cache，返回路径
 * - iOS: 后台静默下载 IPA 到 cache，返回路径
 * @param version 服务端版本号（用于版本化缓存：同版本已下载过则复用本地缓存，避免重复下载）
 * @param onProgress 进度回调（大文件下载时显示百分比）
 */
export async function downloadNativeSilently(
  downloadUrl: string,
  onProgress?: ProgressCb,
  version?: string,
): Promise<NativeDownloadResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };
  if (!downloadUrl) return { status: "error", error: "缺少下载地址" };

  const platform = detectPlatform();
  if (platform === "windows") {
    // Windows：自定义原地替换更新。后台静默下载新版本 exe（版本化命名，同版本复用），
    // 点击安装时交给 apply_in_place_update 原地替换并重启。
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      const path = await invoke<string>("download_exe", { url: downloadUrl, version });
      return { status: "downloaded", filePath: path, platform: "windows" };
    } catch (e: any) {
      return { status: "error", error: String(e?.message || e) };
    }
  }

  const { invoke } = await import("@tauri-apps/api/core");
  try {
    // Android/iOS：静默下载
    let total = 0;
    let downloaded = 0;
    let unlisten: (() => void) | null = null;
    try {
      // pldownloader 插件有全局下载进度事件，这里简单绑定通知 UI
      // 如果没装/没权限也不阻塞——onProgress(undefined, ...) 忽略即可
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const pldl = await import("tauri-plugin-pldownloader-api");
        unlisten = await listen("pldownloader://progress", (e: any) => {
          const p = e.payload as any;
          if (p && typeof p.total === "number" && typeof p.progress === "number") {
            onProgress?.({ downloaded: Math.round((p.progress / 100) * p.total), total: p.total });
          }
        });
      } catch { /* ignore */ }

      if (platform === "android") {
        const path = await invoke<string>("download_apk", { url: downloadUrl, version });
        return { status: "downloaded", filePath: path, platform: "android" };
      }
      if (platform === "ios") {
        const path = await invoke<string>("download_ipa", { url: downloadUrl, version });
        return { status: "downloaded", filePath: path, platform: "ios" };
      }
      return { status: "error", error: `不支持的平台: ${platform}` };
    } finally {
      unlisten?.();
    }
  } catch (e: any) {
    return { status: "error", error: String(e?.message || e) };
  }
}

/**
 * 安装已下载好的原生更新（用户点击按钮触发）
 * - Windows: 自定义 apply_in_place_update 原地替换（复制自身做 helper → 退出进程 → 替换 → 重启）
 * - Android: tauri-plugin-android-installer 的 install(path) 触发系统安装器
 * - iOS: sharekit shareFile 弹出分享面板（"用其他应用打开"），选自签工具覆盖安装
 */
export async function installDownloadedNative(
  platform: "windows" | "android" | "ios" | undefined,
  filePath: string | undefined,
  onProgress?: ProgressCb,
): Promise<NativeUpdateApplyResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };

  const p = platform || detectPlatform();
  if (p === "windows") {
    // Windows：自定义原地替换更新（绿色单文件免安装的持久化更新）。
    // 命令内部会把当前 exe 复制到临时目录做 helper 并立即退出进程；
    // helper 等待本进程退出后，把旧版本重命名为 <原名>-旧版本-<版本>.exe 保留，
    // 用新 exe 原地替换当前 exe 并重启新版本。
    if (!filePath) return { status: "error", error: "新版本未下载" };
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // 旧版本号用于备份命名：<原名>-旧版本-<当前版本>.exe
      let oldVersion = "0.0.0";
      try {
        const v = await getVersionDisplay();
        if (v?.native) oldVersion = v.native;
      } catch { /* 取不到就用占位版本号 */ }
      await invoke("apply_in_place_update", { newExePath: filePath, oldVersion });
      // 正常情况下进程已退出，不会执行到这里
      return { status: "installing" };
    } catch (e: any) {
      return { status: "error", error: String(e?.message || e) };
    }
  }
  if (p === "android") {
    if (!filePath) return { status: "error", error: "APK 未下载" };
    try {
      const { install, canInstall, requestInstallPermission } = await import(
        "tauri-plugin-android-installer-api"
      );
      // Android 8+ 需先授予"安装未知来源应用"权限，否则系统安装器拉起后会被拦截。
      // 未授予时 requestInstallPermission() 跳转系统设置，返回后再校验；
      // 仍未授予则提示用户手动开启（不再笼统报"无法打开系统安装器"）。
      if (!(await canInstall())) {
        await requestInstallPermission();
        if (!(await canInstall())) {
          return {
            status: "error",
            error: "未授予安装未知来源应用的权限（请在 系统设置→应用→本应用→安装未知应用 中允许）",
          };
        }
      }
      await install(filePath);
      return { status: "installing" };
    } catch (e: any) {
      return { status: "error", error: String(e?.message || e) };
    }
  }
  if (p === "ios") {
    if (!filePath) return { status: "error", error: "IPA 未下载" };
    try {
      // sharekit 的 iOS shareFile 用 UIActivityViewController 弹出分享面板，
      // 系统会列出能打开 .ipa 的应用（Esign/Feather），交给它们覆盖安装。
      // 注意：不能用 opener 的 openPath（底层 UIApplication.open 处理不了 IPA，报"格式不正确"）。
      const { shareFile } = await import("@choochmeque/tauri-plugin-sharekit-api");
      // sharekit 要求 file:// URL；download_ipa 返回的是纯路径，需拼接。
      const fileUrl = filePath.startsWith("file://") ? filePath : `file://${filePath}`;
      await shareFile(fileUrl, { title: "update.ipa" });
      return { status: "openIn" };
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 用户主动取消分享面板不算错误
      if (/cancel/i.test(msg)) return { status: "cancelled" };
      return { status: "error", error: msg };
    }
  }
  return { status: "error", error: `不支持的平台: ${p}` };
}

/**
 * 应用原生更新（保留一键旧接口，兼容代码；内部流程与新两步一致）
 * - Windows: 下载新版本 exe + 原地替换（apply_in_place_update）
 * - Android: 下载 APK + 触发系统安装器
 * - iOS: 下载 IPA + 触发 Open In 面板
 */
export async function applyNativeUpdate(
  downloadUrl: string,
  onProgress?: ProgressCb,
  version?: string,
): Promise<NativeUpdateApplyResult> {
  if (!isTauri()) return { status: "error", error: "非 Tauri 环境" };
  if (!downloadUrl) return { status: "error", error: "缺少下载地址" };

  const platform = detectPlatform();
  if (platform === "windows") {
    // Windows：静默下载新版本 → 原地替换安装
    const d = await downloadNativeSilently(downloadUrl, onProgress, version);
    if (d.status !== "downloaded") return { status: "error", error: d.error || "下载新版本失败" };
    return installDownloadedNative("windows", d.filePath);
  }
  if (platform === "android") {
    const d = await downloadNativeSilently(downloadUrl, onProgress, version);
    if (d.status !== "downloaded") return { status: "error", error: d.error || "下载 APK 失败" };
    return installDownloadedNative("android", d.filePath);
  }
  if (platform === "ios") {
    const d = await downloadNativeSilently(downloadUrl, onProgress, version);
    if (d.status !== "downloaded") return { status: "error", error: d.error || "下载 IPA 失败" };
    return installDownloadedNative("ios", d.filePath);
  }
  return { status: "error", error: `不支持的平台: ${platform}` };
}

/**
 * 通知热更新插件：当前 bundle 已成功启动（hotswap notifyReady）
 * 每次 APP 冷启动后调用一次（在 app shell 挂载后即可）。
 * 如果当前运行的是 OTA bundle 而未调用此方法，下次启动会自动回滚到上一个好 bundle。
 * 非 OTA bundle 或插件未启用时为 no-op，可无条件调用。
 */
export async function notifyAppReady(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { notifyReady } = await import("tauri-plugin-hotswap-api");
    await notifyReady();
  } catch {
    // 静默失败：插件未启用或非 OTA bundle 时为 no-op
  }
}

/**
 * 重启 APP。热更新改用 activate + reload 后，此函数仅剩原生更新场景兜底：
 * - Android：Rust restart_app（AlarmManager + killProcess）冷拉起
 * - iOS：无等价 API，返回 false 提示用户手动重开
 * - Windows：原地替换更新由 helper 自动重启，不经过此函数
 */
export async function restartApp(): Promise<boolean> {
  if (!isTauri()) return false;
  const p = detectPlatform();
  if (p === "android") {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_app");
      return true;
    } catch {
      return false;
    }
  }
  // iOS：没有任何 API 能自重启
  return false;
}
