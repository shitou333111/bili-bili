import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { BUILD_SEQ } from "@/lib/build-info";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * 公开 API：PWA 当前线上版本。
 *
 * Web 端"检查更新"用它拿到服务器最新的构建序号，再与当前 Service Worker 生效的序号比较：
 *  - 服务器更新 → 触发 registration.update()，浏览器在后台下载新 SW
 *  - 相同 → 显示"已是最新"
 *
 * enabled=false 时（服务器存在 .data/pwa-disable）客户端会主动卸载 SW 并清缓存。
 */
export async function GET() {
  let enabled = true;
  try {
    await fs.access(path.join(process.cwd(), ".data", "pwa-disable"));
    enabled = false;
  } catch {
    enabled = true;
  }

  return NextResponse.json(
    {
      code: 0,
      data: {
        seq: Number(BUILD_SEQ) || 0,
        enabled,
      },
    },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0" } },
  );
}
