/**
 * 实测 B站 payRecord 接口的 page_size 参数是否生效，以及对拉取速度的影响。
 *
 * 用途：生产代码将 page_size 从 20 提到 100，本脚本验证：
 *   1) B站 是否真的按 page_size 返回（还是固定返回默认值 20）
 *   2) 不同 page_size 下每页实际条数、请求次数与总耗时对比
 *
 * 用法（PowerShell）：
 *   $env:BILI_SESSDATA="你的SESSDATA" ; node scripts/test-payrecord-pagesize.mjs
 *   可选：传 page_size 列表，如 node scripts/test-payrecord-pagesize.mjs 20 50 100
 *
 * 说明：
 *   - 只读接口，不写任何本地文件。
 *   - 每档最多翻 maxPages 页（默认 30），避免测试过久。
 *   - 请求头与生产 pay-record-client 保持一致（Android 移动端 + live.bilibili.com 来源）。
 *   - 若 B站 忽略 page_size 固定返回 20 条/页，则两种参数下"每页条数/总耗时"应几乎相同。
 */

import { createHash } from "node:crypto";

const APP_KEY = "1d8b6e7d45233436";
const APP_SECRET = "560c52ccd288fed045859ed18bffd973";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 os/android model/SM-G9910 build/8870400 osVer/13 sdkInt/33 network/2 BiliApp/8870400 mobi_app/android",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};

const DEFAULT_SIZES = [20, 100];
const MAX_PAGES = 30; // 每档最多翻页数（测试用上限）
const RATE_LIMIT_COOLDOWN_MS = 30_000;

function signParams(params) {
  const sortedEntries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const query = sortedEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return createHash("md5").update(`${query}${APP_SECRET}`).digest("hex");
}

function buildUrl(cookie, pageSize, nextId) {
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
    page_size: String(pageSize),
    platform: "android",
    s_locale: "zh-Hans_CN",
    statistics: JSON.stringify({ appId: 1, platform: 3, version: "8.87.0", abtest: "" }),
    ts: Math.floor(Date.now() / 1000).toString(),
    version: "8.87.0",
  };
  if (nextId) params.next_id = String(nextId);
  params.sign = signParams(params);
  const url = new URL("https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function runPageSize(cookie, pageSize) {
  const startedAt = Date.now();
  let nextId;
  let totalRecords = 0;
  let pageCount = 0;
  let firstPageSize = 0; // 首页实际返回条数
  const perPageTimes = [];

  for (; pageCount < MAX_PAGES; pageCount++) {
    const url = buildUrl(cookie, pageSize, nextId);
    const t0 = Date.now();
    let resp;
    try {
      resp = await fetch(url, { method: "GET", headers: { ...HEADERS, Cookie: `SESSDATA=${cookie}` } });
    } catch (err) {
      console.error(`  [page_size=${pageSize}] 第 ${pageCount + 1} 页请求异常: ${err?.message || err}`);
      break;
    }
    const elapsed = Date.now() - t0;
    perPageTimes.push(elapsed);

    if (resp.status === 412) {
      console.log(`  [page_size=${pageSize}] 触发 412 限流，冷却 ${RATE_LIMIT_COOLDOWN_MS}ms 后重试`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_COOLDOWN_MS));
      pageCount--; // 不占页数配额
      continue;
    }

    let json;
    try {
      json = await resp.json();
    } catch {
      console.error(`  [page_size=${pageSize}] 第 ${pageCount + 1} 页响应非 JSON（HTTP ${resp.status}）`);
      break;
    }

    if (json.code !== 0 || !json.data?.list) {
      console.log(`  [page_size=${pageSize}] 业务错误停止: code=${json.code} msg=${json.message}`);
      break;
    }

    const list = json.data.list;
    if (firstPageSize === 0) firstPageSize = list.length;
    totalRecords += list.length;
    if (list.length === 0) break;

    const newNextId = json.data.params?.next_id;
    if (!newNextId || newNextId === nextId) break;
    nextId = newNextId;

    if (perPageTimes.length % 5 === 0) {
      console.log(`  [page_size=${pageSize}] 第 ${pageCount + 1} 页: ${list.length} 条，累计 ${totalRecords}，耗时 ${elapsed}ms`);
    }
  }

  const totalMs = Date.now() - startedAt;
  const avg = perPageTimes.length
    ? Math.round(perPageTimes.reduce((a, b) => a + b, 0) / perPageTimes.length)
    : 0;
  return { pageSize, pages: pageCount, totalRecords, firstPageSize, totalMs, avg, perPageTimes };
}

async function main() {
  let sessdata = (process.env.BILI_SESSDATA || "").trim();
  // 容错：用户可能在 PowerShell 里带了引号粘贴，剥掉首尾单双引号
  if (
    (sessdata.startsWith('"') && sessdata.endsWith('"')) ||
    (sessdata.startsWith("'") && sessdata.endsWith("'"))
  ) {
    sessdata = sessdata.slice(1, -1);
  }
  if (!sessdata) {
    console.error("缺少 BILI_SESSDATA 环境变量（必填，B站登录态 Cookie 的 SESSDATA 值）");
    process.exit(1);
  }
  // SESSDATA 应为纯 ASCII（base64 风格）；含非 ASCII 字符说明粘贴了错误内容，
  // undici 的 fetch 会直接抛 "Cannot convert argument to a ByteString" 错。
  for (let i = 0; i < sessdata.length; i++) {
    if (sessdata.charCodeAt(i) > 127) {
      console.error(
        `BILI_SESSDATA 第 ${i + 1} 个字符含非 ASCII 字符（U+${sessdata.charCodeAt(i).toString(16)}「${sessdata[i]}」），` +
          "请确认只粘贴 SESSDATA= 后面的值（形如 xxx%2Cyyy，纯英文字母/数字/%）",
      );
      process.exit(1);
    }
  }

  const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const targets = sizes.length > 0 ? sizes : DEFAULT_SIZES;

  console.log(`开始实测 page_size ∈ [${targets.join(", ")}]，每档最多翻 ${MAX_PAGES} 页`);
  const results = [];
  for (const size of targets) {
    console.log(`\n===== page_size = ${size} =====`);
    results.push(await runPageSize(sessdata, size));
  }

  console.log("\n\n===== 汇总对比 =====");
  for (const r of results) {
    let verdict = "—";
    if (r.firstPageSize > 0) {
      if (r.firstPageSize === r.pageSize) verdict = "✅ page_size 完全生效";
      else if (r.firstPageSize > 20) verdict = `🔶 部分生效（B站上限=${r.firstPageSize} 条/页）`;
      else verdict = "⚠️ 未生效（固定返回 20 条/页）";
    }
    console.log(
      `page_size=${r.pageSize.toString().padStart(4)} | 实际每页=${String(r.firstPageSize).padStart(4)}` +
        ` | 翻页=${String(r.pages).padStart(4)} | 累计记录=${String(r.totalRecords).padStart(6)}` +
        ` | 总耗时=${(r.totalMs / 1000).toFixed(1)}s | 平均每页=${r.avg}ms` +
        ` | ${verdict}`,
    );
  }
}

main().catch((err) => {
  console.error("测试失败:", err);
  process.exit(1);
});
