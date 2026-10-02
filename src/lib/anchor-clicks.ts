/**
 * 推荐主播全局点击计数（服务器持久化，所有用户共享、累计）。
 *
 * 单独存放于 .data/anchor-clicks.json，而不是写进 admin-config.json：
 *   - admin 保存配置时只映射固定字段（不含 click_count），不会清空计数；
 *   - 计数递增无需整体重写配置，避免与 admin 编辑互相覆盖。
 * 客户端每次打开帮助页都从服务器读取，因此重装软件后仍能看到最新累计值。
 */
import { promises as fs } from "fs";
import path from "path";

const CLICK_FILE = path.join(process.cwd(), ".data", "anchor-clicks.json");

/** uid（字符串）→ 点击次数 */
export type AnchorClickMap = Record<string, number>;

async function readClickFile(): Promise<AnchorClickMap> {
  try {
    const raw = JSON.parse(await fs.readFile(CLICK_FILE, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AnchorClickMap;
  } catch {
    /* 文件不存在/损坏 → 视为无计数 */
  }
  return {};
}

/** 串行写盘链：并发点击逐个累积，避免 read-modify-write 丢更新 */
let chain: Promise<unknown> = Promise.resolve();

/** 读取全部点击计数 */
export async function readAnchorClicks(): Promise<AnchorClickMap> {
  await chain.catch(() => {});
  return readClickFile();
}

/**
 * 递增某主播点击次数并返回新值。
 * seed：计数文件中尚无该 uid 时的起始值（旧实现曾把计数写在 admin-config.json 里，
 * 传入该值可无缝承接历史计数，之后一律以计数文件为准）。
 */
export async function incrementAnchorClick(uid: number, seed = 0): Promise<number> {
  let next = 0;
  chain = chain
    .catch(() => {})
    .then(async () => {
      const clicks = await readClickFile();
      next = (clicks[String(uid)] ?? seed) + 1;
      clicks[String(uid)] = next;
      await fs.mkdir(path.dirname(CLICK_FILE), { recursive: true });
      await fs.writeFile(CLICK_FILE, JSON.stringify(clicks, null, 2), "utf8");
    });
  await chain.catch(() => {});
  return next;
}