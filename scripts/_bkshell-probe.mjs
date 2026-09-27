// 主播流水（贝壳系统）接口探测（临时脚本）
// 目标：pay.bilibili.com/payplatform/cashier/bk/trans/list（B站 App H5 账单页接口）
// 验证：1) 无 access_key、仅 Cookie 是否可用；2) 能否翻页取到全部历史（>1 年）
//
// 用法：
//   node scripts/_bkshell-probe.mjs <mid> basic
//   node scripts/_bkshell-probe.mjs <mid> pages <maxPage>
//   node scripts/_bkshell-probe.mjs <mid> endtime
//   node scripts/_bkshell-probe.mjs <mid> body <jsonBody>

import fs from "node:fs";
import path from "node:path";

const STATE = path.join(process.cwd(), ".data", "web-login-state.json");

const API = "https://pay.bilibili.com/payplatform/cashier/bk/trans/list?build=9020300&mobi_app=android&platform=android";
const UA =
  "Mozilla/5.0 (Linux; Android 12; 23127PN0CC Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Mobile Safari/537.36 os/android model/23127PN0CC build/9020300 osVer/12 sdkInt/32 network/2 BiliApp/9020300 mobi_app/android channel/yingyongbao";

function loadAccount(mid) {
  const raw = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const s = raw.sessions.find((x) => x.mid === Number(mid));
  if (!s) throw new Error(`未找到 mid=${mid} 的会话`);
  return { mid: s.mid, uname: s.uname, cookie: (s.biliCookies ?? []).join("; ") };
}

function headers(acc) {
  return {
    "accept": "application/json, text/plain, */*",
    "app-key": "android64",
    "bili-http-engine": "ignet",
    "content-type": "application/json; charset=utf-8",
    "cookie": acc.cookie,
    "env": "prod",
    "native_api_from": "h5",
    "referer": "https://pay.bilibili.com/pay-v2/shell/bill",
    "user-agent": UA,
    "x-bili-mid": String(acc.mid),
    "x-bili-redirect": "1",
    "origin": "https://pay.bilibili.com",
  };
}

async function call(label, acc, body, { method = "POST" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(API, {
      method,
      headers: headers(acc),
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const status = res.status;
    const text = await res.text();
    let out = text.slice(0, 300).replace(/\s+/g, " ");
    try {
      const j = JSON.parse(text);
      out = JSON.stringify(j).slice(0, 600);
    } catch { /* 非 JSON */ }
    console.log(`\n[${label}] status=${status}`);
    console.log(out);
    return { status, text };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const [mid, cmd, a1] = process.argv.slice(2);
  if (!mid || !cmd) {
    console.log("用法: node scripts/_bkshell-probe.mjs <mid> <basic|pages|endtime|body> [args]");
    process.exit(1);
  }
  const acc = loadAccount(mid);
  console.log(`账号 ${acc.mid} ${acc.uname}`);

  const base = {
    currentPage: 1,
    pageSize: 20,
    endTime: "2026-10-01 00:00:00",
    sdkVersion: "1.5.6",
    traceId: Date.now(),
  };

  if (cmd === "basic") {
    await call("basic POST", acc, base);
    await call("basic GET(对照)", acc, null, { method: "GET" });
    return;
  }

  if (cmd === "body") {
    await call("自定义 body", acc, JSON.parse(a1));
    return;
  }

  if (cmd === "min") {
    const full = headers(acc);
    const sets = [
      ["仅 Cookie", { cookie: full.cookie }],
      ["Cookie+content-type", { cookie: full.cookie, "content-type": full["content-type"] }],
      ["+app-key", { cookie: full.cookie, "content-type": full["content-type"], "app-key": "android64" }],
      ["+ua+referer", { cookie: full.cookie, "content-type": full["content-type"], "app-key": "android64", "user-agent": UA, referer: full.referer }],
      ["全量", full],
    ];
    for (const [label, h] of sets) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ ...base, traceId: Date.now() }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        const text = await res.text();
        let summary = text.slice(0, 120).replace(/\s+/g, " ");
        try {
          const j = JSON.parse(text);
          summary = `code=${j.code} msg=${j.msg} totalCount=${j.data?.page?.totalCount}`;
        } catch { /* keep */ }
        console.log(`${label.padEnd(24)} status=${res.status} ${summary}`);
      } finally {
        clearTimeout(t);
      }
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    return;
  }

  if (cmd === "suite") {
    const variants = [
      ["default", {}],
      ["pageSize=200", { pageSize: 200 }],
      ["pageSize=500", { pageSize: 500 }],
      ["pageSize=1000", { pageSize: 1000 }],
      ["beginTime=2023", { beginTime: "2023-01-01 00:00:00" }],
      ["startTime=2023", { startTime: "2023-01-01 00:00:00" }],
      ["endTimeEmpty", { endTime: "" }],
      ["endTime=2025-10-01", { endTime: "2025-10-01 00:00:00" }],
      ["endTime=2025-10-01&pageSize=50", { endTime: "2025-10-01 00:00:00", pageSize: 50 }],
      ["page=8", { currentPage: 8 }],
    ];
    for (const [label, extra] of variants) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: headers(acc),
          body: JSON.stringify({ ...base, ...extra, traceId: Date.now() }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        const j = await res.json();
        const r = j.data?.result ?? [];
        const pg = j.data?.page ?? {};
        console.log(
          `${label.padEnd(26)} code=${j.code} totalCount=${pg.totalCount} totalPage=${pg.totalPage} 本页=${r.length} ${r[0]?.ctime ?? "-"} -> ${r[r.length - 1]?.ctime ?? "-"}`,
        );
      } finally {
        clearTimeout(t);
      }
      await new Promise((r2) => setTimeout(r2, 1200));
    }
    return;
  }

  if (cmd === "q") {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: headers(acc),
        body: JSON.stringify({ ...base, ...JSON.parse(a1), traceId: Date.now() }),
        signal: ctrl.signal,
        cache: "no-store",
      });
      const j = await res.json();
      const r = j.data?.result ?? [];
      const pg = j.data?.page ?? {};
      console.log(`code=${j.code} msg=${j.msg} totalCount=${pg.totalCount} totalPage=${pg.totalPage} 本页=${r.length} ${r[0]?.ctime ?? "-"} -> ${r[r.length - 1]?.ctime ?? "-"}`);
    } finally {
      clearTimeout(t);
    }
    return;
  }

  if (cmd === "dump") {
    const out = [];
    let totalCount = 0;
    let totalPage = 0;
    for (let p = 1; p <= 200; p++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let j;
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: headers(acc),
          body: JSON.stringify({ ...base, pageSize: 50, currentPage: p, traceId: Date.now() }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        j = await res.json();
      } finally {
        clearTimeout(t);
      }
      const r = j.data?.result ?? [];
      const pg = j.data?.page ?? {};
      totalCount = pg.totalCount ?? totalCount;
      totalPage = pg.totalPage ?? totalPage;
      if (!Array.isArray(r) || r.length === 0) break;
      out.push(...r);
      console.log(`page=${p}: ${r.length} 条  ${r[0].ctime} -> ${r[r.length - 1].ctime}`);
      if (p >= totalPage) break;
      await new Promise((r2) => setTimeout(r2, 800));
    }
    const file = path.join(process.cwd(), "scripts", `_bkshell-${acc.mid}.json`);
    fs.writeFileSync(file, JSON.stringify({ totalCount, totalPage, count: out.length, result: out }, null, 2), "utf8");
    console.log(`\n共抓取 ${out.length} 条（接口 totalCount=${totalCount}）-> ${file}`);
    // 按 label 汇总 + 按年汇总
    const byLabel = {};
    const byYear = {};
    for (const x of out) {
      byLabel[x.label] = (byLabel[x.label] ?? 0) + 1;
      const y = (x.ctime ?? "").slice(0, 4);
      byYear[y] = (byYear[y] ?? 0) + 1;
    }
    console.log("按类型:", JSON.stringify(byLabel));
    console.log("按年份:", JSON.stringify(byYear));
    console.log("字段样例:", JSON.stringify(out[0]));
    return;
  }

  if (cmd === "endtime") {
    const list = ["2026-10-01 00:00:00", "2025-10-01 00:00:00", "2024-04-01 00:00:00", "2023-01-01 00:00:00", "2020-01-01 00:00:00", ""];
    for (const et of list) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: headers(acc),
          body: JSON.stringify({ ...base, endTime: et, traceId: Date.now() }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        const j = await res.json();
        const r = j.data?.result ?? [];
        const pg = j.data?.page ?? {};
        console.log(`endTime="${et}" -> code=${j.code} totalCount=${pg.totalCount} totalPage=${pg.totalPage} 本页=${r.length} ${r[0]?.ctime ?? "-"} -> ${r[r.length - 1]?.ctime ?? "-"}`);
      } finally {
        clearTimeout(t);
      }
      await new Promise((r2) => setTimeout(r2, 1200));
    }
    return;
  }

  if (cmd === "pages") {
    const maxPage = Number(a1 ?? 5);
    let globalFirst = null;
    let globalLast = null;
    for (let p = 1; p <= maxPage; p++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      let j;
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: headers(acc),
          body: JSON.stringify({ ...base, currentPage: p, traceId: Date.now() }),
          signal: ctrl.signal,
          cache: "no-store",
        });
        j = await res.json();
      } finally {
        clearTimeout(t);
      }
      const list = j.data?.result ?? [];
      const pg = j.data?.page ?? {};
      if (!Array.isArray(list) || list.length === 0) {
        console.log(`page=${p}: 无数据，停止。累计 totalCount=${pg.totalCount ?? "-"} totalPage=${pg.totalPage ?? "-"}`);
        break;
      }
      const times = list.map((x) => x.ctime);
      globalFirst ??= times[0];
      globalLast = times[times.length - 1];
      console.log(`page=${p}: ${list.length} 条  ${times[0]} -> ${times[times.length - 1]}  (${list[list.length - 1].label}/${list[list.length - 1].title})`);
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    console.log(`\n覆盖总区间(本次翻页): ${globalFirst} -> ${globalLast}`);
    return;
  }

  console.log("未知子命令");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});