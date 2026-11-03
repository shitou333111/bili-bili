import { NextRequest, NextResponse } from "next/server";
import {
  buildEntry,
  fetchAnchorInfo,
  fetchMultiPkRecords,
  monthKeyFor,
  monthlyWinCount,
  readConfig,
  readDraws,
  resolveRoomId,
  seasonIdFor,
} from "@/lib/micro-light";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const RECORDS_FILE = path.join(process.cwd(), ".data", "micro-light-records.json");

async function readLocks(): Promise<Record<string, { uid: number; drawId: string; at: string }>> {
  try {
    const raw = await fs.readFile(RECORDS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed?.locks && typeof parsed.locks === "object" ? parsed.locks : {};
  } catch {
    return {};
  }
}

/**
 * GET /api/micro-light/records?uid=<uid>
 * 返回该 UID 的多人 PK 记录（含资格状态）、本人抽奖记录、本月已中奖次数。
 * 全部数据由服务端按规则重新计算，不信任客户端。
 */
export async function GET(request: NextRequest) {
  const rawUid = request.nextUrl.searchParams.get("uid") ?? "";
  const uid = Number(rawUid.replace(/[^\d]/g, ""));
  if (!Number.isFinite(uid) || uid <= 0) {
    return NextResponse.json({ code: -1, message: "请填写正确的 B站 UID" }, { status: 400 });
  }

  const config = await readConfig();
  const roomId = await resolveRoomId(uid);
  if (!roomId) {
    return NextResponse.json({ code: -1, message: "未找到该 UID 的直播间，请确认 UID 是否正确" });
  }

  const seasonId = config.seasonAuto ? seasonIdFor() : config.seasonId;
  const month = monthKeyFor(Date.now() / 1000);
  const [anchor, records, draws, locks] = await Promise.all([
    fetchAnchorInfo(uid, roomId),
    fetchMultiPkRecords(uid, roomId, seasonId, month),
    readDraws(),
    readLocks(),
  ]);

  const now = Date.now();
  const entries = records
    .map((r) =>
      buildEntry(r, config, draws, locks, uid, anchor.uname, roomId, monthKeyFor(Number(r.pk_start_time) || 0), now),
    )
    // 流局 / 计划时长不足 30 分钟的记录直接不展示
    .filter((e) => e.state !== "void" && e.state !== "skipped")
    .sort((a, b) => b.startAt - a.startAt);

  const myDraws = draws
    .filter((d) => d.uid === uid)
    .sort((a, b) => new Date(b.drawnAt).getTime() - new Date(a.drawnAt).getTime());

  return NextResponse.json({
    code: 0,
    data: {
      uid,
      uname: anchor.uname,
      face: anchor.face,
      roomId,
      seasonId,
      month,
      enabled: config.enabled,
      monthlyWinCap: config.monthlyWinCap,
      monthlyWins: monthlyWinCount(draws, uid, month),
      entries,
      draws: myDraws,
      prizes: config.prizes.map((p) => ({ id: p.id, kind: p.kind, name: p.name, img: p.img ?? "", text: p.text })),
    },
  });
}
