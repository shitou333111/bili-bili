/**
 * 验证 B站 getReceivedGiftStream（主播收礼流水）接口的"缓存预热"机制：
 * 对同一个月份连续查询多次（默认两次、间隔数秒），观察是否出现
 * "第1次 total_page=0（空），间隔后第2次 total_page>0（有数据）"的现象。
 *
 * 用途：确认首次全量拉取时"有的月份返回 total_page=0 但其实有数据"的根因，
 *       是否为 B站 按查询触发的懒物化/结果缓存。
 *
 * 用法（PowerShell）：
 *   $env:BILI_COOKIE="SESSDATA=xxx;bili_jct=yyy" ; node scripts/test-giftstream-warmup.mjs 20260701 20260731
 *   可选第3个参数：两次查询间隔毫秒数（默认 8000）
 *   可选第4个参数：连续查询轮数（默认 2，即只查两次）
 *   可选第5个参数：查询页码（默认 0）
 *
 * 说明：
 *   - 只读接口，不写任何本地文件。
 *   - 必须选择"确认有收礼记录"的月份（如最近有礼物的上个月），否则两次都返回空，无法验证。
 *   - BILI_COOKIE 为 B站 登录态 Cookie，至少包含 SESSDATA 与 bili_jct（用作 csrf）。
 *   - 请求头与生产代码 src/app/api/anchor/gifts/route.ts 保持一致（桌面 Chrome 来源）。
 */

const GIFT_STREAM_API = "https://api.live.bilibili.com/xlive/revenue/v1/giftStream/getReceivedGiftStream";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
  "Content-Type": "application/x-www-form-urlencoded",
};

/** 从 Cookie 字符串中提取 bili_jct 值（用作 csrf） */
function extractCsrf(cookie) {
  const m = cookie.match(/bili_jct=([^;]+)/);
  return m ? m[1] : "";
}

/** 查询一页，返回解析后的响应体 */
async function queryPage(cookie, page, beginDate, endDate) {
  const csrf = extractCsrf(cookie);
  const body = [
    `page=${page}`,
    `gift_id=0`,
    `begin_date=${beginDate}`,
    `end_date=${endDate}`,
    `uname=`,
    `goods_id=`,
    `csrf_token=${csrf}`,
    `csrf=${csrf}`,
  ].join("&");

  const t0 = Date.now();
  const resp = await fetch(GIFT_STREAM_API, {
    method: "POST",
    headers: { ...HEADERS, Cookie: cookie },
    body,
  });
  const elapsed = Date.now() - t0;

  if (resp.status === 412) {
    return { httpStatus: 412, elapsed, code: "412", message: "限流", total_page: -1, total_count: -1, list_len: -1 };
  }
  let json;
  try {
    json = await resp.json();
  } catch {
    return { httpStatus: resp.status, elapsed, code: "parse-error", message: "响应非JSON", total_page: -1, total_count: -1, list_len: -1 };
  }

  const d = json?.data;
  return {
    httpStatus: resp.status,
    elapsed,
    code: json?.code,
    message: json?.message,
    ready: d?.ready,
    total_page: d?.total_page ?? -1,
    total_count: d?.total_count ?? -1,
    total_hamster: d?.total_hamster ?? -1,
    list_len: d?.list?.length ?? 0,
  };
}

function fmt(r) {
  return `HTTP=${r.httpStatus} code=${r.code} total_page=${r.total_page} total_count=${r.total_count} total_hamster=${r.total_hamster} list_len=${r.list_len} ready=${r.ready ?? "?"} 耗时=${r.elapsed}ms`;
}

async function main() {
  let cookie = (process.env.BILI_COOKIE || "").trim();
  // 容错：剥掉可能粘贴进来的首尾引号
  if ((cookie.startsWith('"') && cookie.endsWith('"')) || (cookie.startsWith("'") && cookie.endsWith("'"))) {
    cookie = cookie.slice(1, -1);
  }
  if (!cookie.includes("SESSDATA=")) {
    console.error("缺少 BILI_COOKIE 环境变量（必填，至少包含 SESSDATA= 和 bili_jct=）");
    console.error('示例：$env:BILI_COOKIE="SESSDATA=xxx;bili_jct=yyy" ; node scripts/test-giftstream-warmup.mjs 20260701 20260731');
    process.exit(1);
  }
  if (!cookie.includes("bili_jct=")) {
    console.error("BILI_COOKIE 中缺少 bili_jct=（接口需要它作为 csrf），请一并粘贴");
    process.exit(1);
  }
  // 非 ASCII 校验（SESSDATA 应为 base64 风格纯 ASCII）
  for (let i = 0; i < cookie.length; i++) {
    if (cookie.charCodeAt(i) > 127) {
      console.error("Cookie 中含非 ASCII 字符，请确认只粘贴 SESSDATA= 和 bili_jct= 等 ASCII 键值");
      process.exit(1);
    }
  }

  const args = process.argv.slice(2);
  const beginDate = args[0];
  const endDate = args[1];
  const intervalMs = Number(args[2]) || 8000;
  const rounds = Number(args[3]) || 2;
  const page = Number(args[4]) || 0;

  if (!/^\d{8}$/.test(beginDate || "") || !/^\d{8}$/.test(endDate || "")) {
    console.error("必须传 begin_date 和 end_date（YYYYMMDD 格式），例如：20260701 20260731");
    process.exit(1);
  }

  console.log(`开始验证缓存预热：${beginDate} ~ ${endDate}，page=${page}，连查 ${rounds} 次，间隔 ${intervalMs}ms`);
  console.log(`（请确认该月份确有收礼记录；否则两次都为空，无法验证预热机制）\n`);

  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (i > 0) {
      console.log(`等待 ${intervalMs}ms...`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const label = `第 ${i + 1} 次`;
    const r = await queryPage(cookie, page, beginDate, endDate);
    results.push(r);
    console.log(`${label.padEnd(6)}: ${fmt(r)}`);
  }

  console.log("\n===== 结论 =====");
  const first = results[0];
  const last = results[results.length - 1];
  if (first.total_page === 0 && last.total_page > 0) {
    console.log("✅ 命中缓存预热机制：第 1 次 total_page=0（空），间隔后第 2 次有数据。");
    console.log("   说明 B站 对该月份的统计结果是按需异步构建+缓存，首次查询返回空，重查返回全量。");
  } else if (first.total_page === 0 && last.total_page === 0) {
    console.log("⚠️ 两次都 total_page=0：可能是该月确实无收礼记录，或该月不在3年可查范围内，请换一个确定有礼物的月份重试。");
  } else if (first.total_page > 0) {
    console.log("ℹ️ 第 1 次就有数据：该月缓存已就绪，无法在本月观察到预热现象。");
    console.log("   可换一个更久以前、你确定有收礼记录且很少查询过的月份重试，更容易复现。");
  }
}

main().catch((err) => {
  console.error("脚本执行失败:", err?.message || err);
  process.exit(1);
});
