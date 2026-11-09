import { NextResponse } from "next/server";
import { waitForScanUpdate } from "@/lib/lottery-scan";

export const dynamic = "force-dynamic";

/**
 * 客户端长轮询：等待扫描结果变化（最长 25 秒）。
 * 扫描引擎发现新天选/红包时会立即唤醒，客户端随即拉取最新列表，实现近实时推送。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const timeoutParam = Number(url.searchParams.get("timeout") ?? 25000);
  const timeout = Number.isFinite(timeoutParam) ? Math.min(28000, Math.max(1000, timeoutParam)) : 25000;
  try {
    const data = await waitForScanUpdate(since, timeout);
    return NextResponse.json({ code: 0, data });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "等待扫描更新失败" },
      { status: 500 },
    );
  }
}
