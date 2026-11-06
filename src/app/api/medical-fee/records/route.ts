import { NextRequest, NextResponse } from "next/server";
import { isFeeVoid, sortAnchors, FEE_VALID_HOURS } from "@/lib/medical-fee-calc";
import { feeMonthKey, readMonthlyCounts, readPayRecord } from "@/lib/medical-fee-store";
import {
  fetchAnchorInfo,
  fetchMultiPkRecords,
  monthKeyFor,
  readConfig,
  resolveRoomId,
  resolveUidsByRoomIds,
  seasonIdFor,
} from "@/lib/micro-light";

export const dynamic = "force-dynamic";

/**
 * GET /api/medical-fee/records?uid=<uid>
 * 返回该 UID 本月参与的、未流局的多人 PK 记录（含服务端已保存的发放记录）。
 * 有效期 2 小时：过期记录仍会展示（只读），但前端不能再修改/上传。
 */
export async function GET(request: NextRequest) {
  const uid = Number((request.nextUrl.searchParams.get("uid") ?? "").replace(/[^\d]/g, ""));
  if (!uid || uid <= 0) {
    return NextResponse.json({ code: -1, message: "请填写正确的 B站 UID" }, { status: 400 });
  }

  const roomId = await resolveRoomId(uid);
  if (!roomId) {
    return NextResponse.json({ code: -1, message: "未找到该 UID 的直播间，请确认 UID 是否正确" });
  }

  const config = await readConfig();
  const seasonId = config.seasonAuto ? seasonIdFor() : config.seasonId;
  const [anchor, records, counts] = await Promise.all([
    fetchAnchorInfo(uid, roomId),
    fetchMultiPkRecords(uid, roomId, seasonId),
    readMonthlyCounts(uid),
  ]);

  const nowMs = Date.now();
  const month = monthKeyFor(nowMs / 1000);

  // B站 other_match_list 的 uid 恒为 0，只有 room_id：需要反查 uid。
  // 只对有效期内的记录反查（过期记录只读展示，不参与发/收/群方案计算）。
  const roomIds: number[] = [];
  for (const rec of records) {
    const startAt = Number(rec.pk_start_time) || 0;
    if (startAt > 0 && nowMs - startAt * 1000 > FEE_VALID_HOURS * 3600 * 1000) continue;
    const others = Array.isArray(rec.other_match_list) ? rec.other_match_list : [];
    for (const o of others) roomIds.push(Number(o?.room_id) || 0);
  }
  const uidByRoom = await resolveUidsByRoomIds(roomIds);

  const entries = await Promise.all(
    records.map(async (rec) => {
      const startAt = Number(rec.pk_start_time) || 0;
      const endAt = Number(rec.pk_end_time) || 0;
      const expired = startAt > 0 && nowMs - startAt * 1000 > FEE_VALID_HOURS * 3600 * 1000;
      const others = Array.isArray(rec.other_match_list) ? rec.other_match_list : [];
      const anchors = sortAnchors([
        {
          uid,
          name: anchor.uname || String(uid),
          votes: Number(rec.pk_votes) || 0,
          roomId,
        },
        ...others.map((o) => ({
          uid: Number(o?.uid) || uidByRoom.get(Number(o?.room_id) || 0) || 0,
          name: String(o?.name ?? ""),
          votes: Number(o?.pk_votes) || 0,
          roomId: Number(o?.room_id) || 0,
        })),
      ]);

      const recordMonth = feeMonthKey(startAt);
      const saved = await readPayRecord(Number(rec.pk_id) || 0, recordMonth);
      return {
        pkId: Number(rec.pk_id) || 0,
        startAt,
        endAt,
        duration: endAt - startAt,
        participants: anchors.length,
        secondVotes: anchors[1]?.votes ?? 0,
        void: isFeeVoid(anchors),
        expired,
        // 过期记录保留全部主播（含 uid 未知的占位）用于展示人数；
        // 有效期内只保留能确定 uid 的主播，避免编辑时出现重复/无效 uid。
        anchors: expired ? anchors : anchors.filter((a) => a.uid > 0),
        saved: saved
          ? {
              payerUid: saved.payerUid,
              payerAmount: saved.payerAmount,
              receiverUids: saved.receiverUids,
              perPerson: saved.perPerson,
              scores: saved.scores,
              updatedAt: saved.updatedAt,
            }
          : null,
      };
    }),
  );

  return NextResponse.json({
    code: 0,
    data: {
      uid,
      uname: anchor.uname,
      face: anchor.face,
      roomId,
      month,
      validHours: FEE_VALID_HOURS,
      seasonId,
      monthlyPaidCount: counts.paidCount,
      monthlyReceivedCount: counts.receivedCount,
      entries: entries
        .filter((e) => e.pkId > 0 && !e.void)
        .sort((a, b) => b.startAt - a.startAt),
    },
  });
}
