import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// 下载计数存储在 .data/downloads.json，该目录跨版本持久化保护。
// 生产环境（standalone）下 process.cwd() 为 SSH_TARGET_DIR/current，
// 其中的 .data 是符号链接指向 preserved/.data，因此计数不会丢失。
const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "downloads.json");

type Counts = Record<string, number>;

async function readCounts(): Promise<Counts> {
  try {
    const raw = await readFile(FILE, "utf-8");
    return JSON.parse(raw) as Counts;
  } catch {
    return {};
  }
}

async function writeCounts(counts: Counts): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  await writeFile(FILE, JSON.stringify(counts, null, 2), "utf-8");
}

// GET /api/downloads — 返回各平台累计下载次数
export async function GET() {
  const counts = await readCounts();
  return NextResponse.json(counts);
}

// POST /api/downloads — 记录一次下载，body: { platform: "windows"|"android"|"ios" }
export async function POST(req: NextRequest) {
  let body: { platform?: string };
  try {
    body = (await req.json()) as { platform?: string };
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const { platform } = body;
  if (!platform || !["windows", "android", "ios"].includes(platform)) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }

  const counts = await readCounts();
  counts[platform] = (counts[platform] ?? 0) + 1;
  await writeCounts(counts);

  return NextResponse.json({ platform, total: counts[platform] });
}