import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");
// 主播活动素材本地文件落盘目录（素材链接以 /api/admin/material?f=<文件名> 形式写进配置）
const MATERIAL_DIR = path.join(DATA_DIR, "anchor-materials");
// 分片上传临时目录（各片先追加到这里，最后一片校验后转正）
const TMP_DIR = path.join(MATERIAL_DIR, "tmp");

/** 支持的图片扩展名 → MIME（上传解析与 GET 返回共用） */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** 素材文件名白名单（防路径穿越）：字母数字 - _ + 已知图片扩展名 */
const FILENAME_RE = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|avif|bmp)$/;
/** 分片上传标识白名单 */
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
};
const MAX_FILE_SIZE = 30 * 1024 * 1024; // 素材文件大小上限 30MB
const MAX_CHUNK_SIZE = 2 * 1024 * 1024; // 单分片原始字节上限 2MB
const TMP_STALE_MS = 60 * 60 * 1000; // 未完成分片残留 1 小时后清理

/** 清理超过 1 小时未完成的临时分片文件，避免中断上传残留垃圾 */
async function cleanupStaleTmp() {
  try {
    const entries = await fs.readdir(TMP_DIR);
    const deadline = Date.now() - TMP_STALE_MS;
    for (const name of entries) {
      const p = path.join(TMP_DIR, name);
      try {
        const st = await fs.stat(p);
        if (st.mtimeMs < deadline) await fs.unlink(p);
      } catch {
        // 忽略单个文件的清理失败
      }
    }
  } catch {
    // tmp 目录不存在等情况直接忽略
  }
}

/**
 * 主播活动素材本地文件上传/拉取
 * - POST 分片上传协议（body JSON）：{ uploadId, part, total, mime, data }
 *   - uploadId：本次上传标识（字母数字 - _）；part：0 起的分片序号；total：分片总数
 *   - data：本片原始字节的 base64（不含 data: 前缀）；mime：图片 MIME（image/png 等）
 *   - 客户端按顺序循环上传，各片追加到临时文件，最后一片校验体积后转正，
 *     响应里返回 { data: { url } }
 *   分片原因：线上 nginx 对请求体有大小限制（默认 1m，超限返回 413 HTML 页），
 *   整文件 base64 单发会被拦截；切成小片后任意大小的素材都能传。
 * - GET ?f=<文件名>  返回素材图片（公开访问，供主播页预览与下载）
 */
export async function POST(request: Request) {
  try {
    if (!(await validateAdminSession(getAdminSid(request)))) {
      return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const uploadId = String(body?.uploadId ?? "");
    const part = Number(body?.part);
    const total = Number(body?.total);
    const mime = String(body?.mime ?? "");
    const data = String(body?.data ?? "");

    if (
      !UPLOAD_ID_RE.test(uploadId) ||
      !Number.isInteger(part) ||
      !Number.isInteger(total) ||
      part < 0 ||
      total < 1 ||
      part >= total ||
      total > 4096
    ) {
      return NextResponse.json({ code: -1, message: "参数不合法" }, { status: 400 });
    }
    const ext = MIME_TO_EXT[mime === "image/jpg" ? "image/jpeg" : mime];
    if (!ext) {
      return NextResponse.json({ code: -1, message: "图片格式不支持（png/jpg/webp/gif/avif/bmp）" }, { status: 400 });
    }
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) {
      return NextResponse.json({ code: -1, message: "分片内容不合法" }, { status: 400 });
    }
    const buffer = Buffer.from(data, "base64");
    if (buffer.length === 0) {
      return NextResponse.json({ code: -1, message: "分片内容为空" }, { status: 400 });
    }
    if (buffer.length > MAX_CHUNK_SIZE) {
      return NextResponse.json({ code: -1, message: "分片过大" }, { status: 400 });
    }

    await fs.mkdir(TMP_DIR, { recursive: true });
    await cleanupStaleTmp();
    const tmpPath = path.join(TMP_DIR, `${uploadId}.part`);
    await fs.appendFile(tmpPath, buffer);

    if (part < total - 1) {
      return NextResponse.json({ code: 0, message: `已接收 ${part + 1}/${total}`, data: { received: part + 1 } });
    }

    // 最后一片：校验体积后转正为正式素材文件
    const st = await fs.stat(tmpPath);
    if (st.size === 0 || st.size > MAX_FILE_SIZE) {
      await fs.unlink(tmpPath).catch(() => {});
      return NextResponse.json(
        { code: -1, message: st.size === 0 ? "文件内容为空" : "文件过大（上限 30MB）" },
        { status: 400 },
      );
    }
    const fileName = `${uploadId}.${ext}`;
    await fs.rename(tmpPath, path.join(MATERIAL_DIR, fileName));

    return NextResponse.json({ code: 0, message: "上传成功", data: { url: `/api/admin/material?f=${fileName}` } });
  } catch (err) {
    console.error("[AdminMaterial] 上传失败:", err);
    return NextResponse.json({ code: -1, message: "上传失败" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const f = new URL(request.url).searchParams.get("f") ?? "";
  if (!FILENAME_RE.test(f)) {
    return new NextResponse("not found", { status: 404 });
  }
  try {
    const buffer = await fs.readFile(path.join(MATERIAL_DIR, f));
    const ext = f.split(".").pop()?.toLowerCase() ?? "png";
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
        // 主播页在 Tauri 生产包（跨源 WebView）里用 fetch 取素材落盘，需放行 CORS
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
}
