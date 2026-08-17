import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readAdminConfig, writeAdminConfig, validateActivityType, getValidActivityTypes, type AdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

async function checkAdmin(request: Request): Promise<boolean> {
  return validateAdminSession(getAdminSid(request));
}

export async function GET(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  // readAdminConfig() 自动回退到 .data/admin-config.default.json
  const adminConfig = await readAdminConfig();

  if (!adminConfig) {
    // 极端情况：主文件和默认模板都不存在
    return NextResponse.json({
      code: 0,
      data: {
        current_activity_blind_box_ids: [],
        blind_boxes: [],
        synthesis_activities: [],
        valid_activity_types: getValidActivityTypes(),
        recommended_anchors: [],
      },
    });
  }

  return NextResponse.json({
    code: 0,
    data: {
      current_activity_blind_box_ids: adminConfig.current_activity_blind_box_ids ?? [],
      blind_boxes: adminConfig.blind_boxes ?? [],
      synthesis_activities: adminConfig.synthesis_activities ?? [],
      valid_activity_types: getValidActivityTypes(),
      recommended_anchors: adminConfig.recommended_anchors ?? [],
    },
  });
}

export async function POST(request: Request) {
  if (!(await checkAdmin(request))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  const body = await request.json();

  if (!body.synthesis_activities || !Array.isArray(body.synthesis_activities)) {
    return NextResponse.json({ code: 400, message: "synthesis_activities must be an array" }, { status: 400 });
  }
  for (const act of body.synthesis_activities) {
    if (!act.id || !act.type || !act.record_url) {
      return NextResponse.json({ code: 400, message: "每个活动必须包含 id, type, record_url" }, { status: 400 });
    }
    if (!validateActivityType(act.type)) {
      return NextResponse.json({ code: 400, message: `无效的活动类型: ${act.type}，可选: ${getValidActivityTypes().join(", ")}` }, { status: 400 });
    }
  }

  if (!body.blind_boxes || !Array.isArray(body.blind_boxes)) {
    return NextResponse.json({ code: 400, message: "blind_boxes must be an array" }, { status: 400 });
  }

  const config: AdminConfig = {
    current_activity_blind_box_ids: Array.isArray(body.current_activity_blind_box_ids)
      ? body.current_activity_blind_box_ids.map(Number).filter((n: number) => n > 0)
      : [],
    blind_boxes: body.blind_boxes.map((b: { id: number; name: string; icon: string }) => ({
      id: Number(b.id),
      name: String(b.name || ""),
      icon: String(b.icon || ""),
    })),
    synthesis_activities: body.synthesis_activities.map((a: { id: string; type: string; info_url: string; record_url: string; active?: boolean }) => ({
      id: String(a.id),
      type: a.type,
      info_url: String(a.info_url),
      record_url: String(a.record_url),
      active: a.active !== false,
    })),
    recommended_anchors: Array.isArray(body.recommended_anchors)
      ? body.recommended_anchors.map((r: any) => ({
          uid: Number(r.uid),
          uname: String(r.uname || ""),
          face: r.face ? String(r.face) : undefined,
          room_id: Number(r.room_id) || 0,
          visible: r.visible !== false,
          order: Number(r.order) || 0,
        }))
      : [],
  };

  await writeAdminConfig(config);

  return NextResponse.json({ code: 0, message: "配置已保存" });
}