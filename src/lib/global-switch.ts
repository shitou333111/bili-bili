/**
 * 全局访问开关（kill switch）：发布后若某功能出现 BUG，可一键切断客户端对本服务器 API 的访问，
 * 避免损失；切断期间仍放行 /api/admin/*，以便登录后台排查并重新开启。
 *
 * - 状态持久化到 .data/global-switch.json（{ disabled: boolean }），默认为开启（disabled=false）。
 * - 由 admin 页面切换（见 /api/admin/switch，validateAdminSession 保护）。
 * - 由 middleware 读取：命中 /api/* 且 disabled=true 时直接返回 503。
 * - 读取失败（文件不存在/损坏）也视为开启，避免误伤正常访问。
 */

import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".data");
const SWITCH_FILE = path.join(STATE_DIR, "global-switch.json");

export type GlobalSwitch = {
  /** 切断所有客户端对 /api/* 的访问（放行 /api/admin/*） */
  disabled: boolean;
  /**
   * 关闭网页端（app.bili-bili.icu）：浏览器访问应用页面时不再返回软件，
   * 而是返回「请下载客户端」提示页。客户端（Tauri 加载本地页面）不受影响。
   */
  webDisabled: boolean;
};

/** 读取全局开关状态（无文件或损坏 → 视为开启） */
export async function readGlobalSwitch(): Promise<GlobalSwitch> {
  try {
    const raw = await fs.readFile(SWITCH_FILE, "utf-8");
    // 兼容带 UTF-8 BOM 的文件（手工用 PowerShell 写状态时会产生 BOM，JSON.parse 会直接抛错）
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return {
      disabled: parsed?.disabled === true,
      webDisabled: parsed?.webDisabled === true,
    };
  } catch {
    return { disabled: false, webDisabled: false };
  }
}

/** 写入全局开关状态（未传的字段保持原值；原子替换，避免并发读到半截 JSON） */
export async function writeGlobalSwitch(
  patch: { disabled?: boolean; webDisabled?: boolean },
): Promise<GlobalSwitch> {
  const current = await readGlobalSwitch();
  await fs.mkdir(STATE_DIR, { recursive: true });
  const next: GlobalSwitch = {
    disabled: typeof patch.disabled === "boolean" ? patch.disabled : current.disabled,
    webDisabled: typeof patch.webDisabled === "boolean" ? patch.webDisabled : current.webDisabled,
  };
  const tmp = `${SWITCH_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
  await fs.rename(tmp, SWITCH_FILE);
  return next;
}
