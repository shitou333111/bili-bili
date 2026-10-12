import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");
// 主播活动素材本地文件落盘目录（素材链接以 /api/admin/material?f=<文件名> 形式写进配置）
const MATERIAL_DIR = path.join(DATA_DIR, "anchor-materials");

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

/**
 * 主播活动素材本地文件上传/拉取
 * - POST body: { dataUrl }  dataUrl 为 data:image/...;base64,...
 *   解码后保存到 .data/anchor-materials/<id>.<ext>，返回可直接访问的相对链接
 * - GET ?f=<文件名>  返回素材图片（公开访问，供主播页预览与下载）
 */
export async function POST(request: Request) {
  try {
    if (!(await validateAdminSession(getAdminSid(request)))) {
      return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const dataUrl = String(body?.dataUrl ?? "");
    if (!dataUrl) {
      return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
    }

    const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif|avif|bmp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) {
      return NextResponse.json({ code: -1, message: "图片格式不支持（png/jpg/webp/gif/avif/bmp）" }, { status: 400 });
    }

    const mime = m[1] === "image/jpg" ? "image/jpeg" : m[1];
    const ext = Object.keys(MIME_BY_EXT).find((k) => MIME_BY_EXT[k] === mime) || "png";
    const buffer = Buffer.from(m[2], "base64");
    if (buffer.length === 0) {
      return NextResponse.json({ code: -1, message: "文件内容为空" }, { status: 400 });
    }

    const fileName = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}.${ext}`;
    await fs.mkdir(MATERIAL_DIR, { recursive: true });
    await fs.writeFile(path.join(MATERIAL_DIR, fileName), buffer);

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
