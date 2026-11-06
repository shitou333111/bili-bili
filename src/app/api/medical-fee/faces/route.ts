import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { fetchAnchorInfo } from "@/lib/micro-light";

export const dynamic = "force-dynamic";

const FACE_FILE = path.join(process.cwd(), ".data", "medical-fee", "faces.json");
const FACE_TTL = 7 * 24 * 3600 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type FaceEntry = { uid: number; uname: string; face: string; at: number };
type FaceFile = { users: Record<string, FaceEntry> };

let cache: FaceFile | null = null;
let writeTimer: NodeJS.Timeout | null = null;

async function loadCache(): Promise<FaceFile> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(FACE_FILE, "utf-8")) as FaceFile;
    cache = parsed && typeof parsed.users === "object" ? parsed : { users: {} };
  } catch {
    cache = { users: {} };
  }
  return cache;
}

/** 合并写回磁盘（延迟 2 秒，避免一批请求频繁写文件） */
function scheduleFlush() {
  if (!cache || writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    try {
      const file = FACE_FILE;
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cache), "utf-8");
      await fs.rename(tmp, file);
    } catch {
      /* 忽略缓存落盘失败 */
    }
  }, 2000);
}

/** UID 兜底查询（B站个人名片） */
async function fetchCardFace(uid: number): Promise<{ uname: string; face: string }> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`, {
      headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" },
      cache: "no-store",
    });
    const json = (await res.json()) as { code?: number; data?: { card?: { name?: string; face?: string } } };
    if (json?.code === 0 && json.data?.card) {
      return { uname: String(json.data.card.name ?? ""), face: String(json.data.card.face ?? "") };
    }
  } catch {
    /* 忽略 */
  }
  return { uname: "", face: "" };
}

/**
 * GET /api/medical-fee/faces?items=uid:roomId,uid:roomId
 * 批量获取主播头像 / 昵称（服务端缓存 7 天），供 PK 记录徽章展示。
 */
export async function GET(request: NextRequest) {
  const items = (request.nextUrl.searchParams.get("items") ?? "")
    .split(",")
    .map((part) => {
      const [uid, roomId] = part.split(":");
      return { uid: Number(uid) || 0, roomId: Number(roomId) || 0 };
    })
    .filter((x) => x.uid > 0)
    .slice(0, 30);

  const file = await loadCache();
  const now = Date.now();
  const result: Record<string, { uname: string; face: string }> = {};

  const pending: Array<{ uid: number; roomId: number }> = [];
  for (const item of items) {
    const cached = file.users[String(item.uid)];
    if (cached && now - cached.at < FACE_TTL && cached.face) {
      result[String(item.uid)] = { uname: cached.uname, face: cached.face };
    } else {
      pending.push(item);
    }
  }

  // 限制并发 4，避免触发 B站限流
  let index = 0;
  async function worker() {
    while (index < pending.length) {
      const item = pending[index++];
      const info = item.roomId
        ? await fetchAnchorInfo(item.uid, item.roomId).catch(() => ({ uname: "", face: "" }))
        : { uname: "", face: "" };
      const merged = info.face ? info : await fetchCardFace(item.uid);
      if (merged.face || merged.uname) {
        file.users[String(item.uid)] = {
          uid: item.uid,
          uname: merged.uname,
          face: merged.face,
          at: now,
        };
        result[String(item.uid)] = { uname: merged.uname, face: merged.face };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (pending.length > 0) scheduleFlush();

  return NextResponse.json({ code: 0, data: result });
}
