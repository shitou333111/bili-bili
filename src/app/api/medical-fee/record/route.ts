import { NextRequest, NextResponse } from "next/server";
import { upsertPayRecord, readMonthlyCounts } from "@/lib/medical-fee-store";

export const dynamic = "force-dynamic";

/**
 * POST /api/medical-fee/record
 * 自动上传/覆盖一条医药费发放记录（同一 pkId 以最后一次为准）。
 * body: { uid(操作者), pkId, pkStartAt, pkEndAt, payerUid, receiverUids, scores, names }
 * 金额由服务端按分数重新计算，客户端只负责指定收发角色。
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求格式错误" }, { status: 400 });
  }
  const r = body as Record<string, unknown>;
  const operatorUid = Number(r?.uid) || 0;
  const pkId = Number(r?.pkId) || 0;
  const pkStartAt = Number(r?.pkStartAt) || 0;
  const pkEndAt = Number(r?.pkEndAt) || 0;
  const payerUid = Number(r?.payerUid) || 0;
  const receiverUids = Array.isArray(r?.receiverUids)
    ? (r.receiverUids as unknown[]).map((v) => Number(v) || 0).filter((v) => v > 0)
    : [];
  const scores: Record<string, number> = {};
  if (r?.scores && typeof r.scores === "object") {
    for (const [key, value] of Object.entries(r.scores as Record<string, unknown>)) {
      if (!Number(key)) continue;
      scores[String(Number(key))] = Number(value) || 0;
    }
  }
  const names: Record<string, string> = {};
  if (r?.names && typeof r.names === "object") {
    for (const [key, value] of Object.entries(r.names as Record<string, unknown>)) {
      if (!Number(key)) continue;
      names[String(Number(key))] = String(value ?? "");
    }
  }

  if (!operatorUid || !pkId || !pkStartAt) {
    return NextResponse.json({ code: -1, message: "参数不完整" }, { status: 400 });
  }

  try {
    const record = await upsertPayRecord({
      operatorUid,
      pkId,
      pkStartAt,
      pkEndAt,
      payerUid,
      receiverUids,
      scores,
      names,
    });
    const counts = await readMonthlyCounts(operatorUid);
    return NextResponse.json({
      code: 0,
      data: {
        record,
        monthlyPaidCount: counts.paidCount,
        monthlyReceivedCount: counts.receivedCount,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "保存失败" },
      { status: 400 },
    );
  }
}
