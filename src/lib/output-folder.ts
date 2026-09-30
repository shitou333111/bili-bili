/**
 * 桌面端统一产物目录「礼物截图录屏」（exe 同级，不可写回退应用数据目录）。
 *
 * 三个模块共用：礼物截图 / 礼物模拟录屏 / 完整录屏。
 * 移动端没有用户可见的文件夹，也不弹文件管理器，故均不走这里（保持存相册/分享）。
 */

import { appDataDir, join } from "@tauri-apps/api/path";
import { writeFile } from "@tauri-apps/plugin-fs";
import { getPlatform, isWindowsDisplaySupported } from "./platform";

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke(cmd, args)) as T;
}

/** 是否使用统一产物目录：仅 Windows 桌面客户端。 */
export async function usesOutputFolder(): Promise<boolean> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false;
  try {
    return isWindowsDisplaySupported(await getPlatform());
  } catch {
    return false;
  }
}

/** 产物目录的绝对路径。 */
export async function outputDirPath(): Promise<string> {
  return invokeCmd<string>("output_dir");
}

/** 在文件管理器里打开产物目录。 */
export async function openOutputFolder(): Promise<string> {
  return invokeCmd<string>("open_output_folder");
}

/**
 * 落盘到统一产物目录。先在（已授权的）应用数据目录写盘，再让 Rust 移过去——
 * 几 MB 的产物不做 Base64/数组形式的 IPC 拷贝。
 */
export async function saveToOutputFolder(data: Uint8Array, fileName: string): Promise<string> {
  const tmp = await join(await appDataDir(), `_out-${Date.now()}-${fileName}`);
  await writeFile(tmp, data);
  return invokeCmd<string>("commit_output_file", { srcPath: tmp, fileName });
}

/** 本地日期 YYYYMMDD（产物文件名前缀）。 */
export function yyyymmdd(ts: number | Date = Date.now()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}