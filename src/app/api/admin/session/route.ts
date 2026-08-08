import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const valid = await validateAdminSession(getAdminSid(request));
  return NextResponse.json({ code: 0, data: { valid } });
}