/**
 * 保存图片到相册 / 下载图片
 *
 * 方案（替代原先的 Web Share API）：
 *   移动端（Tauri Android/iOS）使用 `tauri-plugin-pldownloader`：
 *     - iOS：`saveFilePublicFromBuffer` 通过 PHPhotoLibrary 把媒体写入系统相册（真实下载到相册）
 *     - Android：`saveFilePublicFromBuffer` 通过 MediaStore 写入系统 Downloads/相册（无需写权限，Android 10+）
 *   桌面/Web：直接 <a download> 下载
 *
 * 注意：Tauri 原生项目（gen/android、gen/ios）需在接入该插件后重新构建
 * （`tauri android init`/`tauri ios init` 后 cargo 重新编译），插件命令才会生效。
 */

import { showToast } from "@/lib/toast";
import { invoke } from "@tauri-apps/api/core";
import { saveFilePublicFromBuffer } from "tauri-plugin-pldownloader-api";

/** 判断当前是否为 Tauri 环境 */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 判断当前是否为移动端 */
function isMobileTauri(): boolean {
  if (!isTauri()) return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/** 将 dataURL(base64) 转成 ArrayBuffer，供插件保存 */
async function dataUrlToArrayBuffer(dataUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return blob.arrayBuffer();
}

/** 根据文件名判断 mimeType（默认 png） */
function detectMime(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  };
  return map[ext] || "image/png";
}

/**
 * 尝试保存图片到相册。
 * @returns "ok" 已保存到相册；"fallback" 需要调用方展示预览供长按保存
 */
export async function saveImageToAlbum(dataUrl: string, filename: string): Promise<"ok" | "fallback"> {
  if (!isMobileTauri()) return "fallback";

  try {
    const data = await dataUrlToArrayBuffer(dataUrl);
    const res = await saveFilePublicFromBuffer({
      data,
      fileName: filename,
      mimeType: detectMime(filename),
    });
    // 返回 uri/path 即表示已写入系统相册/Downloads
    if (res && (res.uri || res.path)) {
      showToast("图片已保存到相册");
      return "ok";
    }
  } catch (err) {
    console.error("[saveImageToAlbum] 保存失败:", err);
    return "fallback";
  }
  return "fallback";
}

/**
 * 统一保存/下载入口：
 * - 移动端 Tauri：通过 pldownloader 插件直接保存到系统相册
 * - 桌面/Web：直接 <a download> 下载
 * @returns "ok" 已保存；"fallback" 未保存成功（仅移动端插件不可用时返回，交由调用方引导长按保存）
 */
export async function saveMobileOrDownload(dataUrl: string, filename: string): Promise<"ok" | "fallback"> {
  if (isMobileTauri()) {
    const res = await saveImageToAlbum(dataUrl, filename);
    if (res === "ok") return "ok";
    // 插件不可用/失败：不显示"已保存"，交由调用方引导长按保存
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

/**
 * 保存视频到相册（移动端 Tauri 插件）/ 桌面直接下载。
 * 与图片保存同机制：移动端走 tauri-plugin-pldownloader（iOS/Android 写入系统相册），
 * 桌面/Web 用 <a download> 下载。
 * @returns "ok" 已保存；"fallback" 保存未成功（调用方可提示用户）
 */
export async function saveVideoFile(buffer: ArrayBuffer, fileName: string, mimeType: string): Promise<"ok" | "fallback"> {
  if (!isMobileTauri()) {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = fileName;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast("视频已保存");
    return "ok";
  }
  try {
    const res = await saveFilePublicFromBuffer({
      data: buffer,
      fileName,
      mimeType,
    });
    if (res && (res.uri || res.path)) {
      showToast("视频已保存到相册");
      return "ok";
    }
  } catch (err) {
    console.error("[saveVideoFile] 保存失败:", err);
  }
  return "fallback";
}

/**
 * 边录边写（移动端长视频）：把已分块写到本地文件的视频，从文件路径直接导入相册。
 *
 * 区别于 saveVideoFile 的"整段 Blob→ArrayBuffer 再经 IPC 整体拷贝"：调用方先用
 * @tauri-apps/plugin-fs 把录制 chunk 流式落地到应用沙盒文件（JS 峰值只占单个 chunk），
 * 再把文件绝对路径交给本函数；原生侧（iOS PHPhotoLibrary / Android MediaStore）
 * 直接从盘上导入，整段内容不再进入 WebKit/IPC 内存 → 避免 iOS 长视频闪退回首页。
 * @throws 当插件命令失败时。
 */
function isMobileSave(): boolean {
  return isMobileTauri();
}

export async function saveVideoFileFromPath(filePath: string, fileName: string, mimeType: string): Promise<void> {
  if (!isMobileSave()) throw new Error("仅移动端支持路径导入");
  const res = await invoke<{ fileName?: string; path?: string; uri?: string }>("plugin:pldownloader|save_file_public_from_path", {
    payload: { path: filePath, fileName, mimeType },
  });
  if (res && (res.uri || res.path)) {
    showToast("视频已保存到相册");
  } else {
    throw new Error("保存未写入相册");
  }
}
