import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");

/**
 * 收款码上传/拉取
 * - POST body: { mid, uname, dataUrl }  dataUrl 为 data:image/...;base64,...
 *   解码后保存到 .data/uid_<mid>/qrcode.<ext>
 * - GET ?mid=<uid>   返回该用户已配置的收款码图片（未配置返回 404）
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const mid = Number(body?.mid);
    const uname = String(body?.uname ?? "");
    const dataUrl = String(body?.dataUrl ?? "");
    if (!mid || !dataUrl) {
      return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
    }
    // 解析 data URL
    const m = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/);
    if (!m) {
      return NextResponse.json({ code: -1, message: "图片格式不支持" }, { status: 400 });
    }
    const ext = m[1] === "image/jpeg" ? "jpg" : m[1].replace("image/", "");
    const buffer = Buffer.from(m[2], "base64");
    const userDir = path.join(DATA_DIR, `uid_${mid}`);
    await fs.mkdir(userDir, { recursive: true });
    // 清理旧的其它扩展名收款码，仅保留最新
    for (const cand of ["png", "jpg", "jpeg", "webp", "gif"]) {
      if (cand === ext) continue;
      try {
        await fs.unlink(path.join(userDir, `qrcode.${cand}`));
      } catch { /* 不存在则忽略 */ }
    }
    await fs.writeFile(path.join(userDir, `qrcode.${ext}`), buffer);
    // 记录昵称（供拉取时返回）
    try {
      await fs.writeFile(path.join(userDir, "qrcode-meta.json"), JSON.stringify({ uid: mid, uname, updatedAt: new Date().toISOString() }), "utf-8");
    } catch { /* 忽略 */ }
    return NextResponse.json({ code: 0, message: "上传成功" });
  } catch (err) {
    console.error("[Qrcode] 上传失败:", err);
    return NextResponse.json({ code: -1, message: "上传失败" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const mid = request.nextUrl.searchParams.get("mid");
  if (!mid) {
    return NextResponse.json({ code: -1, message: "缺少 mid 参数" }, { status: 400 });
  }
  const userDir = path.join(DATA_DIR, `uid_${mid}`);
  for (const ext of ["png", "jpg", "jpeg", "webp", "gif"]) {
    try {
      const buffer = await fs.readFile(path.join(userDir, `qrcode.${ext}`));
      const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch { /* 尝试下一个扩展名 */ }
  }
  return new NextResponse("not configured", { status: 404 });
}