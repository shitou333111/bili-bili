// 消费记录（payRecord）风控压测脚本（临时脚本，仅供本次测试使用）
//
// 目的：验证 xlive/revenue/v2/giftStream/payRecord 的限流特性，并模拟
// "所有用户经由同一台服务器出口 IP 访问消费记录" 的真实场景。
//
// 子命令：
//   probe                          每个账号各发 1 次请求，验证 Cookie 是否有效
//   single <rate> <seconds>        单账号，全局节拍 <rate> req/s，跑到 seconds 或首次 412
//   multi  <rate> <seconds>        多账号轮询，全局节拍 <rate> req/s（模拟服务器统一出口）
//
// 用法示例：
//   node scripts/_paylimit-test.mjs probe
//   node scripts/_paylimit-test.mjs multi 3 180
//
// 结果追加写入 scripts/_paylimit.log

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const LOG = path.join(process.cwd(), "scripts", "_paylimit.log");
const STORE = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "com.bili-live.app",
  "bili-live-state.json",
);

const APP_KEY = "1d8b6e7d45233436";
const APP_SECRET = "560c52ccd288fed045859ed18bffd973";
const PAGE_SIZE = 50;
const API = "https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord";
const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 os/android model/SM-G9910 build/8870400 osVer/13 sdkInt/33 network/2 BiliApp/8870400 mobi_app/android";

const HEADERS = {
  "User-Agent": MOBILE_UA,
  Accept: "application/json, text/plain, */*",
  Referer: "https://live.bilibili.com/",
  Origin: "https://live.bilibili.com",
};

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(LOG, stamped + "\n");
}

function signParams(params) {
  const query = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return crypto.createHash("md5").update(query + APP_SECRET).digest("hex");
}

function buildUrl(nextId) {
  const params = {
    actionKey: "appkey",
    appkey: APP_KEY,
    build: "8870400",
    c_locale: "zh-Hans_CN",
    channel: "oppo",
    coin_type: "gold",
    device: "android",
    disable_rcmd: "0",
    mobi_app: "android",
    page_size: String(PAGE_SIZE),
    platform: "android",
    s_locale: "zh-Hans_CN",
    statistics: JSON.stringify({ appId: 1, platform: 3, version: "8.87.0", abtest: "" }),
    ts: Math.floor(Date.now() / 1000).toString(),
    version: "8.87.0",
  };
  if (nextId) params.next_id = String(nextId);
  params.sign = signParams(params);
  const url = new URL(API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function loadAccounts() {
  const raw = JSON.parse(fs.readFileSync(STORE, "utf8"));
  const only = (process.env.PAY_TEST_MIDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.state.sessions
    .filter((s) => Array.isArray(s.biliCookies) && s.biliCookies.length > 0)
    .filter((s) => only.length === 0 || only.includes(String(s.mid)))
    .map((s) => ({ mid: s.mid, uname: s.uname, cookie: s.biliCookies.join("; ") }));
}

/** 单次请求：返回 {status, code, message, count}；412 时 status=412 且 code 为 null */
async function requestOnce(account, nextId) {
  const url = buildUrl(nextId);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Cookie: account.cookie }, signal: ctrl.signal, cache: "no-store" });
    const status = res.status;
    const text = await res.text();
    if (status !== 200) {
      return { status, code: null, message: text.slice(0, 120).replace(/\s+/g, " ") };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { status, code: null, message: "非 JSON 响应: " + text.slice(0, 120) };
    }
    const list = json.data?.list;
    return {
      status,
      code: json.code,
      message: json.message ?? "",
      count: Array.isArray(list) ? list.length : 0,
      nextId: Array.isArray(list) && list.length > 0 ? list[list.length - 1].id : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ==================== probe ====================
async function probe() {
  const accounts = loadAccounts();
  log(`=== probe：${accounts.length} 个账号各 1 次请求 ===`);
  for (const acc of accounts) {
    const r = await requestOnce(acc, undefined);
    log(`  ${acc.mid} ${acc.uname}: status=${r.status} code=${r.code} msg=${r.message} 本页=${r.count}`);
    await new Promise((res) => setTimeout(res, 1200));
  }
}

// ==================== diag：打印响应头（判断是否存在 CDN 缓存） ====================
async function diag() {
  const accounts = loadAccounts();
  const acc = accounts[0];
  const url = buildUrl(undefined);
  const res = await fetch(url, { headers: { ...HEADERS, Cookie: acc.cookie }, cache: "no-store" });
  log(`=== diag：status=${res.status} ===`);
  for (const [k, v] of res.headers.entries()) log(`  ${k}: ${v}`);
  const text = await res.text();
  log(`  body 前 200 字: ${text.slice(0, 200)}`);
}

// ==================== 主入口 ====================
async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);
  const accounts = loadAccounts();

  if (cmd === "probe") {
    await probe();
    return;
  }
  if (cmd === "diag") {
    await diag();
    return;
  }

  if (cmd !== "single" && cmd !== "multi") {
    console.log("用法: probe | single <rate> <seconds> | multi <rate> <seconds>");
    process.exit(1);
  }

  const rate = Number(a1);
  const seconds = Number(a2);
  if (!(rate > 0) || !(seconds > 0)) {
    console.log("rate / seconds 必须为正数");
    process.exit(1);
  }

  const mode = cmd === "multi" ? `multi(${accounts.length}账号轮询)` : "single";
  log(`=== 开始：mode=${mode} rate=${rate}req/s 时长=${seconds}s ===`);

  const interval = 1000 / rate;
  const startAt = Date.now();
  const endAt = startAt + seconds * 1000;
  let nextAt = startAt;
  let issued = 0;
  let ok = 0;
  let idx = 0;
  let first412At = null;
  let first412Issued = null;
  const perAccount = new Map();

  // 多个 worker 共享同一个全局节拍器（与生产端"单一速率参数"的设计一致）。
  // 单 worker 串行时受 RTT 限制只能到 ~9.5 req/s，所以测更高速率必须靠并发。
  const conc = Math.max(1, Number(process.env.PAY_TEST_CONC ?? "1"));
  let stopped = false;

  async function worker() {
    while (!stopped && Date.now() < endAt) {
      const now = Date.now();
      const at = Math.max(nextAt, now);
      nextAt = at + interval;
      const wait = at - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (Date.now() >= endAt || stopped) break;

      const acc = cmd === "multi" ? accounts[idx++ % accounts.length] : accounts[0];
      issued++;
      const seq = issued;
      let r;
      try {
        r = await requestOnce(acc, undefined);
      } catch (err) {
        r = { status: 0, code: null, message: String(err?.message ?? err) };
      }

      const key = String(acc.mid);
      perAccount.set(key, (perAccount.get(key) ?? 0) + 1);

      if (r.status === 412) {
        if (first412At === null) {
          first412At = Date.now();
          first412Issued = seq;
          log(`  !! 第 ${seq} 次请求命中 412（账号 ${acc.mid}），用时 ${((first412At - startAt) / 1000).toFixed(1)}s`);
        }
        stopped = true;
        return;
      }
      if (r.status === 200 && r.code === 0) {
        ok++;
      } else {
        log(`  ?#${seq} 账号 ${acc.mid}: status=${r.status} code=${r.code} msg=${r.message}`);
      }

      if (seq % 20 === 0) {
        const elapsed = (Date.now() - startAt) / 1000;
        log(`  进度：已发 ${issued} 次（成功 ${ok}）· 用时 ${elapsed.toFixed(0)}s · 实测 ${(issued / elapsed).toFixed(2)} req/s`);
      }
    }
  }

  log(`  并发度=${conc}`);
  await Promise.all(Array.from({ length: conc }, () => worker()));

  const elapsed = (Date.now() - startAt) / 1000;
  log(
    `=== 结束：${first412At === null ? "全程无 412" : `首次 412 于第 ${first412Issued} 次`} · ` +
      `总发出 ${issued} 次（成功 ${ok}）· 用时 ${elapsed.toFixed(1)}s · 实测速率 ${(issued / elapsed).toFixed(2)} req/s`,
  );
  log(`  各账号请求分布：${[...perAccount.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});