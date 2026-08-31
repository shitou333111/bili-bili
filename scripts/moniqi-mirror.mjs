/**
 * moniqi-mirror.mjs
 *
 * 镜像抓取脚本（构建/部署时运行一次；纯 Node，无第三方运行时依赖）。
 *
 * 方案（极简，遵循"需要 mock 的走 mock，其余直连 B站"）：
 *   - 只抓取真实 B站 H5 的 index.html，原文保存，**不改写任何资源 URL**。
 *     页面自身引用的 JS/CSS/图片等静态资源仍由浏览器直连 B站 CDN（快、零改动）。
 *   - 把 mock-shim.js 复制到镜像目录，供 /moniqi 路由注入（在页面自身 origin 拦截
 *     api.live.bilibili.com 玩法接口并本地 mock 返回）。
 *   - 仅把 mock 返回数据里出现的受防盗链保护的图片（礼物图/档位图标/背景，来自
 *     mock-shim 源码与 admin-config.json 的 hdslb URL）下载到本地镜像，mock-shim 的
 *     res() 会把这类 URL 改写为本地镜像路径，避免破图。数量少（约百张），秒级完成。
 *
 * 产物写入 public/moniqi/mirror/<活动id>/，随仓库提交，供 /moniqi 路由渲染。
 *
 * 用法：node scripts/moniqi-mirror.mjs
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MIRROR_ROOT = path.join(ROOT, "public", "moniqi", "mirror");
const MOCK_SHIM_SRC = path.join(ROOT, "public", "native-inject", "mock-shim.js");
const ADMIN_CFG = path.join(ROOT, ".data", "admin-config.json");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

function mirrorDisk(id, absUrl) {
  const u = new URL(absUrl);
  return path.join(MIRROR_ROOT, id, u.host, ...u.pathname.split("/").filter(Boolean));
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://live.bilibili.com/" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.text();
}

/** 从 mock-shim 源码 + admin 配置中提取 hdslb 图片地址并下载落盘（mock 数据里的受保护图片） */
async function downloadMockImages(id) {
  const shim = await fs.readFile(MOCK_SHIM_SRC, "utf8");
  let cfg = "{}";
  try { cfg = JSON.stringify(JSON.parse(await fs.readFile(ADMIN_CFG, "utf8"))); } catch {}
  const re = /https?:\/\/[a-z0-9.\-]+\.hdslb\.com[^\s"'()<>]+?\.(?:png|jpe?g|gif|webp)\b/gi;
  const urls = new Set();
  for (const m of (shim + "\n" + cfg).matchAll(re)) {
    urls.add(m[0].replace(/[?#].*$/, "")); // 去掉 query/缓存参数，与 mock-shim res() 的匹配一致
  }
  let ok = 0;
  for (const u of urls) {
    try {
      const disk = mirrorDisk(id, u);
      await fs.mkdir(path.dirname(disk), { recursive: true });
      const r = await fetch(u, { headers: { "User-Agent": UA, Referer: "https://live.bilibili.com/" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await fs.writeFile(disk, Buffer.from(await r.arrayBuffer()));
      ok++;
    } catch (e) { console.warn("[mirror] 图片跳过", u, "->", e.message); }
  }
  return { total: urls.size, ok };
}

async function main() {
  let cfg;
  try { cfg = JSON.parse(await fs.readFile(ADMIN_CFG, "utf8")); }
  catch (e) { console.error("[mirror] 读取 admin 配置失败", e.message); process.exit(1); }
  const act = (cfg.simulator_activities || []).find((a) => a && a.enabled !== false);
  if (!act || !act.urlTemplate) {
    console.error("[mirror] 未找到启用的模拟器活动。"); process.exit(1);
  }
  const id = String(act.id || "activity");
  const url = act.urlTemplate
    .replace("{roomId}", String(act.roomId ?? 0))
    .replace("{uid}", String(act.uid ?? 0));
  const fetchUrl = url.replace(/#.*$/, "");
  console.log("[mirror] 活动 id =", id);
  console.log("[mirror] 抓取  ", fetchUrl);

  const html = await fetchText(fetchUrl);
  const htmlDisk = path.join(MIRROR_ROOT, id, "index.html");
  await fs.mkdir(path.dirname(htmlDisk), { recursive: true });
  await fs.writeFile(htmlDisk, html, "utf8");

  const shim = await fs.readFile(MOCK_SHIM_SRC, "utf8");
  await fs.writeFile(path.join(MIRROR_ROOT, id, "mock-shim.js"), shim, "utf8");

  const imgStat = await downloadMockImages(id);
  console.log("[mirror] mock 图片:", imgStat.ok + "/" + imgStat.total + " 下载完成");

  const meta = {
    id, url: fetchUrl, fetchedAt: new Date().toISOString(),
    // 注意：JS/CSS/静态图均未改写，仍直连 B站 CDN；仅 mock 返回的图片走本地镜像
    mockImages: imgStat.ok,
  };
  await fs.writeFile(path.join(MIRROR_ROOT, id, "mirror.json"), JSON.stringify(meta, null, 2), "utf8");
  console.log("[mirror] 完成。入口产物:", htmlDisk);
}

main().catch((e) => { console.error("[mirror] 失败", e); process.exit(1); });
