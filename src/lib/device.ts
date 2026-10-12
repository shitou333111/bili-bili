/**
 * 设备检测工具函数
 */

/** 判断是否为移动设备 */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return /android|iphone|ipad|ipod|blackberry|windows phone/i.test(ua);
}

/** 判断是否为电脑 */
export function isDesktop(): boolean {
  return !isMobileDevice();
}

// ==================== 平台/设备信息采集（admin 用户列表统计用） ====================

/** 使用平台：web（浏览器）/ desktop（电脑客户端）/ android（安卓客户端）/ ios（iOS 客户端） */
export type UserPlatform = "web" | "desktop" | "android" | "ios";

/** 采集到的设备信息（上报给服务器，存入 users-list.json 的用户条目） */
export type UserDeviceInfo = {
  platform: UserPlatform;
  /** 品牌/机型（手机型号、iPhone/iPad 等，尽量从 UA / UA-CH 解析） */
  brand?: string;
  /** 系统（Android / iOS / iPadOS / Windows / macOS 等） */
  os?: string;
  /** 系统版本 */
  osVersion?: string;
  /** 浏览器 / 内核（Chrome / Safari / Edge / 微信等；客户端为内嵌 WebView） */
  browser?: string;
  /** 浏览器版本 */
  browserVersion?: string;
  /** 原始 UA（诊断兜底） */
  ua?: string;
};

/** 是否 Tauri 客户端环境 */
function inTauri(): boolean {
  try {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

/** 从 UA 解析系统与版本 */
function parseOs(ua: string): { os?: string; osVersion?: string } {
  let m = ua.match(/Android (\d+(?:\.\d+)*)/);
  if (m) return { os: "Android", osVersion: m[1] };
  m = ua.match(/(?:iPhone OS|CPU OS) (\d+(?:[._]\d+)*)/);
  if (m) return { os: /iPad/.test(ua) ? "iPadOS" : "iOS", osVersion: m[1].replace(/_/g, ".") };
  m = ua.match(/Windows NT (\d+\.\d+)/);
  if (m) {
    const nt = m[1];
    // NT 10.0 = Windows 10/11（11 由 UA-CH platformVersion 的 build 号再判定）
    return { os: "Windows", osVersion: nt === "10.0" ? "10/11" : `NT ${nt}` };
  }
  m = ua.match(/Mac OS X (\d+(?:[._]\d+)*)/);
  if (m) return { os: "macOS", osVersion: m[1].replace(/_/g, ".") };
  if (/Linux/.test(ua)) return { os: "Linux" };
  return {};
}

/** 从 UA 解析浏览器/内核与版本 */
function parseBrowser(ua: string): { browser?: string; browserVersion?: string } {
  let m = ua.match(/MicroMessenger\/([\d.]+)/);
  if (m) return { browser: "微信", browserVersion: m[1] };
  m = ua.match(/EdgA?\/([\d.]+)/) ?? ua.match(/EdgiOS\/([\d.]+)/);
  if (m) return { browser: "Edge", browserVersion: m[1] };
  m = ua.match(/FxiOS\/([\d.]+)/) ?? ua.match(/Firefox\/([\d.]+)/);
  if (m) return { browser: "Firefox", browserVersion: m[1] };
  m = ua.match(/(?:CriOS|Chrome)\/([\d.]+)/);
  if (m) return { browser: "Chrome", browserVersion: m[1] };
  m = ua.match(/Version\/([\d.]+).*Safari/);
  if (m) return { browser: "Safari", browserVersion: m[1] };
  m = ua.match(/QQBrowser\/([\d.]+)/) ?? ua.match(/Quark\/([\d.]+)/);
  if (m) return { browser: m[0].split("/")[0], browserVersion: m[1] };
  return {};
}

/** 从 UA 解析品牌/机型（Android 的 model/Build 片段、iPhone/iPad 等） */
function parseBrand(ua: string): string | undefined {
  let m = ua.match(/model\/([^;)\s]+)/);
  if (m) return m[1];
  m = ua.match(/;\s*([^;)]+?)\s+Build\b/);
  if (m) return m[1].trim();
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  return undefined;
}

/**
 * 采集当前平台与设备信息。
 * 平台归类：Tauri 客户端按运行系统分「电脑/安卓/ios」，浏览器一律「web」。
 * 设备详情从 navigator.userAgent 解析（品牌/机型、系统版本、浏览器），
 * Chromium 的 UA-CH（userAgentData.getHighEntropyValues）可用时补充更精确的机型与版本。
 */
export async function collectUserDeviceInfo(): Promise<UserDeviceInfo> {
  if (typeof window === "undefined") return { platform: "web" };
  const nav = window.navigator;
  const ua = nav.userAgent || "";
  const tauri = inTauri();
  const { os } = parseOs(ua);

  let platform: UserPlatform = "web";
  if (tauri) {
    if (os === "Android") platform = "android";
    else if (os === "iOS" || os === "iPadOS") platform = "ios";
    else platform = "desktop";
  }

  const info: UserDeviceInfo = {
    platform,
    ...parseOs(ua),
    ...parseBrowser(ua),
    brand: parseBrand(ua),
    ua: ua.slice(0, 512),
  };

  // UA-CH 高熵值补充（Chrome/Edge/WebView；Safari/Firefox 不支持则忽略）
  try {
    const uad = (
      nav as Navigator & {
        userAgentData?: {
          getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
        };
      }
    ).userAgentData;
    if (uad?.getHighEntropyValues) {
      const hi = await uad.getHighEntropyValues(["platform", "platformVersion", "model", "fullVersionList"]);
      if (typeof hi.model === "string" && hi.model) info.brand = hi.model;
      if (typeof hi.platformVersion === "string" && hi.platformVersion) {
        if (os === "Windows") {
          // Windows 的 platformVersion 形如 "15.0.0"，第三段是 build（>=22000 为 Win11）
          const build = Number(hi.platformVersion.split(".")[2] ?? 0);
          info.osVersion = build >= 22000 ? "11" : "10";
        } else if (!info.osVersion) {
          info.osVersion = hi.platformVersion;
        }
      }
      const list = hi.fullVersionList as Array<{ brand?: string; version?: string }> | undefined;
      const branded = list?.find((b) => b.brand && !/Not.?A.?Brand/i.test(b.brand));
      if (branded?.version) info.browserVersion = branded.version;
    }
  } catch {
    /* UA-CH 不可用忽略 */
  }

  return info;
}
