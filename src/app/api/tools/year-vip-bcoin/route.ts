import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential, extractCookieValue } from "@/lib/bilibili/cookie-refresh";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

type Json = { code: number; message: string; data?: unknown };

/** 年度大会员 B币 工具统一返回体（领取与兑换拆分为两个独立步骤） */
type YearVipData = {
  /** 是否为年度（及以上）大会员 */
  isYearVip: boolean;
  /** 本月 B币 权益可领取（未领取且满足条件） */
  claimable: boolean;
  /** 本月 B币 权益此前已领取 */
  alreadyClaimed: boolean;
  /** 本次实际领取成功 */
  claimed: boolean;
  /** 当前钱包内 B币 数量 */
  bpCount: number;
  /** 是否成功执行兑换 */
  exchanged: boolean;
  /** 本次兑换得到的电池数量 */
  goldCount: number;
};

const emptyData: YearVipData = {
  isYearVip: false,
  claimable: false,
  alreadyClaimed: false,
  claimed: false,
  bpCount: 0,
  exchanged: false,
  goldCount: 0,
};

type SessionResult = { res?: NextResponse; cookie?: string; csrf?: string };

/** 统一鉴权：解析会话、校验登录凭证、取 csrf */
async function buildSession(request: NextRequest): Promise<SessionResult> {
  const url = new URL(request.url);
  let sid = request.cookies.get(getSessionCookieName())?.value;
  if (!sid) sid = url.searchParams.get("_sid") ?? undefined;
  const session = await getSessionBySid(sid);
  if (!session) return { res: NextResponse.json({ code: -101, message: "未登录" }) };
  const cred = await ensureValidCredential(session);
  if (!cred.valid || !cred.cookie) {
    return { res: NextResponse.json({ code: -101, message: "登录凭证已失效，请重新扫码登录" }) };
  }
  const csrf = extractCookieValue(session.biliCookies || [], "bili_jct");
  if (!csrf) return { res: NextResponse.json({ code: -1, message: "缺少 csrf token，请重新登录" }) };
  return { cookie: cred.cookie, csrf };
}

type RequestJson = (
  target: string,
  opts: { method?: "GET" | "POST"; body?: string; origin: string; referer: string },
) => Promise<Json>;

function makeRequestJson(cookie: string): RequestJson {
  return async (target, opts) => {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Origin: opts.origin,
      Referer: opts.referer,
      Cookie: cookie,
    };
    if (opts.body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetch(target, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      cache: "no-store",
    });
    return (await response.json()) as Json;
  };
}

/** 查询大会员权益（B币 卡券状态：state 0=可领 1=已领 2=暂不可领） */
async function queryPrivilege(requestJson: RequestJson): Promise<{
  code: number;
  message?: string;
  isYearVip?: boolean;
  state?: number | null;
}> {
  const privilege = (await requestJson("https://api.bilibili.com/x/vip/privilege/my", {
    origin: "https://www.bilibili.com",
    referer: "https://www.bilibili.com/",
  })) as Json & {
    data?: {
      list?: { type: number; state: number }[];
      vip_status?: number;
      vip_type?: number;
      vip_is_annual?: boolean;
    };
  };
  if (privilege.code !== 0) {
    return { code: privilege.code, message: privilege.message || "获取大会员权益失败" };
  }
  const d = privilege.data ?? {};
  const isYearVip = d.vip_status === 1 && (d.vip_is_annual === true || d.vip_type === 2);
  const bcoin = (d.list ?? []).find((i) => i.type === 1);
  return { code: 0, isYearVip, state: bcoin ? bcoin.state : null };
}

/** 查询钱包 B币 数量 */
async function queryWalletBp(requestJson: RequestJson): Promise<number> {
  const wallet = (await requestJson(
    "https://api.live.bilibili.com/xlive/revenue/v1/wallet/myGoldWallet?need_bp=1&need_metal=1&platform=pc&bp_with_decimal=0&ios_bp_afford_party=0",
    { origin: "https://live.bilibili.com", referer: "https://live.bilibili.com/" },
  )) as Json & { data?: { new_bp?: string | number } };
  return wallet.code === 0 ? Number(wallet.data?.new_bp ?? 0) : 0;
}

/**
 * 年度大会员 B币 工具：领取（每月赠送）与兑换（全部 B币 → 电池）拆分为两个独立步骤。
 * - status：仅查询权益状态与钱包余额，无副作用
 * - claim：仅领取本月赠送的 B币（不再顺带兑换）
 * - exchange：把钱包内全部 B币 一次性兑换为电池（1 B币 = 1000 bp = 10 电池）
 */
async function handle(request: NextRequest, action: "status" | "claim" | "exchange") {
  const sess = await buildSession(request);
  if (sess.res) return sess.res;
  const requestJson = makeRequestJson(sess.cookie!);
  const csrf = sess.csrf!;

  try {
    const priv = await queryPrivilege(requestJson);
    if (priv.code !== 0) {
      return NextResponse.json({ code: priv.code, message: priv.message, data: { ...emptyData } });
    }
    if (!priv.isYearVip) {
      return NextResponse.json({ code: 0, message: "当前账号不是年度大会员", data: { ...emptyData } });
    }
    if (priv.state === null) {
      return NextResponse.json({
        code: 0,
        message: "未找到 B币 权益",
        data: { ...emptyData, isYearVip: true },
      });
    }
    const claimable = priv.state === 0;
    const alreadyClaimed = priv.state === 1;

    // 仅查询状态：不产生任何副作用
    if (action === "status") {
      const bpCount = await queryWalletBp(requestJson);
      return NextResponse.json({
        code: 0,
        message: alreadyClaimed ? "本月 B币 权益已领取" : claimable ? "本月 B币 权益可领取" : "本月 B币 权益暂不可领取",
        data: { ...emptyData, isYearVip: true, claimable, alreadyClaimed, bpCount },
      });
    }

    // 第一步：领取本月 B币 权益（type=1）
    if (action === "claim") {
      let claimed = false;
      if (claimable) {
        const receive = await requestJson("https://api.bilibili.com/x/vip/privilege/receive", {
          method: "POST",
          body: `type=1&csrf=${csrf}`,
          origin: "https://www.bilibili.com",
          referer: "https://www.bilibili.com/",
        });
        claimed = receive.code === 0;
        if (!claimed && receive.code !== 69801) {
          return NextResponse.json({
            code: receive.code,
            message: receive.message || "领取 B币 失败",
            data: { ...emptyData, isYearVip: true },
          });
        }
      }
      const bpCount = await queryWalletBp(requestJson);
      return NextResponse.json({
        code: 0,
        message: claimed
          ? `已领取本月 B币（钱包共 ${bpCount} B币）`
          : alreadyClaimed || claimed
            ? "本月 B币 权益已领取"
            : "本月 B币 权益暂不可领取",
        data: {
          ...emptyData,
          isYearVip: true,
          claimable,
          alreadyClaimed: alreadyClaimed || claimed,
          claimed,
          bpCount,
        },
      });
    }

    // 第二步：把钱包内全部 B币 兑换成电池
    const bpCount = await queryWalletBp(requestJson);
    if (!bpCount || bpCount <= 0) {
      return NextResponse.json({
        code: 0,
        message: "钱包内暂无 B币 可兑换",
        data: { ...emptyData, isYearVip: true, claimable, alreadyClaimed, bpCount: 0 },
      });
    }
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
    return NextResponse.json({
      code: 0,
      message: exchanged ? `已兑换 ${goldCount} 电池` : `兑换失败：${order.message || order.code}`,
      data: {
        ...emptyData,
        isYearVip: true,
        claimable,
        alreadyClaimed,
        bpCount,
        exchanged,
        goldCount: exchanged ? goldCount : 0,
      },
    });
  } catch (err) {
    console.error("[year-vip-bcoin] error:", err);
    return NextResponse.json({ code: -1, message: "请求失败", data: { ...emptyData } });
  }
}

/** GET：仅查询权益状态与钱包余额（无副作用） */
export async function GET(request: NextRequest) {
  return handle(request, "status");
}

/** POST：?action=claim 领取 / ?action=exchange 兑换 / 缺省（或其它值）仅查询状态 */
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("action");
  const action = raw === "claim" || raw === "exchange" ? raw : "status";
  return handle(request, action);
}
