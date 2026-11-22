/**
 * B站 WBI 签名（浏览器/WebView/客户端共用）
 *
 * WBI 签名 = 参数按 key 排序编码后拼上 wts，再取 md5(query + mixinKey)。
 * mixinKey 由 nav 下发的 wbi_img 两个密钥（img_key/sub_key）按固定表打散得到。
 * 未签名/签名错误时接口返回 -352（风控拦截）。
 *
 * 调用方：抢福袋（lottery-client）、展示模块弹幕服务器 token（display/danmaku）。
 * 注意：服务端环境另有 lottery-scan 的独立实现（不依赖 Platform 抽象），此处不合并。
 */

import type { Platform } from "./platform";
import { md5 } from "./md5";

/** 官方前端固定的打散表，用于把 img_key+sub_key 还原成 32 位 mixin key */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

/** 默认缓存时长：wbi_img 每天轮换，25 分钟内复用足够安全 */
const DEFAULT_TTL_MS = 25 * 60 * 1000;

let cache: { imgKey: string; subKey: string; ts: number } | null = null;

/** 由 img_key + sub_key 计算 32 位 mixin key */
export function mixinKeyOf(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? "").join("").slice(0, 32);
}

/**
 * 取 nav 下发的 WBI 两个密钥（登录/匿名都会返回）。
 * 失败返回 null，由调用方决定回退策略；成功结果模块级缓存。
 */
export async function fetchWbiKeys(
  platform: Platform,
  opts: { cookie?: string; ttlMs?: number } = {},
): Promise<{ imgKey: string; subKey: string } | null> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (cache && Date.now() - cache.ts < ttl) return cache;
  try {
    const data = await platform.fetchBilibiliJson<{
      code: number;
      data?: { wbi_img?: { img_url: string; sub_url: string } };
    }>({
      url: "https://api.bilibili.com/x/web-interface/nav",
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      live: true,
    });
    const imgKey = (data?.data?.wbi_img?.img_url ?? "").split("/").pop()?.split(".")[0] ?? "";
    const subKey = (data?.data?.wbi_img?.sub_url ?? "").split("/").pop()?.split(".")[0] ?? "";
    if (!imgKey || !subKey) return null;
    cache = { imgKey, subKey, ts: Date.now() };
    return cache;
  } catch {
    return null;
  }
}

/** 签名失败（-352，密钥轮换/过期）时调用，强制下次重新取密钥 */
export function invalidateWbiKeys(): void {
  cache = null;
}

/** 参数按 key 排序并编码（值过滤 !'()*），不含 wts */
export function buildWbiQuery(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).replace(/[!'()*]/g, ""))}`)
    .join("&");
}

/** 生成带 wts + w_rid 的完整查询串（用于 GET 请求） */
export function wbiSignQuery(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
): string {
  const signed: Record<string, string | number> = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = buildWbiQuery(signed);
  return `${query}&w_rid=${md5(query + mixinKeyOf(imgKey, subKey))}`;
}
