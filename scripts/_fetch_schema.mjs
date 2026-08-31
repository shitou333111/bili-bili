/**
 * _fetch_schema.mjs —— 抓取活动页真实接口响应样板，固化成本地 JSON，供 mock-shim 复用。
 *
 * 用法：把有效 Cookie（含 SESSDATA/buvid3 等）写入环境变量 BILI_COOKIE，然后：
 *   $env:BILI_COOKIE="SESSDATA=...;buvid3=..." ; node scripts/_fetch_schema.mjs
 *
 * 产物：.data/mock-schema/<name>.json（仅用于 mock 结构参考，含真实返回体）
 * 注意：这是"抓一次 schema 样板"，之后浏览器运行只读本地 JSON，不再请求 B站。
 */
import { promises as fs } from "fs";
import path from "path";

const COOKIE = process.env.BILI_COOKIE || "";
if (!COOKIE) {
  console.error("[fetch] 请先设置环境变量 BILI_COOKIE（含 SESSDATA/buvid3）。");
  process.exit(1);
}
const OUT = path.resolve("scripts/../.data/mock-schema");
await fs.mkdir(OUT, { recursive: true });

// 抓取的目标接口（相对 host 路径 + 方法 + 是否带 body）
// 成名之路：act_id=110503 (FAME)，config_id=FCK6EHCX。页面实际以 config_id 调 chengming/base 接口，
// act_id 由 HalfInit 响应返回；userconsume/GetTodayCostTotal 则用 act_id。
const actId = 110503;
const configId = "FCK6EHCX";
const host = "https://api.live.bilibili.com";
const targets = [
  // 页面初始化（玩法专用）→ 用 config_id
  { name: "chengming-HalfInit",        url: `${host}/xlive/custom-activity-interface/general/chengming/HalfInit`,        params: { config_id: configId } },
  // 玩法状态 → 用 config_id
  { name: "chengming-GetGameState",    url: `${host}/xlive/custom-activity-interface/general/chengming/GetGameState`,    params: { config_id: configId } },
  // 玩法记录 → 用 config_id + 分页
  { name: "chengming-GetGameRecords",  url: `${host}/xlive/custom-activity-interface/general/chengming/GetGameRecords`,  params: { config_id: configId, page: 1, page_size: 5 } },
  // 活动通用初始化（壳/玩法可能用）→ 用 config_id
  { name: "baseActivity-ActivityHalfInit", url: `${host}/xlive/custom-activity-interface/baseActivity/ActivityHalfInit`, params: { config_id: configId } },
  // 用户信息 → 用 config_id
  { name: "baseActivity-GeneralGetUserInfo", url: `${host}/xlive/custom-activity-interface/baseActivity/GeneralGetUserInfo`, params: { config_id: configId } },
  // 奖励配置 → 用 config_id
  { name: "base-GetRewardConfigData",  url: `${host}/xlive/custom-activity-interface/base/GetRewardConfigData`,  params: { config_id: configId } },
  // 规则文档 → 用 config_id
  { name: "base-GetDocContent",        url: `${host}/xlive/custom-activity-interface/base/GetDocContent`,        params: { config_id: configId } },
  // 消费门禁 → 用 act_id
  { name: "userconsume-GetTodayCostTotal", url: `${host}/xlive/custom-activity-interface/component/userconsume/GetTodayCostTotal`, params: { act_id: actId } },
  // 钱包
  { name: "wallet-myWallet", url: `${host}/xlive/revenue/v1/wallet/myWallet`, params: {} },
  // kv-frontend（配置，可能各 appKey 不同，先抓一个）
  { name: "kv-frontend-appKey-333.1333", url: `https://api.bilibili.com/x/kv-frontend/namespace/data`, params: { appKey: "333.1333", nscode: "0", unlimit: "true" } },
  { name: "kv-frontend-appKey-445.25", url: `https://api.bilibili.com/x/kv-frontend/namespace/data`, params: { appKey: "445.25", nscode: "0", unlimit: "true" } },
];

function qs(params) {
  const sp = new URLSearchParams();
  for (const k in params) sp.set(k, params[k]);
  return sp.toString();
}

for (const t of targets) {
  const full = t.url + (qs(t.params) ? "?" + qs(t.params) : "");
  const fname = t.name.replace(/[^\w.-]+/g, "_") + ".json";
  try {
    const r = await fetch(full, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
        Referer: "https://live.bilibili.com/",
        Cookie: COOKIE,
        "Accept": "application/json, text/plain, */*",
      },
    });
    const body = await r.text();
    const file = path.join(OUT, fname);
    await fs.writeFile(file, JSON.stringify({ url: full, status: r.status, body }, null, 2), "utf8");
    console.log(`[fetch] ${t.name.padEnd(38)} -> ${r.status}  ${body.length}B  ${file}`);
  } catch (e) {
    console.log(`[fetch] ${t.name.padEnd(38)} -> ERROR ${e.message}`);
  }
}
console.log("—— done ——");