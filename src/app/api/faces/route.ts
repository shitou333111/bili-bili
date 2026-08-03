import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const FACES_FILE = path.join(process.cwd(), ".data", "anchor-faces.json");

export async function GET() {
  try {
    const raw = await fs.readFile(FACES_FILE, "utf-8");
    const data = JSON.parse(raw);
    return NextResponse.json({ code: 0, message: "ok", data }, { status: 200 });
  } catch {
    return NextResponse.json({ code: 0, message: "ok", data: {} }, { status: 200 });
  }
}