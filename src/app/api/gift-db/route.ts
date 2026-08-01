import { NextResponse } from "next/server";
import { loadGiftDb } from "@/lib/gift-db";

export async function GET() {
  try {
    const db = loadGiftDb();
    return NextResponse.json(
      { code: 0, message: "ok", data: db.gifts ?? {} },
      { status: 200 },
    );
  } catch (err: any) {
    return NextResponse.json(
      { code: 500, message: `获取礼物数据库失败: ${err?.message || String(err)}`, data: null },
      { status: 500 },
    );
  }
}