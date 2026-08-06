/**
 * 移动端（Tauri Android/iOS）保存图片到相册
 *
 * Tauri 2 原生项目（Android/iOS）未提交到仓库，无法在纯前端添加 MediaStore /
 * PHPhotoLibrary 原生权限代码。因此采用 WebView 可用的跨平台方案：
 *   1. 优先使用 Web Share API（navigator.share({ files })）：
 *      - Android/iOS WebView 支持，系统分享面板可选"保存到图片/相册"
 *      - 由系统处理相册权限，无需额外申请
 *   2. 若 Web Share 不可用、被取消或失败，返回 "fallback"（绝不伪装成已保存），
 *      由调用方回退到"预览图片 + 长按保存"。
 *
 * 注意：移动端不要回退到 <a download> —— WebView 里它不会写入系统相册，
 * 却会弹出"已保存"的误导提示（这正是"提示已保存但相册里没有"的根因）。
 */

import { showToast } from "@/lib/toast";

/** 判断当前是否为 Tauri 环境 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 判断当前是否为移动端 */
function isMobileTauri(): boolean {
  if (!isTauri()) return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/** 将 dataURL 转成 File */
async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/png" });
}

/**
 * 尝试保存图片到相册。
 * @returns "ok" 已通过系统分享/保存成功；"fallback" 需要调用方展示预览供长按保存
 */
export async function saveImageToAlbum(dataUrl: string, filename: string): Promise<"ok" | "fallback"> {
  if (!isMobileTauri()) return "fallback";

  try {
    const file = await dataUrlToFile(dataUrl, filename);
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      // 注意：navigator.share 在分享面板关闭时即 resolve，并不代表图片已真正写入相册
      // （用户可能分享到其他应用、或取消）。因此绝不谎报"已保存"，只提示下一步操作。
      showToast("已打开分享面板，请选择保存到相册/图库");
      return "ok";
    }
  } catch (err) {
    // 用户取消分享或分享失败（未真正保存到相册），返回 fallback
    return "fallback";
  }
  return "fallback";
}

/**
 * 统一保存/下载入口：
 * - 移动端 Tauri：优先通过系统分享保存到相册；失败/取消返回 "fallback"，
 *   由调用方展示预览供长按保存（绝不回退到 <a download> 以免误导"已保存"）
 * - 桌面/Web：直接 <a download> 下载
 * @returns "ok" 已保存；"fallback" 未保存成功（仅移动端分享失败时返回）
 */
export async function saveMobileOrDownload(dataUrl: string, filename: string): Promise<"ok" | "fallback"> {
  if (isMobileTauri()) {
    const res = await saveImageToAlbum(dataUrl, filename);
    if (res === "ok") return "ok";
    // 分享未完成/不可用：不显示"已保存"，交由调用方引导长按保存
    return "fallback";
  }
  const link = document.createElement("a");
  link.download = filename;
  link.href = dataUrl;
  link.click();
  showToast("图片已保存");
  return "ok";
}

/** 判断当前设备是否为 Tauri 移动端（供调用方决定走相册保存路径） */
export function isTauriMobile(): boolean {
  return isMobileTauri();
}