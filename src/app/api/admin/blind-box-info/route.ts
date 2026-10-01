import { NextResponse } from "next/server";
import { validateAdminSession, getAdminSid } from "@/lib/auth/admin";
import { getActiveSessionFromCookie } from "@/lib/auth/session";
import { checkBlindBox } from "@/lib/bilibili/gift-api";
import { ensureGiftCatalogLoaded, getGiftImg } from "@/lib/gift-catalog";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/blind-box-info
 * admin 页面「从B站获取」盲盒信息：由服务器代替用户读取 B站 blindFirstWin/getInfo，
 * 把当期可查询盲盒的完整信息（名称/单价/礼物列表）回填到 admin 表单。
 *
 * Body: { gift_id: number, cookies?: string[] }
 * - cookies 优先（admin 页面传入当前 App 登录会话 Cookie）；
 *   缺失时回退服务器现存会话（可能非 admin 本人账号）。
 * - checkBlindBox 返回 null 表示已过期或不存在 → 404。
 */
export async function POST(request: Request) {
  if (!(await validateAdminSession(getAdminSid(request)))) {
    return NextResponse.json({ code: 403, message: "forbidden" }, { status: 403 });
  }

  let body: { gift_id?: unknown; cookies?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ code: 400, message: "请求体格式错误" }, { status: 400 });
  }

  const giftId = Number(body.gift_id);
  if (!giftId || giftId <= 0) {
    return NextResponse.json({ code: 400, message: "缺少有效 gift_id" }, { status: 400 });
  }

  // Cookie：body 优先，其次服务器现存会话兜底（不记录/不回显）
  const bodyCookies = Array.isArray(body.cookies)
    ? body.cookies.filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];
  let cookie = bodyCookies.join("; ");
  if (!cookie) {
    const session = await getActiveSessionFromCookie(null);
    if (session) {
      cookie = session.biliCookies?.join("; ") || `SESSDATA=${session.biliSessdata}`;
    }
  }
  if (!cookie) {
    return NextResponse.json({ code: 400, message: "缺少登录 Cookie，无法读取 B站盲盒信息" }, { status: 400 });
  }

  try {
    const result = await checkBlindBox(giftId, cookie);
    if (!result) {
      return NextResponse.json(
        { code: 404, message: "该盲盒已过期或不存在，无法从B站获取" },
        { status: 404 },
      );
    }

    await ensureGiftCatalogLoaded();

    return NextResponse.json({
      code: 0,
      message: "ok",
      data: {
        blind_box_id: giftId,
        name: result.blindGiftName,
        icon: getGiftImg(giftId) || "",
        blind_price: result.blindPrice,
        gifts: result.gifts.map((g) => ({
          gift_id: g.gift_id,
          gift_name: g.gift_name,
          price: g.price,
          gift_img: g.gift_img || getGiftImg(g.gift_id) || "",
        })),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { code: -1, message: err instanceof Error ? err.message : "读取B站盲盒信息失败" },
      { status: 500 },
    );
  }
}