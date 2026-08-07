/**
 * /api/upload
 * 
 * POST - 接收 Tauri 客户端上传的原始数据 JSON 文件
 * GET  - 管理员查看指定用户的数据（需要 admin session）
 * 
 * 数据存储结构：.data/uploads/uid_MID/  （只用 uid，昵称会变）
 *   每个用户的数据文件直接存储在该目录下
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { loadGiftDb, saveGiftDb } from "@/lib/gift-db";
import { upsertUserInList } from "@/lib/user-data";

export const dynamic = "force-dynamic";

const UPLOADS_DIR = path.join(process.cwd(), ".data", "uploads");

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

    // 用户文件夹用 uid_<mid>（只用 uid，昵称会变；客户端已按新结构上传）
    const userDir = path.join(UPLOADS_DIR, `uid_${mid}`);
    await ensureDir(userDir);

    // 增量上传：只写本次携带的文件（客户端只会带"相比上次有更新"的文件），覆盖旧文件
    for (const [filename, content] of Object.entries(files)) {
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
      files: Object.keys(files),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    // 维护使用用户表 users-list.json（uid/昵称/更新时间=当前）
    await upsertUserInList(mid, uname);

    console.log(`[Upload] 收到 ${uname}(uid:${mid}) 的数据: ${Object.keys(files).join(", ")}`);

    // 更新全局 gift-db.json：从上传的 pay-records.json 中提取礼物信息
    if (files["pay-records.json"]) {
      try {
        const payRecords = JSON.parse(files["pay-records.json"]);
        const records = payRecords.records || [];
        const giftMap = new Map<number, { gift_id: number; name: string; img: string }>();
        for (const r of records) {
          if (r.gift_id && r.gift_name && !giftMap.has(r.gift_id)) {
            giftMap.set(r.gift_id, { gift_id: r.gift_id, name: r.gift_name, img: r.gift_img || "" });
          }
        }
        if (giftMap.size > 0) {
          const db = loadGiftDb();
          if (!db.gifts) db.gifts = {};
          let changed = false;
          for (const g of giftMap.values()) {
            if (!db.gifts[g.gift_id] || !db.gifts[g.gift_id].img) {
              db.gifts[g.gift_id] = { name: g.name, img: g.img };
              changed = true;
            }
          }
          if (changed) {
            saveGiftDb(db);
            console.log(`[Upload] 更新 gift-db: 新增 ${giftMap.size} 个礼物信息`);
          }
        }
      } catch (err) {
        console.error("[Upload] 更新 gift-db 失败:", err);
      }
    }

    return NextResponse.json({ code: 0, message: "上传成功" });
  } catch (err) {
    console.error("[Upload] 上传失败:", err);
    return NextResponse.json({ code: -1, message: "上传失败" }, { status: 500 });
  }
}

/** GET: 获取指定用户上传的数据（管理员用） */
export async function GET(request: NextRequest) {
  try {
    // 验证管理员权限
    const cookieSid = request.cookies.get(getSessionCookieName())?.value;
    const session = await getActiveSessionFromCookie(cookieSid);
    if (!session) {
      return NextResponse.json({ code: -1, message: "未登录" }, { status: 401 });
    }

    const adminSid = request.cookies.get(getAdminCookieName())?.value ?? null;
    const isAdmin = await validateAdminSession(adminSid);
    if (!isAdmin) {
      return NextResponse.json({ code: -1, message: "无权限" }, { status: 403 });
    }

    const mid = parseInt(request.nextUrl.searchParams.get("mid") || "0");
    const uname = request.nextUrl.searchParams.get("uname") || "";

    if (!mid) {
      // 返回所有用户的上传元数据列表
      await ensureDir(UPLOADS_DIR);
      const dirs = await fs.readdir(UPLOADS_DIR);
      const users: Array<{ mid: number; uname: string; last_upload: string }> = [];

      for (const dir of dirs) {
        const metaPath = path.join(UPLOADS_DIR, dir, "_upload_meta.json");
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

    // 返回指定用户的数据文件（用 uid_<mid> 查找）
    const userDir = path.join(UPLOADS_DIR, `uid_${mid}`);
    await ensureDir(userDir);

    const files: Record<string, string> = {};
    try {
      const fileNames = await fs.readdir(userDir);
      for (const name of fileNames) {
        if (name.startsWith("_")) continue; // 跳过元数据文件
        const filePath = path.join(userDir, name);
        const content = await fs.readFile(filePath, "utf-8");
        files[name] = content;
      }
    } catch {}

    return NextResponse.json({ code: 0, data: { files } });
  } catch (err) {
    console.error("[Upload] 读取数据失败:", err);
    return NextResponse.json({ code: -1, message: "读取失败" }, { status: 500 });
  }
}