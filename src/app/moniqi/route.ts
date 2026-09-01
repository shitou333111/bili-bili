import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readAdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

const MIRROR_ROOT = path.join(process.cwd(), "public", "moniqi", "mirror");

/**
 * /moniqi —— 活动模拟镜像页（公开、无密码、无入口路由）。
 *
 * 只渲染 admin 配置里第一条启用的模拟器活动：读取镜像抓取脚本(scripts/moniqi-mirror.mjs)
 * 生成的 index.html，向 <head> 注入 mock 配置与 mock-shim（这两者在镜像页自身 origin 上
 * 拦截 api.live.bilibili.com，本地返回模拟数据），实现"真实 B站 UI + 本地数据 + 不登录 + 不扣费"。
 */
export async function GET(req: Request) {
  const config = await readAdminConfig();
  const acts = (config?.simulator_activities || []).filter((a) => a && a.enabled !== false);
  const act = acts[0];

  if (!act || !act.id) {
    return new NextResponse(
      "<!doctype html><html><head><meta charset='utf-8'></head><body><h2>暂无模拟器活动</h2><p>请在 admin 配置中启用一个 simulator 活动后重新生成镜像。</p></body></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const id = String(act.id);

  // 真实 B站 外壳(live-activity-battle)从 window.location.search 读取 app_name / room_id / uid，
  // 找不到 app_name 会用空菜单触发 noApp 404（见 694.js 的 noApp 分支）。
  // 但地址栏要保持干净（用户要求只有 /moniqi）：不重定向，改为直接渲染，
  // 并在注入脚本里覆写 window.location.search/hash 的 getter，让外壳读到参数、
  // 同时用 history.replaceState 把地址栏清成 /moniqi。
  const tplMatch = act.urlTemplate?.match(/[?&]app_name=([^&]+)/);
  const tplAppName = tplMatch?.[1] || id;
  // 玩法(成名之路)用 config_id 调 chengming/* 接口：缺了它 halfInitial 返回 -400 → emptyTag=1 → 内容区空白。
  const cfgMatch = act.urlTemplate?.match(/[?&]config_id=([^&]+)/);
  const tplConfigId = String(cfgMatch?.[1] || act.algorithmParams?.config_id || "FCK6EHCX");
  // 外壳(694.js)用 location.hash 决定子活动路由：fans_autumn_2026 的玩法页在 play 子路由。
  // 若不保留该 hash，SPA 会落到默认 main 标签页，玩法内容区空白。
  const hashMatch = act.urlTemplate?.match(/#([^]*)/);
  const tplHash = hashMatch ? `#${hashMatch[1].trim()}` : "";

  // 兼容直接带参访问：query 可覆盖模板值；不带参访问时用模板值。
  const sp = new URL(req.url).searchParams;
  const appName = sp.get("app_name") || tplAppName;
  const configId = sp.get("config_id") || tplConfigId;
  const roomId = sp.get("room_id") || String(act.roomId ?? 0);
  const uid = sp.get("uid") || String(act.uid ?? 0);

  // 给外壳的完整 search / hash（地址栏加载完成后会被清理，但外壳加载期间需要真实参数）
  const fullSearch =
    `?app_name=${encodeURIComponent(appName)}&room_id=${encodeURIComponent(roomId)}` +
    `&uid=${encodeURIComponent(uid)}&config_id=${encodeURIComponent(configId)}`;
  const fullHash = tplHash;

  // 无参访问 /moniqi：渲染"壳页面"，用 540px 宽的 iframe 作为 B站 页面的手机视口。
  // 原因：B站 页面的 rem 与组件宽度都按 document.documentElement.clientWidth（=视口宽）计算，
  // 桌面浏览器视口太宽会导致内容溢出；iframe 视口=540 时 clientWidth=540、rem=54，一切自动正确。
  // 同时 iframe 内的参数与 hash 都在 iframe 里，外部地址栏永远是干净的 /moniqi。
  if (!sp.get("app_name")) {
    const frameSrc = `/moniqi${fullSearch}${fullHash}`;
    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="referrer" content="no-referrer"><title>活动模拟</title>` +
        `<style>html,body{margin:0;height:100%;background:#1b1533;overflow:hidden}` +
        `.frame-wrap{width:100%;height:100%;display:flex;justify-content:center}` +
        `iframe{width:540px;max-width:100vw;height:100vh;border:0;background:#342a85}` +
        `</style></head><body>` +
        `<div class="frame-wrap"><iframe src="${frameSrc}" title="活动模拟"></iframe></div>` +
        `</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }
  const htmlPath = path.join(MIRROR_ROOT, id, "index.html");
  let html: string;
  try {
    html = await fs.readFile(htmlPath, "utf8");
  } catch {
    return new NextResponse(
      `<!doctype html><html><head><meta charset='utf-8'></head><body><h2>镜像未生成</h2><p>活动「${act.title}」尚未抓取镜像，请先执行 <code>node scripts/moniqi-mirror.mjs</code>。</p></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // mock 配置：算法类型 + 活动参数（与 native 注入同构，shim 会合并到默认 CONFIG 之上）
  const mockConfig = {
    algorithmType: act.algorithmType || "stone-gongfang",
    ...(act.algorithmParams ?? {}),
  };

  const shimUrl = `/moniqi/mirror/${id}/mock-shim.js?v=3`;
  const injection =
    `<style>#__moniqi_badge__{position:fixed;top:8px;right:8px;z-index:2147483647;padding:3px 10px;` +
    `font:12px/1.6 -apple-system,'PingFang SC',sans-serif;color:#fff;background:rgba(0,0,0,.55);` +
    `border-radius:99px;pointer-events:none;user-select:none}` +
    // 桌面浏览器下保持 B站 原始 H5 窄屏宽度（flexible 脚本 rem=37.5 对应 526px），居中显示，
    // 避免 body 100% 宽导致背景铺满全屏。
    `html{background:#1b1533!important}` +
    `body{max-width:540px!important;margin:0 auto!important;min-height:100vh}` +
    // 成名之路玩法区的整页背景(activity_bg)由页面内联 background-size:100%（仅限宽高）设置，
    // 并以内联 background-image 引用 B站 CDN(https://i0.hdslb.com/bfs/live/048ae887…png)。
    // 但 B站 CDN 是黑名单式防盗链：背景图请求一旦携带 Referer(如 external Chrome 发送
    // localhost:3000 源)就返回 403 → 图片加载失败 → 玩法区背景透明，露出外壳深紫底(h5-bg，错误背景)。
    // 这里把 CDN 背景改为指向本地镜像(同源 localhost:3000，才无 Referer 防盗链问题)，用 !important
    // 覆盖内联 CDN 背景，并强制 background-size 铺满整个玩法区，保证任何浏览器/视口下都显示目标背景。
    `.road-to-fame-play{` +
    `background-image:url('/moniqi/mirror/${id}/img/activity_bg.png')!important;` +
    `background-size:cover!important;background-position:center!important;` +
    `background-repeat:no-repeat!important}` +
    `</style>` +
    `<meta name="robots" content="noindex,nofollow">` +
    // B站 hdslb CDN 为黑名单式防盗链：拒绝已知外部域 Referer(如 localhost:3000)，
    // 但无 Referer 的请求放行。注入 no-referrer 让页面所有子资源(UI 图/礼物图/背景图)
    // 都不带 Referer 直连 B站，即可正常显示，无需代理或本地改写。
    `<meta name="referrer" content="no-referrer">` +
    // 修复 B站 694.js(live-activity-battle 外壳)的自带 bug：它遇到协议相对地址(//s1.hdslb.com/…)时会
    // `new URL(t)` 单参调用，而无 base 的 new URL 必抛 "Invalid base URL"，导致活动无法挂载。
    // 此垫片把"协议相对且未携带 base"的 new URL 自动补成 https:，既绕过该 bug，又让 //s1.hdslb.com
    // 这类协议相对静态资源能裸连 CDN 加载，无需任何本地下载或改写。
    `<script>(function(){var N=window.URL;function S(u,b){if(typeof u==="string"&&u.indexOf("//")===0&&b==null)u="https:"+u;if(b!=null)return new N(u,b);return new N(u);}S.prototype=N.prototype;window.URL=S;})();</script>` +
    // 地址栏保持干净：外壳加载期间需要真实 query(已在 302 时带上)，等它读完后
    // 用 replaceState 清掉 query、只保留 hash，最终地址栏显示 /moniqi#/play。
    `<script>(function(){` +
    `var cleaned=false;` +
    `function clean(){try{history.replaceState(history.state,"","/moniqi"+location.hash);}catch(e){}}` +
    `setTimeout(function(){clean();cleaned=true;},2000);` +
    `window.addEventListener("hashchange",function(){if(cleaned)clean();});` +
    `})();</script>` +
    `<script>window.__BILI_MIRROR__=true;window.__BILI_MIRROR_PREFIX__="/moniqi/mirror/${id}";window.__BILI_ACTIVITY_MOCK_CONFIG__=${JSON.stringify(mockConfig)}</script>` +
    `<script src="${shimUrl}"></script>` +
    // 只显示玩法元素：把 .road-to-fame-play(成名之路玩法区)提升为全屏内容，
    // 隐藏 B站 外壳的 tab 栏/其他玩法等兄弟元素，让页面只呈现玩法本体。
    // 特例：含背景图（background / KV 横幅）的元素不隐藏，保证页面背景图片正常显示。
    `<script>(function(){` +
    `function isBg(c){try{` +
    `if(/background|kv-container/i.test(c.className))return true;` +
    `return c.querySelectorAll('[class*="background"],[class*="Background"]').length>0;` +
    `}catch(e){return false;}}` +
    `function isolate(el){try{` +
    `var n=el.parentElement;` +
    `while(n&&n!==document.body&&n!==document.documentElement){` +
    `Array.prototype.forEach.call(n.children,function(c){if(!el.contains(c)&&!c.contains(el)){if(isBg(c))return;try{c.style.display='none';}catch(e){}}});` +
    `n=n.parentElement;}` +
    `el.style.position='fixed';el.style.left='0';el.style.top='0';el.style.right='0';el.style.bottom='0';` +
    `el.style.width='100%';el.style.height='100%';el.style.maxWidth='100%';el.style.margin='0';` +
    `el.style.overflowY='auto';el.style.overflowX='hidden';` +
    // 不强制背景色：让成名之路玩法区自带的整页背景(activity_bg)正常显示。
    // 之前强制透明导致外壳的 KV 背景透出，出现错误的背景图。
    // 同时不给玩法区设超大 z-index（让弹窗/确认框能浮在其上层），按 DOM 顺序自然叠放。
    `}catch(e){}}` +
    `function apply(){var el=document.querySelector('.road-to-fame-play');if(el){isolate(el);}}` +
    `apply();` +
    `new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});` +
    `})();</script>`;

  const out = html
    .replace(/<\/head>/i, injection + "</head>")
    .replace(
      /<\/body>/i,
      `<div id="__moniqi_badge__">模拟演示 · 无真实消费</div></body>`
    );

  return new NextResponse(out, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}