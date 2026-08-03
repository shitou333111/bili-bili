import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieName, getSessionBySid } from "@/lib/auth/session";
import { ensureValidCredential, extractCookieValue } from "@/lib/bilibili/cookie-refresh";

export const dynamic = "force-dynamic";
type BiliModifyResponse = {
  code: number;
  message: string;
};

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

  const body = await request.json();
  const fids: number[] = body.fids;
  if (!Array.isArray(fids) || fids.length === 0) {
    return NextResponse.json({ code: -1, message: "参数错误：需要 fids 数组" });
  }

  // 从 cookies 中提取 bili_jct 作为 csrf token
  const csrf = extractCookieValue(session.biliCookies || [], "bili_jct");
  if (!csrf) {
    return NextResponse.json({ code: -1, message: "缺少 csrf token，请重新登录" });
  }

  const results: { fid: number; success: boolean; message: string }[] = [];

  const mid = session.mid;

  async function modifyRelation(fid: number, act: number): Promise<{ code: number; message: string }> {
    // 模拟浏览器请求：URL 带上 statistics 和 x-bili-device-req-json 参数
    const stats = encodeURIComponent(JSON.stringify({ appId: 100, platform: 5 }));
    const deviceReq = encodeURIComponent(JSON.stringify({ platform: "web", device: "pc", spmid: "333.1387" }));
    const url = `https://api.bilibili.com/x/relation/modify?statistics=${stats}&x-bili-device-req-json=${deviceReq}`;

    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://space.bilibili.com",
      "Referer": `https://space.bilibili.com/${mid}/relation/fans`,
      "Cookie": biliCookie,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: `fid=${fid}&act=${act}&re_src=11&csrf=${csrf}`,
      cache: "no-store",
    });

    const result = (await response.json()) as BiliModifyResponse;
    return { code: result.code, message: result.message };
  }

  for (let i = 0; i < fids.length; i++) {
    const fid = fids[i];
    try {
      // 尝试移除粉丝 (act=5)
      let result = await modifyRelation(fid, 5);

      // 如果失败(如已注销账号22013)，尝试 act=2(取关) 作为备选
      if (result.code !== 0) {
        console.log(`[remove-fan] fid=${fid} act=5 failed (${result.code}: ${result.message}), trying act=2`);
        await new Promise((r) => setTimeout(r, 300));
        const result2 = await modifyRelation(fid, 2);
        if (result2.code === 0) {
          result = { code: 0, message: "已通过取关移除" };
        }
        // 两种方式都失败了，返回 act=5 的原始错误
      }

      if (result.code !== 0) {
        console.log(`[remove-fan] fid=${fid} all methods failed: code=${result.code} msg=${result.message}`);
      }

      results.push({
        fid,
        success: result.code === 0,
        message: result.code === 0 ? "ok" : `${result.code}: ${result.message}`,
      });

      // 每次请求间隔 500ms 避免触发风控
      if (i < fids.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      console.error(`[remove-fan] fid=${fid} error:`, err);
      results.push({ fid, success: false, message: "网络请求失败" });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  return NextResponse.json({
    code: 0,
    message: `完成：${successCount}/${fids.length} 成功`,
    data: results,
  });
}