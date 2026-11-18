import { NextResponse } from "next/server";
import { applyLeaderboardReport } from "@/lib/leaderboard-store";
import {
  isLeaderboardView,
  isPeriodKey,
  type LeaderboardMetric,
  type LeaderboardPeriodKey,
  type LeaderboardReport,
  type LeaderboardReportCard,
  type LeaderboardView,
} from "@/lib/leaderboard-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 同一用户最短上报间隔（毫秒）。娱乐统计，仅做最基础的防抖 */
const MIN_INTERVAL_MS = 5_000;

const lastReportAt = new Map<string, number>();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求体不是合法 JSON" }, { status: 400 });
  }

  const payload = (body ?? {}) as Partial<LeaderboardReport>;
  const view = payload.view;
  if (!isLeaderboardView(view)) {
    return NextResponse.json({ code: -1, message: "view 非法" }, { status: 400 });
  }
  const uid = Number(payload.uid);
  if (!Number.isFinite(uid) || uid <= 0) {
    return NextResponse.json({ code: -1, message: "uid 非法" }, { status: 400 });
  }
  if (!Array.isArray(payload.cards) || payload.cards.length === 0) {
    return NextResponse.json({ code: -1, message: "cards 为空" }, { status: 400 });
  }

  const key = `${view}:${uid}`;
  const now = Date.now();
  const last = lastReportAt.get(key) ?? 0;
  if (now - last < MIN_INTERVAL_MS) {
    // 静默接受，避免客户端因节流反复重试
    return NextResponse.json({ code: 0, message: "throttled" });
  }
  lastReportAt.set(key, now);

  const name = String(payload.name ?? "").trim().slice(0, 40) || `UID ${uid}`;
  const face = typeof payload.face === "string" ? payload.face.slice(0, 500) : undefined;

  const cards: LeaderboardReportCard[] = [];
  for (const raw of payload.cards.slice(0, 60)) {
    if (!raw || typeof raw !== "object") continue;
    const card = String((raw as LeaderboardReportCard).card ?? "");
    const periodsObj = (raw as LeaderboardReportCard).periods;
    if (!card || !periodsObj || typeof periodsObj !== "object") continue;
    const periods: Partial<Record<LeaderboardPeriodKey, LeaderboardMetric>> = {};
    for (const [pKey, pVal] of Object.entries(periodsObj)) {
      if (!isPeriodKey(pKey) || !pVal || typeof pVal !== "object") continue;
      periods[pKey] = pVal as LeaderboardMetric;
    }
    if (Object.keys(periods).length === 0) continue;
    cards.push({ card, periods });
  }

  if (cards.length === 0) {
    return NextResponse.json({ code: -1, message: "没有可写入的卡片" }, { status: 400 });
  }

  try {
    await applyLeaderboardReport({ view: view as LeaderboardView, uid, name, face, cards });
    return NextResponse.json({ code: 0, message: "ok" });
  } catch (err) {
    console.error("[LeaderboardReport] 写入失败:", err);
    return NextResponse.json({ code: -1, message: "写入失败" }, { status: 500 });
  }
}
