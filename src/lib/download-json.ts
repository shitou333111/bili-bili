/**
 * 下载 JSON 数据文件（跨平台）
 *
 * 背景：页面里原来的 `<a href="/api/export/json" download>` 在 Tauri 静态导出下不可用——
 * 前端是静态文件，`/api/...` 相对路径解析不到真实服务器，结果下载到的是一份
 * 404 页面的 .htm 文件（电脑上）或干脆没反应（手机上）。
 *
 * 正确做法：
 *   1. 通过 fetch 从真实服务器（serverApiUrl）拉取 JSON；
 *   2. 桌面/Web：用 Blob + <a download> 触发真正的 .json 文件下载；
 *   3. 移动端 Tauri：用系统分享面板分享该 JSON 文件（可保存到"文件"等应用）。
 */

import { showToast } from "@/lib/toast";
import { serverApiUrl } from "@/lib/server-api";

/** 判断是否为 Tauri 移动端 */
function isTauriMobile(): boolean {
  try {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** 下载当前账号的 JSON 数据 */
export async function downloadJsonFile() {
  // 拼接会话参数（Tauri WebView 可能不发送 cookie）
  let url = "/api/export/json";
  if (typeof window !== "undefined") {
    const sid = localStorage.getItem("bili_live_sid");
    const params: string[] = [];
    if (sid) params.push(`_sid=${encodeURIComponent(sid)}`);
    if (params.length > 0) url += `?${params.join("&")}`;
  }
  const full = serverApiUrl(url);

  let blob: Blob;
  let filename = "bili-revenue.json";
  try {
    const res = await fetch(full, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
    const cd = res.headers.get("Content-Disposition");
    const m = cd && cd.match(/filename="?([^";]+)"?/i);
    if (m && m[1]) filename = m[1];
  } catch (err) {
    console.error("[downloadJson] 下载失败:", err);
    showToast("JSON 下载失败，请检查网络连接");
    return;
  }

  // 移动端 Tauri：用系统分享面板分享 JSON 文件
  if (isTauriMobile()) {
    const file = new File([blob], filename, { type: "application/json" });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        showToast("已打开分享面板，请选择保存位置");
        return;
      } catch {
        // 用户取消
      }
    }
    showToast("未保存到本机，请在分享面板选择保存位置");
    return;
  }

  // 桌面/Web：Blob 下载，确保得到真正的 .json 文件
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
  showToast("JSON 已开始下载");
}
