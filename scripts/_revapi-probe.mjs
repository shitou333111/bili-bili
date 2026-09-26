// 收益记录接口版本探测（临时脚本）
// 已知：v1 = xlive/revenue/v1/giftStream/getReceivedGiftStream（网页参数，限流极严 4req/s→412）
//       v3 = xlive/revenue/v3/giftStream/getReceivedGiftList（appkey 签名，限流宽松）
// 本脚本探测 v2 是否存在，并对比两种参数风格。
//
// 用法：node scripts/_revapi-probe.mjs

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const STORE = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "com.bili-live.app",
  "bili-live-state.json",
);

const APP_KEY = "1d8b6e7d45233436";
const APP_SECRET = "560c52ccd288fed045859ed18bffd973";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 os/android model/SM-G9910 build/8870400 osVer/13 sdkInt/33 network/2 BiliApp/8870400 mobi_app/android";
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function loadAccount() {
  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
  const s = raw.state.sessions.find(
    (x) => x.mid === 110934547 && Array.isArray(x.biliCookies) && x.biliCookies.length > 0,
  );
  const cookie = s.biliCookies.join("; ");
  const csrf = (s.biliCookies.find((c) => c.startsWith("bili_jct=")) ?? "").slice("bili_jct=".length);
  return { mid: s.mid, uname: s.uname, cookie, csrf };
}

function signParams(params) {
  const query = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return crypto.createHash("md5").update(query + APP_SECRET).digest("hex");
}

const today = new Date();
const bj = new Date(today.getTime() + (today.getTimezoneOffset() + 480) * 60000);
const y = new Date(bj.getTime() - 86400000);
const BEGIN = "20250801";
const END = `${y.getFullYear()}${String(y.getMonth() + 1).padStart(2, "0")}${String(y.getDate()).padStart(2, "0")}`;

/** v3 风格：appkey 签名的 POST(query)，需带 csrf（bili_jct） */
function signedUrl(base, extra) {
  const params = {
    actionKey: "appkey",
    appkey: APP_KEY,
    csrf: globalThis.__CSRF__ ?? "",
    csrf_token: globalThis.__CSRF__ ?? "",
    build: "8870400",
    c_locale: "zh-Hans_CN",
    channel: "oppo",
    device: "android",
    disable_rcmd: "0",
    mobi_app: "android",
    platform: "android",
    s_locale: "zh-Hans_CN",
    statistics: JSON.stringify({ appId: 1, platform: 3, version: "8.87.0", abtest: "" }),
    ts: Math.floor(Date.now() / 1000).toString(),
    version: "8.87.0",
    ...extra,
  };
  params.sign = signParams(params);
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function call(label, url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let summary = text.slice(0, 160).replace(/\s+/g, " ");
    if (res.status === 200) {
      try {
        const j = JSON.parse(text);
        const list = j.data?.list;
        summary = `code=${j.code} msg=${j.message} total=${j.data?.total ?? "-"} total_page=${j.data?.total_page ?? "-"} list=${Array.isArray(list) ? list.length : "-"}`;
      } catch {
        /* 保留原文 */
      }
    }
    console.log(`  [${label}] status=${res.status} ${summary}`);
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const acc = loadAccount();
  globalThis.__CSRF__ = acc.csrf;
  console.log(`账号 ${acc.mid} ${acc.uname}，区间 ${BEGIN}~${END}，csrf=${acc.csrf ? acc.csrf.slice(0, 8) + "…" : "(空!)"}\n`);

  const paths = [
    "https://api.live.bilibili.com/xlive/revenue/v2/giftStream/getReceivedGiftList",
    "https://api.live.bilibili.com/xlive/revenue/v2/giftStream/getReceivedGiftStream",
    "https://api.live.bilibili.com/xlive/revenue/v2/giftStream/getReceivedGiftStreamList",
  ];

  console.log("=== A. appkey 签名（GET，v3 风格参数）===");
  for (const base of paths) {
    const url = signedUrl(base, { page: "1", page_size: "20", begin_date: BEGIN, end_date: END });
    await call("signed", url, {
      method: "GET",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://live.bilibili.com/",
        Origin: "https://live.bilibili.com",
        Cookie: acc.cookie,
      },
    });
  }

  console.log("\n=== B. v1 风格表单参数（POST，网页 Cookie）===");
  for (const base of paths) {
    const body = [
      "page=1",
      "gift_id=0",
      `begin_date=${BEGIN}`,
      `end_date=${END}`,
      "uname=",
      "goods_id=",
      `csrf_token=${acc.csrf}`,
      `csrf=${acc.csrf}`,
    ].join("&");
    await call("v1body", base, {
      method: "POST",
      headers: {
        "User-Agent": WEB_UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://live.bilibili.com/",
        Origin: "https://live.bilibili.com",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: acc.cookie,
      },
      body,
    });
  }

  console.log("\n=== C. v3 用 POST（GET 返回 405）===");
  await call(
    "v3-POST",
    signedUrl("https://api.live.bilibili.com/xlive/revenue/v3/giftStream/getReceivedGiftList", {
      page: "1",
      page_size: "20",
      begin_date: BEGIN,
      end_date: END,
    }),
    {
      method: "POST",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://live.bilibili.com/",
        Origin: "https://live.bilibili.com",
        Cookie: acc.cookie,
      },
    },
  );

  console.log("\n=== D. v3 时间窗口上限（page_size=20）===");
  const windows = [
    ["122天", "20260526"],
    ["130天", "20260518"],
    ["140天", "20260508"],
    ["150天", "20260428"],
    ["160天", "20260418"],
  ];
  for (const [label, begin] of windows) {
    const url = signedUrl("https://api.live.bilibili.com/xlive/revenue/v3/giftStream/getReceivedGiftList", {
      page: "1",
      page_size: "20",
      begin_date: begin,
      end_date: END,
    });
    await call(`窗口${label} ${begin}`, url, {
      method: "POST",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://live.bilibili.com/",
        Origin: "https://live.bilibili.com",
        Cookie: acc.cookie,
      },
    });
  }

  console.log("\n=== E. v3 page_size 上限（窗口 31 天）===");
  for (const ps of ["20", "50", "100", "200"]) {
    const url = signedUrl("https://api.live.bilibili.com/xlive/revenue/v3/giftStream/getReceivedGiftList", {
      page: "1",
      page_size: ps,
      begin_date: "20260901",
      end_date: END,
    });
    await call(`page_size=${ps}`, url, {
      method: "POST",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "application/json, text/plain, */*",
        Referer: "https://live.bilibili.com/",
        Origin: "https://live.bilibili.com",
        Cookie: acc.cookie,
      },
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});