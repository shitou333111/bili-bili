import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { readAdminConfig, writeAdminConfig, type AdminConfig } from "@/lib/admin-config";

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
        recommended_anchors: [],
        real_activity_url: "",
        simulator_activities: [],
      },
    });
  }

  return NextResponse.json({
    code: 0,
    data: {
      current_activity_blind_box_ids: adminConfig.current_activity_blind_box_ids ?? [],
      blind_boxes: adminConfig.blind_boxes ?? [],
      synthesis_activities: adminConfig.synthesis_activities ?? [],
      recommended_anchors: adminConfig.recommended_anchors ?? [],
      real_activity_url: adminConfig.real_activity_url ?? "",
      simulator_activities: adminConfig.simulator_activities ?? [],
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
    if (!act.name) {
      return NextResponse.json({ code: 400, message: "每个活动必须填写活动名称（作为活动标识）" }, { status: 400 });
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
    synthesis_activities: body.synthesis_activities.map((a: any) => ({
      // 用活动名称作为活动标识（id），不再使用独立的 activity-n 输入框
      id: String(a.name || a.id || ""),
      active: a.active !== false,
      name: a.name ? String(a.name) : undefined,
      start_time: typeof a.start_time === "number" && a.start_time > 0 ? a.start_time : undefined,
      end_time: typeof a.end_time === "number" && a.end_time > 0 ? a.end_time : undefined,
      products: Array.isArray(a.products) ? a.products.map((p: any) => String(p || "")).filter(Boolean) : undefined,
      materials: Array.isArray(a.materials)
        ? a.materials.map((m: any) => String(m || "")).filter(Boolean)
        : undefined,
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
    real_activity_url: typeof body.real_activity_url === "string" ? body.real_activity_url : "",
    // 模拟器活动入口配置（含算法类型），按原样持久化
    simulator_activities: Array.isArray(body.simulator_activities)
      ? body.simulator_activities.map((a: any) => ({
          id: String(a.id || ""),
          title: String(a.title || ""),
          entryImage: String(a.entryImage || ""),
          urlTemplate: String(a.urlTemplate || ""),
          roomId: Number(a.roomId) || 0,
          uid: Number(a.uid) || 0,
          enabled: a.enabled !== false,
          algorithmType: String(a.algorithmType || "stone-gongfang"),
          algorithmParams: a.algorithmParams && typeof a.algorithmParams === "object"
            ? a.algorithmParams
            : {},
        }))
      : [],
  };

  await writeAdminConfig(config);

  return NextResponse.json({ code: 0, message: "配置已保存" });
}