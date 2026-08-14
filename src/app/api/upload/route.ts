/**
 * /api/upload
 * 
 * POST - 接收 Tauri 客户端上传的原始数据 JSON 文件
 * GET  - 管理员查看指定用户的数据（需要 admin session）
 * 
 * 数据存储结构：.data/uid_<mid>/  （只用 uid，昵称会变），与服务器收集账号共用同一规范目录
 *   每个用户的数据文件直接存储在该目录下
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { saveBlindBoxInfoIfMissing } from "@/lib/blind-box-db";
import { upsertUserInList } from "@/lib/user-data";
import { mergeGlobalRecords, type MedicalRecord } from "@/lib/medical-fee";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), ".data");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/** POST: 接收客户端上传的数据 */
export async function POST(request: NextRequest) {
  try {
    // 支持 JSON 和 FormData 两种上传方式
    const contentType = request.headers.get("content-type") || "";

    let mid: number;
    let uname: string;
    let files: Record<string, string>;

    if (contentType.includes("multipart/form-data")) {
      // FormData 方式（Tauri 客户端）
      const formData = await request.formData();
      mid = parseInt(formData.get("mid") as string);
      uname = formData.get("uname") as string || "";
      files = {};

      const fileEntries = formData.getAll("files");
      for (const entry of fileEntries) {
        if (entry instanceof File) {
          files[entry.name] = await entry.text();
        }
      }
    } else {
      // JSON 方式（Web 客户端）
      const body = await request.json();
      mid = body.mid;
      uname = body.uname;
      files = body.files ?? {};
    }

    if (!mid || !uname || Object.keys(files).length === 0) {
      return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
    }

    // 用户文件夹：规范目录 .data/uid_<mid>（只用 uid，昵称会变；客户端已按此结构上传）
    const userDir = path.join(DATA_DIR, `uid_${mid}`);
    await ensureDir(userDir);

    // 增量上传：只写本次携带的文件（客户端只会带"相比上次有更新"的文件），覆盖旧文件。
    // 例外（全局共享文件，不走用户文件夹）：
    //   - blindbox_info/<id>.json：公开数据，仅当全局文件不存在时写入，已存在则丢弃。
    // 注：礼物图标目录已改由各客户端直连 B站 giftConfig API 获取，不再上传 gift-db.json。
    for (const [filename, content] of Object.entries(files)) {
      const bbMatch = filename.match(/^blindbox_info\/(\d+)\.json$/);
      if (bbMatch) {
        await saveBlindBoxInfoIfMissing(Number(bbMatch[1]), content);
        continue;
      }
      // 医药费归档记录：合并进全局去重文件（不做跨用户目录写入，避免操作者篡改他人数据；
      // 去重保证同一局在全球范围内只有一条统一记录）。不写入本用户文件夹。
      if (filename === "medical-fee-records.json") {
        try {
          const parsed = JSON.parse(content);
          const incoming: MedicalRecord[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.records)
              ? parsed.records
              : [];
          await mergeGlobalRecords(incoming);
        } catch (err) {
          console.error("[Upload] 合并医药费记录失败:", err);
        }
        continue;
      }
      const filePath = path.join(userDir, filename);
      // 如果是 JSON 字符串，格式化后保存
      try {
        const parsed = JSON.parse(content);
        await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), "utf-8");
      } catch {
        await fs.writeFile(filePath, content, "utf-8");
      }
    }

    // 更新上传时间记录
    const metaPath = path.join(userDir, "_upload_meta.json");
    const meta = {
      mid,
      uname,
      last_upload: new Date().toISOString(),
      files: Object.keys(files).filter((f) => !f.startsWith("blindbox_info/")),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    // 维护使用用户表 users-list.json（uid/昵称/更新时间=当前）
    await upsertUserInList(mid, uname);

    console.log(`[Upload] 收到 ${uname}(uid:${mid}) 的数据: ${Object.keys(files).join(", ")}`);

    return NextResponse.json({ code: 0, message: "上传成功" });
  } catch (err) {
    console.error("[Upload] 上传失败:", err);
    return NextResponse.json({ code: -1, message: "上传失败" }, { status: 500 });
  }
}

/** GET: 获取指定用户上传的数据（管理员用） */
export async function GET(request: NextRequest) {
  try {
    // 校验管理员权限（通过 X-Admin-Sid 请求头 / admin_sid 查询串 / cookie 解析，兼容跨源）。
    // 注意：不能用 B站用户会话 cookie 校验，Tauri 跨源下该 cookie 不会随请求发送，会导致"未登录"。
    const isAdmin = await validateAdminSession(getAdminSid(request));
    if (!isAdmin) {
      return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });
    }

    const mid = parseInt(request.nextUrl.searchParams.get("mid") || "0");
    const uname = request.nextUrl.searchParams.get("uname") || "";

    if (!mid) {
      // 返回所有用户的上传元数据列表（读规范目录下的 _upload_meta.json）
      await ensureDir(DATA_DIR);
      const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
      const users: Array<{ mid: number; uname: string; last_upload: string }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const m = entry.name.match(/^uid_(\d+)$/);
        if (!m) continue;
        const metaPath = path.join(DATA_DIR, entry.name, "_upload_meta.json");
        try {
          const raw = await fs.readFile(metaPath, "utf-8");
          const meta = JSON.parse(raw);
          users.push({
            mid: meta.mid,
            uname: meta.uname,
            last_upload: meta.last_upload,
          });
        } catch {}
      }

      return NextResponse.json({ code: 0, data: { users } });
    }

    // 返回指定用户的数据文件（读规范每用户数据目录 .data/uid_<mid>/）。
    const userDir = path.join(DATA_DIR, `uid_${mid}`);
    const files: Record<string, string> = {};
    try {
      const fileNames = await fs.readdir(userDir);
      for (const name of fileNames) {
        if (name.startsWith("_")) continue; // 跳过元数据文件
        files[name] = await fs.readFile(path.join(userDir, name), "utf-8");
      }
    } catch {}

    // 附带全局盲盒信息（.data/blindbox_info，权威数据，含当前活动盲盒名称/单价/爆出礼物对照表）。
    // 盲盒信息是全局而非按用户存放，客户端切换服务器账号时需一并拉取，否则本地缺失时
    // 会因无 B站 Cookie 无法重新获取，导致显示"盲盒_<id>"、单价0。
    const blindboxInfo: Record<string, unknown> = {};
    try {
      const blindboxDir = path.join(process.cwd(), ".data", "blindbox_info");
      const names = await fs.readdir(blindboxDir);
      for (const name of names) {
        const match = name.match(/^(\d+)\.json$/);
        if (!match) continue;
        blindboxInfo[match[1]] = JSON.parse(await fs.readFile(path.join(blindboxDir, name), "utf-8"));
      }
    } catch {}

    return NextResponse.json({ code: 0, data: { files, blindboxInfo } });
  } catch (err) {
    console.error("[Upload] 读取数据失败:", err);
    return NextResponse.json({ code: -1, message: "读取失败" }, { status: 500 });
  }
}