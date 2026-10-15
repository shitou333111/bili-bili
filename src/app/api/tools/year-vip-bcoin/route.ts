import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential, extractCookieValue } from "@/lib/bilibili/cookie-refresh";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

type Json = { code: number; message: string; data?: unknown };

/** 领取年度大会员每月赠送的 B币，并一次性全部兑换为直播电池（1 B币 = 1000 bp = 10 电池） */
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  let sid = request.cookies.get(getSessionCookieName())?.value;
  if (!sid) sid = url.searchParams.get("_sid") ?? undefined;
  const session = await getSessionBySid(sid);
  if (!session) {
    return NextResponse.json({ code: -101, message: "未登录" });
  }

  const cred = await ensureValidCredential(session);
  if (!cred.valid || !cred.cookie) {
    return NextResponse.json({ code: -101, message: "登录凭证已失效，请重新扫码登录" });
  }
  const biliCookie = cred.cookie;

  const csrf = extractCookieValue(session.biliCookies || [], "bili_jct");
  if (!csrf) {
    return NextResponse.json({ code: -1, message: "缺少 csrf token，请重新登录" });
  }

  async function requestJson(
    target: string,
    opts: { method?: "GET" | "POST"; body?: string; origin: string; referer: string },
  ): Promise<Json> {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Origin": opts.origin,
      "Referer": opts.referer,
      "Cookie": biliCookie,
    };
    if (opts.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetch(target, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      cache: "no-store",
    });
    return (await response.json()) as Json;
  }

  const empty = {
    isYearVip: false,
    alreadyClaimed: false,
    claimed: false,
    bpCount: 0,
    goldCount: 0,
    exchanged: false,
  };

  try {
    // 1. 查询大会员卡券状态
    const privilege = (await requestJson("https://api.bilibili.com/x/vip/privilege/my", {
      origin: "https://www.bilibili.com",
      referer: "https://www.bilibili.com/",
    })) as unknown as Json & {
      data?: { list?: { type: number; state: number }[]; vip_status?: number; vip_type?: number; vip_is_annual?: boolean };
    };
    if (privilege.code !== 0) {
      return NextResponse.json({ code: privilege.code, message: privilege.message || "获取大会员权益失败", data: empty });
    }
    const d = privilege.data ?? {};
    const isYearVip = d.vip_status === 1 && (d.vip_is_annual === true || d.vip_type === 2);
    if (!isYearVip) {
      return NextResponse.json({ code: 0, message: "当前账号不是年度大会员", data: { ...empty } });
    }
    const bcoin = (d.list ?? []).find((i) => i.type === 1);
    if (!bcoin) {
      return NextResponse.json({ code: 0, message: "未找到 B币 权益", data: { ...empty, isYearVip: true } });
    }
    if (bcoin.state !== 0) {
      return NextResponse.json({
        code: 0,
        message: bcoin.state === 1 ? "本月 B币 权益已领取" : "本月 B币 权益暂不可领取",
        data: { ...empty, isYearVip: true, alreadyClaimed: bcoin.state === 1 },
      });
    }

    // 2. 领取 B币 权益（type=1）
    const receive = await requestJson("https://api.bilibili.com/x/vip/privilege/receive", {
      method: "POST",
      body: `type=1&csrf=${csrf}`,
      origin: "https://www.bilibili.com",
      referer: "https://www.bilibili.com/",
    });
    const claimed = receive.code === 0;
    const alreadyClaimed = receive.code === 69801;
    if (!claimed && !alreadyClaimed) {
      return NextResponse.json({
        code: receive.code,
        message: receive.message || "领取 B币 失败",
        data: { ...empty, isYearVip: true },
      });
    }

    // 3. 查询钱包 B币 数量
    const wallet = (await requestJson(
      "https://api.live.bilibili.com/xlive/revenue/v1/wallet/myGoldWallet?need_bp=1&need_metal=1&platform=pc&bp_with_decimal=0&ios_bp_afford_party=0",
      { origin: "https://live.bilibili.com", referer: "https://live.bilibili.com/" },
    )) as unknown as Json & { data?: { new_bp?: string | number } };
    const bpCount = wallet.code === 0 ? Number(wallet.data?.new_bp ?? 0) : 0;
    if (!bpCount || bpCount <= 0) {
      return NextResponse.json({
        code: 0,
        message: claimed ? "已领取 B币，钱包内暂无 B币 可兑换" : "本月 B币 权益已领取",
        data: { ...empty, isYearVip: true, alreadyClaimed, claimed },
      });
    }

    // 4. 一次性把全部 B币 兑换成电池
    const payBp = bpCount * 1000;
    const goldCount = bpCount * 10;
    const liveStatistics = encodeURIComponent(
      JSON.stringify({ pc_client: "pcWeb", jumpfrom: "-99998", room_category: "-99998", trackid: "-999998" }),
    );
    const statistics = encodeURIComponent(JSON.stringify({ platform: 0, pc_client: "pcWeb" }));
    const visitId = Math.random().toString(36).slice(2, 15).padEnd(13, "0");
    const order = await requestJson("https://api.live.bilibili.com/xlive/revenue/v1/order/createOrder", {
      method: "POST",
      body:
        `platform=pc&pay_bp=${payBp}&context_id=1931024777&context_type=11&goods_id=1&goods_num=1&goods_type=2` +
        `&ios_bp=0&common_bp=${payBp}&live_statistics=${liveStatistics}&statistics=${statistics}` +
        `&csrf_token=${csrf}&csrf=${csrf}&visit_id=${visitId}`,
      origin: "https://link.bilibili.com",
      referer: "https://link.bilibili.com/p/center/index",
    });

    const exchanged = order.code === 0;
    const parts: string[] = [];
    parts.push(claimed ? `领取 ${bpCount} B币` : "B币 权益已领取");
    parts.push(exchanged ? `兑换 ${goldCount} 电池` : `兑换失败：${order.message || order.code}`);
    return NextResponse.json({
      code: 0,
      message: parts.join("，"),
      data: {
        isYearVip: true,
        alreadyClaimed,
        claimed,
        bpCount,
        goldCount: exchanged ? goldCount : 0,
        exchanged,
      },
    });
  } catch (err) {
    console.error("[year-vip-bcoin] error:", err);
    return NextResponse.json({ code: -1, message: "请求失败", data: empty });
  }
}
