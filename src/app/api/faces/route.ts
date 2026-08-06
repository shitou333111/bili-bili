import { NextResponse } from "next/server";
import { getSendFansList } from "@/lib/user-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const midParam = url.searchParams.get("mid");
  const uname = url.searchParams.get("uname") || "";

  if (!midParam) {
    return NextResponse.json({ code: 0, message: "ok", data: {} }, { status: 200 });
  }

  const mid = Number(midParam);
  if (isNaN(mid) || mid <= 0) {
    return NextResponse.json({ code: 0, message: "ok", data: {} }, { status: 200 });
  }

  try {
    const data = await getSendFansList(mid, uname);
    return NextResponse.json({ code: 0, message: "ok", data }, { status: 200 });
  } catch {
    return NextResponse.json({ code: 0, message: "ok", data: {} }, { status: 200 });
  }
}