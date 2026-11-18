/**
 * 黑白榜服务端存储
 *
 * 目录：.data/leaderboard/{users|anchors}/<card>.json
 * 每个文件保存该卡片在某个视图下的全部用户条目（当前用户量很小，单文件足够）。
 * 写入采用「临时文件 + rename」原子写，并对同一文件做进程内串行锁，避免并发丢更新。
 *
 * 过期规则：
 * - today：只保留归属日期 = 今天的指标（读取时同时要求 24 小时内更新）；
 * - lastFriday：只保留归属日期 = 最近一个已过去的周五；
 * - activity / year：长期保留。
 */

import { promises as fs } from "fs";
import path from "path";
import {
  normalizeMetric,
  type LeaderboardBoardFile,
  type LeaderboardReport,
  type LeaderboardView,
  type StoredEntry,
  type StoredPeriodMetric,
  type LeaderboardPeriodKey,
} from "./leaderboard-types";
import { beijingDateKey, lastPastFridayKey } from "./leaderboard-time";

const ROOT_DIR = path.join(process.cwd(), ".data", "leaderboard");

const locks = new Map<string, Promise<unknown>>();

/** 同一文件串行执行，避免并发 read-modify-write 丢更新 */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

function viewDir(view: LeaderboardView): string {
  return path.join(ROOT_DIR, view === "user" ? "users" : "anchors");
}

/** 卡片键校验：文件名已用 base64url 编码，这里只拦长度异常与控制字符 */
export function isSafeCardKey(card: string): boolean {
  return typeof card === "string" && card.length >= 1 && card.length <= 80 && !/[\u0000-\u001f\u007f]/.test(card);
}

function fileNameFor(card: string): string {
  // 用 base64url 编码卡片键：可逆、无字符集限制（合成活动 ID 可能含中文），且不会互相覆盖
  return `${Buffer.from(card, "utf8").toString("base64url")}.json`;
}

function filePathFor(view: LeaderboardView, card: string): string {
  return path.join(viewDir(view), fileNameFor(card));
}

function emptyBoard(view: LeaderboardView, card: string): LeaderboardBoardFile {
  return { version: 1, card, view, updatedAt: 0, entries: {} };
}

export async function readLeaderboardBoard(
  view: LeaderboardView,
  card: string,
): Promise<LeaderboardBoardFile> {
  if (!isSafeCardKey(card)) return emptyBoard(view, card);
  try {
    const raw = await fs.readFile(filePathFor(view, card), "utf-8");
    const parsed = JSON.parse(raw) as LeaderboardBoardFile;
    if (!parsed || typeof parsed !== "object" || !parsed.entries) return emptyBoard(view, card);
    return {
      version: 1,
      card,
      view,
      updatedAt: Number(parsed.updatedAt) || 0,
      entries: parsed.entries,
    };
  } catch {
    return emptyBoard(view, card);
  }
}

async function writeLeaderboardBoard(board: LeaderboardBoardFile): Promise<void> {
  const dir = viewDir(board.view);
  await fs.mkdir(dir, { recursive: true });
  const target = filePathFor(board.view, board.card);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, JSON.stringify(board), "utf-8");
  await fs.rename(tmp, target);
}

/** 清理过期周期；条目没有任何有效周期时整条删除 */
function pruneBoard(board: LeaderboardBoardFile, todayKey: string, fridayKey: string): void {
  for (const [uidStr, entry] of Object.entries(board.entries)) {
    const periods = entry.periods ?? {};
    for (const key of Object.keys(periods) as LeaderboardPeriodKey[]) {
      const p = periods[key];
      if (!p) continue;
      if (key === "today" && p.dayKey !== todayKey) delete periods[key];
      if (key === "lastFriday" && p.dayKey !== fridayKey) delete periods[key];
    }
    if (Object.keys(periods).length === 0) delete board.entries[uidStr];
  }
}

export async function applyLeaderboardReport(report: LeaderboardReport): Promise<void> {
  const now = Date.now();
  const todayKey = beijingDateKey(now);
  const fridayKey = lastPastFridayKey(now);
  const uidKey = String(report.uid);

  for (const card of report.cards) {
    if (!isSafeCardKey(card.card)) continue;
    const lockKey = `${report.view}:${card.card}`;
    await withLock(lockKey, async () => {
      const board = await readLeaderboardBoard(report.view, card.card);
      const entry: StoredEntry = board.entries[uidKey] ?? {
        uid: report.uid,
        name: report.name,
        face: report.face,
        updatedAt: now,
        periods: {},
      };
      entry.uid = report.uid;
      entry.name = report.name;
      if (report.face) entry.face = report.face;
      entry.updatedAt = now;

      for (const key of Object.keys(card.periods) as LeaderboardPeriodKey[]) {
        const metric = card.periods[key];
        if (!metric) continue;
        const stored: StoredPeriodMetric = {
          ...normalizeMetric(metric),
          updatedAt: now,
        };
        if (key === "today") stored.dayKey = todayKey;
        if (key === "lastFriday") stored.dayKey = fridayKey;
        entry.periods[key] = stored;
      }

      board.entries[uidKey] = entry;
      pruneBoard(board, todayKey, fridayKey);
      board.updatedAt = now;
      await writeLeaderboardBoard(board);
    });
  }
}
