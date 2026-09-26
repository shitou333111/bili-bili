/**
 * 服务端消费记录拉取进度表（仅 WEB 端使用）
 *
 * 背景：WEB 端 /api/revenue/pay-record 打 B站 是分钟级长任务，
 * Next.js 路由要等整个拉取完成后才返回响应头，前端拿不到任何中间进度。
 * Tauri 端走本地客户端可直接回调（见 pay-record-client.ts），WEB 端则退化为
 * 服务器内存 + 轮询：pay-record 路由把每一页的进度写进本表，
 * 前端拿 ticket 轮询 /api/revenue/pay-record/progress 读取，从而与 APP 文案一致。
 *
 * 注意：模块级 Map 跨请求共享的前提是单进程（pm2 单实例 / next start）。
 * 多实例部署时轮询可能读不到，此时前端表现为"无进度条"，不影响数据正确性。
 */

export type PayRecordProgress = {
  text: string;
  current?: number;
  total?: number;
  at: number;
};

/** 进度条目存活时间：超过即清理，避免异常中断时残留 */
const TTL_MS = 5 * 60 * 1000;

const store = new Map<string, PayRecordProgress>();

function sweep() {
  const now = Date.now();
  for (const [key, value] of store) {
    if (now - value.at > TTL_MS) store.delete(key);
  }
}

/** 写入/覆盖某次拉取的最新进度 */
export function reportPayRecordProgress(
  ticket: string,
  progress: Omit<PayRecordProgress, "at">,
) {
  if (!ticket) return;
  sweep();
  store.set(ticket, { ...progress, at: Date.now() });
}

/** 读取某次拉取的最新进度（无则返回 null） */
export function readPayRecordProgress(ticket: string): PayRecordProgress | null {
  if (!ticket) return null;
  return store.get(ticket) ?? null;
}

/** 拉取结束后清理（正常/异常路径都调用） */
export function clearPayRecordProgress(ticket: string) {
  if (!ticket) return;
  store.delete(ticket);
}