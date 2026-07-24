import { NextResponse } from "next/server";
import { validateAdminSession, getAdminCookieName } from "@/lib/auth/admin";
import { readState } from "@/lib/auth/session";

async function checkAdmin(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${getAdminCookieName()}=([^;]+)`));
  const sid = match?.[1] ?? null;
  return validateAdminSession(sid);
}

export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const state = await readState();
  // 按 mid 去重，保留最新的记录
  const seen = new Map<number, typeof state.sessions[0]>();
  for (const s of state.sessions) {
    const existing = seen.get(s.mid);
    if (!existing || new Date(s.updatedAt) > new Date(existing.updatedAt)) {
      seen.set(s.mid, s);
    }
  }
  const users = Array.from(seen.values()).map((s) => ({
    sid: s.sid,
    uname: s.uname,
    mid: s.mid,
    face: s.face,
    source: s.source,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    isCurrent: s.sid === state.currentSid,
  }));

  return NextResponse.json({ code: 0, data: { users, currentSid: state.currentSid } });
}
