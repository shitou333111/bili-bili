/**
 * 下载 JSON 数据文件（跨平台）
 *
 * 背景：凭证已本地化后，登录会话只存本机、不再上传服务器，
 * 因此服务器 /api/export/json 无法再根据 sid 找到会话（会返回 403）。
 *
 * 正确做法：
 *   - Web：通过 fetch 从真实服务器（serverApiUrl）拉取 JSON；
 *   - Tauri：直接从本地 uid_<mid>/pay-records.json 读取并本地生成 JSON，
 *     避免依赖服务器会话；
 *   - 桌面/Web：用 Blob + <a download> 触发真正的 .json 文件下载；
 *   - 移动端 Tauri：用 pldownloader 插件保存到系统存储（Android→Downloads/相册，iOS→"文件"App/相册）。
 */

import { showToast } from "@/lib/toast";
import { serverApiUrl } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { saveFilePublicFromBuffer } from "tauri-plugin-pldownloader-api";

/** 判断是否为 Tauri 移动端 */
function isTauriMobile(): boolean {
  try {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** 从本地文件读取并构建导出 JSON 内容（Tauri 专用，不依赖服务器会话） */
async function buildLocalExport(): Promise<{ blob: Blob; filename: string } | null> {
  try {
    const platform = await getPlatform();
    const state = await platform.getSessionState();
    const sid = state.currentSid;
    const session = state.sessions.find((s) => s.sid === sid);
    if (!session) {
      showToast("未找到本地会话，请先登录");
      return null;
    }

    const recordsPath = `${await platform.getDataDir()}/uid_${session.mid}/pay-records.json`;
    if (!(await platform.exists(recordsPath))) {
      showToast("本地暂无消费记录数据");
      return null;
    }

    const raw = await platform.readFile(recordsPath);
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed) ? parsed : (parsed.records ?? []);

    const totalCoins = records.reduce((sum: number, r: any) => {
      const coins = Number((r.pay_coin || r.coin).replace(/,/g, "")) || 0;
      return sum + coins;
    }, 0);

    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const exportData = {
      exportedAt: new Date().toISOString(),
      account: { uname: session.uname, mid: session.mid, source: session.source },
      totalRecords: records.length,
      totalCoins,
      records,
    };

    const jsonStr = JSON.stringify(exportData, null, 2);
    return { blob: new Blob([jsonStr], { type: "application/json" }), filename: `bili-revenue-${month}.json` };
  } catch (err) {
    console.error("[downloadJson] 本地导出失败:", err);
    showToast("本地导出失败");
    return null;
  }
}

/** 下载当前账号的 JSON 数据 */
export async function downloadJsonFile() {
  let blob: Blob;
  let filename = "bili-revenue.json";

  const platform = await getPlatform().catch(() => null);

  if (platform?.isNative) {
    // Tauri：本地导出（不依赖服务器会话）
    const local = await buildLocalExport();
    if (!local) return;
    blob = local.blob;
    filename = local.filename;
  } else {
    // Web：从服务器拉取
    let url = "/api/export/json";
    if (typeof window !== "undefined") {
      const sid = localStorage.getItem("bili_live_sid");
      const params: string[] = [];
      if (sid) params.push(`_sid=${encodeURIComponent(sid)}`);
      if (params.length > 0) url += `?${params.join("&")}`;
    }
    const full = serverApiUrl(url);

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
  }

  // 移动端 Tauri：通过 pldownloader 插件保存到系统存储（Android→Downloads/相册，iOS→"文件"App/相册）
  if (isTauriMobile()) {
    try {
      const data = await blob.arrayBuffer();
      const res = await saveFilePublicFromBuffer({
        data,
        fileName: filename,
        mimeType: "application/json",
      });
      if (res && (res.uri || res.path)) {
        const loc = res.path || res.uri || "";
        showToast(`JSON 已保存到 ${loc}`);
        return;
      }
    } catch (err) {
      console.error("[downloadJson] 插件保存失败:", err);
      showToast("JSON 保存失败，请检查网络与存储权限");
      return;
    }
    showToast("JSON 保存失败，请重试");
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
  showToast("JSON 已下载到浏览器默认下载文件夹");
}
