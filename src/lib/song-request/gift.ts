/**
 * 点歌机 · 点歌礼物门禁
 *
 * 规则：识别到点歌弹幕的时刻，前 60 秒内该用户送过「点歌礼物」→ 直接放行；
 * 否则挂起等待最多 60 秒，期间该用户送出指定礼物即放行，超时判定为未投喂。
 */
import { loadGiftRecordsByRange } from "@/lib/display/gift-db";

/** 前后各 1 分钟（总计 2 分钟）窗口 */
export const SONG_GIFT_WINDOW_MS = 60_000;

interface Waiter {
  giftId: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (ok: boolean) => void;
}

const waiters = new Map<string, Waiter>();

function keyOf(mid: number, uid: number): string {
  return `${mid}:${uid}`;
}

/** 该用户最近 windowMs 内是否送过指定礼物 */
export async function hasRecentGift(
  mid: number,
  uid: number,
  giftId: number,
  windowMs = SONG_GIFT_WINDOW_MS,
): Promise<boolean> {
  if (!giftId || !uid) return false;
  const end = new Date();
  const start = new Date(end.getTime() - windowMs);
  try {
    const rows = await loadGiftRecordsByRange(mid, { start, end });
    return rows.some((r) => Number(r.uid) === uid && Number(r.giftId) === giftId);
  } catch {
    return false;
  }
}

/** 挂起等待指定礼物；同一用户重复调用会取消上一次等待 */
export function waitForGift(
  mid: number,
  uid: number,
  giftId: number,
  timeoutMs = SONG_GIFT_WINDOW_MS,
): Promise<boolean> {
  const key = keyOf(mid, uid);
  cancelWait(key);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(key);
      resolve(false);
    }, timeoutMs);
    waiters.set(key, { giftId, timer, resolve });
  });
}

/** 礼物落库后调用：命中等待中的用户 → 立即放行 */
export function notifySongRequestGift(mid: number, uid: number, giftId: number): void {
  const key = keyOf(mid, uid);
  const w = waiters.get(key);
  if (!w) return;
  if (w.giftId && giftId !== w.giftId) return;
  waiters.delete(key);
  clearTimeout(w.timer);
  w.resolve(true);
}

function cancelWait(key: string): void {
  const old = waiters.get(key);
  if (!old) return;
  clearTimeout(old.timer);
  waiters.delete(key);
}

/** 停止监听等场景：取消所有等待（按未投喂处理） */
export function resetGiftWaiters(): void {
  for (const [key, w] of waiters) {
    clearTimeout(w.timer);
    w.resolve(false);
    waiters.delete(key);
  }
}
