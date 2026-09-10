import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { getActiveSessionFromCookie, getSessionCookieName } from "@/lib/auth/session";
import { ensureValidCredential } from "@/lib/bilibili/cookie-refresh";
import { fetchBilibiliJson } from "@/lib/bilibili/client";

export const dynamic = "force-dynamic";

// ===== XHR 端 Wbi 签名（用于人气红包接口） =====

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let cachedMixinKey: { key: string; ts: number } | null = null;

function getMixinKey(raw: string): string {
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function fetchMixinKey(): Promise<string> {
  if (cachedMixinKey && Date.now() - cachedMixinKey.ts < 25 * 60 * 1000) {
    return cachedMixinKey.key;
  }
  const data = await fetchBilibiliJson<{
    code: number;
    data?: { wbi_img: { img_url: string; sub_url: string } };
  }>({ url: "https://api.bilibili.com/x/web-interface/nav", live: true });
  const imgKey = data.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] ?? "";
  const subKey = data.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] ?? "";
  if (!imgKey || !subKey) throw new Error("获取 Wbi 密钥失败");
  const key = getMixinKey(imgKey + subKey);
  cachedMixinKey = { key, ts: Date.now() };
  return key;
}

async function signWbiParams(params: Record<string, string>): Promise<Record<string, string>> {
  const mixinKey = await fetchMixinKey();
  const wts = String(Math.floor(Date.now() / 1000));
  const signed: Record<string, string> = { ...params, wts };
  const chrFilter = /[!'()*]/g;
  const query = Object.keys(signed)
    .sort()
    .map((k) => {
      let v = signed[k];
      if (typeof v === "string") v = v.replace(chrFilter, "");
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join("&");
  const w_rid = createHash("md5").update(query + mixinKey).digest("hex");
  return { ...signed, w_rid };
}

const RED_POCKET_STATISTICS = JSON.stringify({ appId: 1, version: "9.8.0", abtest: "", platform: 3 });

/**
 * POST /api/lottery/redpocket
 * Body: { _action: "check"|"draw", room_id: number, lot_id?: number }
 * 需登录。复用服务端登录凭证直连 B站 人气红包接口。
 */
export async function POST(request: NextRequest) {
  let body: { _action?: string; room_id?: unknown; lot_id?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: -1, message: "请求参数错误" }, { status: 400 });
  }
  const action = body._action;
  const roomId = Number(body.room_id);
  if (!roomId) {
    return NextResponse.json({ code: -1, message: "缺少 room_id" }, { status: 400 });
  }

  const cookieHeader = request.headers.get("cookie") ?? "";
  let sid = cookieHeader.match(new RegExp(`${getSessionCookieName()}=([^;]+)`))?.[1] ?? null;
  if (!sid) sid = request.nextUrl.searchParams.get("_sid") ?? null;
  const session = await getActiveSessionFromCookie(sid);
  if (!session) return NextResponse.json({ code: -1, message: "未登录" });

  const cred = await ensureValidCredential(session);
  if (!cred.valid) return NextResponse.json({ code: -1, message: "登录凭证失效" });
  const csrf = cred.cookie.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
  if (!csrf) return NextResponse.json({ code: -1, message: "未找到 csrf" });

  try {
    if (action === "check") {
      const signed = await signWbiParams({
        csrf,
        mobi_app: "android",
        platform: "android",
        room_id: String(roomId),
        statistics: RED_POCKET_STATISTICS,
        web_location: "444.248",
      });
      const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketActiveList?${new URLSearchParams(signed).toString()}`;
      const result = await fetchBilibiliJson<{ code: number; data?: { list: { lot_status?: number }[] } }>({ url, cookie: cred.cookie, live: true });
      if (result.code !== 0) return NextResponse.json({ code: result.code, data: null });
      const red_pockets = (result.data?.list ?? []).filter((item) => item.lot_status === 1);
      return NextResponse.json({ code: 0, data: { red_pockets } });
    }

    if (action === "draw") {
      const lotId = Number((body as Record<string, string>).lot_id);
      const roomId = Number((body as Record<string, string>).room_id);
      const ruid = Number((body as Record<string, string>).ruid);
      const uid = Number(cred.cookie.match(/DedeUserID=(\d+)/i)?.[1] ?? 0);
      if (!lotId) return NextResponse.json({ code: -1, message: "缺少 lot_id" }, { status: 400 });
      const signed = await signWbiParams({
        csrf,
        mobi_app: "android",
        platform: "android",
        statistics: RED_POCKET_STATISTICS,
      });
      const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketDraw?${new URLSearchParams(signed).toString()}`;
      const buvid = cred.cookie.match(/buvid3=([^;]+)/i)?.[1] ?? "";
      const requestBody = JSON.stringify({
        uid,
        room_id: roomId,
        ruid,
        lot_id: lotId,
        spm_id: "live.live-room-detail.red-envelope.extract",
        jump_from: "27007",
        session_id: "-99998",
        statistics: JSON.stringify({ appId: 0, platform: 3, version: "9.8.0", abtest: "" }),
        live_statistics: JSON.stringify({
          pc_client: "pink", jumpfrom: "-99998", source_event: "0", room_category: "0",
          official_channel: "-99998", screen_status: "-99998", room_id: "-99998", up_id: "-99998",
          parent_area_id: "-99998", area_id: "-99998", live_status: "-99998", spm_id: "-99998",
          session_id: "-99998", launch_id: "-99998", simple_id: "-99998", av_id: "-99998",
          flow_extend: "-99998", bussiness_extend: "-99998", data_extend: "-99998",
          trackid: "-99998", action_id: "-99998", user_status: "2", buvid,
        }),
      });
      const result = await fetchBilibiliJson<{ code: number; message?: string; data?: unknown }>({
        url,
        method: "POST",
        body: requestBody,
        json: true,
        cookie: cred.cookie,
        live: true,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json({ code: -1, message: "未知 action" });
  } catch (err) {
    console.error("[RedPocket] 红包操作失败:", err);
    return NextResponse.json({ code: -1, message: "红包操作失败" }, { status: 500 });
  }
}