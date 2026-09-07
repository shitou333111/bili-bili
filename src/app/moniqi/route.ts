import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readAdminConfig } from "@/lib/admin-config";

export const dynamic = "force-dynamic";

const MIRROR_ROOT = path.join(process.cwd(), "public", "moniqi", "mirror");

/* * "在哪一步停手最赚？"卡片数据：最优停止策略分析
 * 当前不同星座k个时，"现在收手"获得的奖励 vs "继续召唤"的最优期望收益(EV)。
 * 数据来自权威精确计算，固定在 moniqi 页面实现中。
 */
// [当前星座数k, 现在收手(电池), 最优继续EV(电池), 继续多出EV(电池)]
const SIM_ROWS: Array<[number, number, number, number]> = [
  [1, 50, 51, 1],
  [2, 100, 104, 4],
  [3, 200, 206, 6],
  [4, 500, 503, 3],
  [5, 1200, 1207, 7],
  [6, 3000, 3005, 5],
  [7, 8800, 8808, 8],
];

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

  // 玩法区隔离选择器：不同算法类型对应不同 DOM 容器（成名之路=.road-to-fame-play，
  // 星座回响/同数间隔合成=.heart-embed）。隔离时把该容器提升为全屏、隐藏外壳其余元素。
  const isolateSelector =
    act.algorithmType === "number_between_same" || /resonance/i.test(String(act.id))
      ? ".heart-embed"
      : ".road-to-fame-play";

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
  // 在哪一步停手最赚？" / "更多功能"按钮与卡片固定在壳页面底部（iframe 外），不遮挡游戏区。
  if (!sp.get("app_name")) {
    const frameSrc = `/moniqi${fullSearch}${fullHash}`;
    const costRows = SIM_ROWS.map(
      (r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="pos">+${r[3]}</td></tr>`
    ).join("");
    return new NextResponse(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<meta name="referrer" content="no-referrer"><title>活动模拟</title>` +
        `<link rel="icon" href="/orig_icon.png">` +
        `<style>` +
        `html,body{margin:0;height:100%;background:#1b1533;overflow:hidden}` +
        `body{display:flex;flex-direction:column}` +
        `.frame-wrap{flex:1;min-height:0;display:flex;justify-content:center}` +
        `iframe{width:540px;max-width:100vw;height:100%;border:0;background:#342a85}` +
        `.bar{flex:none;min-height:52px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px;padding:8px 12px;` +
        `background:rgba(16,12,36,.92);border-top:1px solid rgba(255,255,255,.08);` +
        `-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}` +
        `.badge{font:12px/1 -apple-system,'PingFang SC',sans-serif;color:rgba(255,255,255,.9);` +
        `padding:8px 14px;border:1px solid rgba(255,255,255,.22);border-radius:99px;` +
        `white-space:nowrap;display:inline-flex;align-items:center;gap:4px;` +
        `background:rgba(255,255,255,.08);flex-shrink:0}` +
        `.btn{font:12px/1 -apple-system,'PingFang SC',sans-serif;padding:8px 14px;border-radius:99px;` +
        `cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(255,255,255,.22);` +
        `color:#fff;background:rgba(255,255,255,.08);transition:transform .12s ease,background .2s ease;white-space:nowrap;flex-shrink:0}` +
        `.btn:active{transform:scale(.96)}` +
        `.btn-main{background:linear-gradient(135deg,#8a5cff,#5b8cff);border-color:transparent;font-weight:600}` +
        `.btn-home{background:linear-gradient(135deg,#4ecdc4,#44a08d);border-color:transparent}` +
        `.btn-fire{background:linear-gradient(135deg,#ff6b6b,#ee5a24);border-color:transparent}` +
        `.btn-fire-active{background:linear-gradient(135deg,#c0392b,#e74c3c);border-color:transparent;font-weight:600}` +
        `.mask{position:fixed;inset:0;background:rgba(8,6,22,.55);display:none;align-items:center;` +
        `justify-content:center;z-index:99}` +
        `.mask.show{display:flex}` +
        `.card{width:min(560px,92vw);max-height:82vh;overflow:auto;background:#fff;color:#111;` +
        `border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.45);padding:20px 22px 16px;` +
        `box-sizing:border-box}` +
        `.card h3{margin:0 0 12px;font:600 17px/1.4 -apple-system,'PingFang SC',sans-serif;` +
        `display:flex;align-items:center;justify-content:space-between}` +
        `.card .close{cursor:pointer;width:28px;height:28px;border-radius:50%;display:flex;` +
        `align-items:center;justify-content:center;color:#999;font-size:15px}` +
        `.card .close:hover{background:#f0f0f5;color:#555}` +
        `table{width:100%;border-collapse:collapse;font:13px/1.5 -apple-system,'PingFang SC',sans-serif}` +
        `th{background:#f5f5fa;color:#666;font-weight:600;padding:8px 10px;text-align:center;` +
        `position:sticky;top:0}` +
        `td{padding:9px 10px;text-align:center;border-bottom:1px solid #eee;color:#222}` +
        `tr:last-child td{border-bottom:none}` +
        `td.num{color:#7b46f0;font-weight:600}` +
        `td.pos{color:#16a34a;font-weight:700}` +
        `.tip{margin:12px 0 0;font:11px/1.6 -apple-system,'PingFang SC',sans-serif;color:#999}` +
        `</style></head><body>` +
        `<div class="frame-wrap"><iframe src="${frameSrc}" title="活动模拟"></iframe></div>` +
        `<div class="bar">` +
        `<a class="btn btn-home" href="/"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>更多功能</a>` +
        `<button class="btn btn-main" id="costBtn" type="button">在哪一步停手最赚？</button>` +
        `<button class="btn btn-fire" id="unlimitedBtn" type="button">破防了😭我要开挂</button>` +
        `<span class="badge">仅模拟 无消费</span>` +
        `</div>` +
        `<div class="mask" id="costMask">` +
        `<div class="card">` +
        `<h3>在哪一步停手最赚？<span class="close" id="costClose" role="button">✕</span></h3>` +
        `<p class="tip" style="color:black;font-weight:1000;margin:0 0 8px">结论：每一步都是继续下去会更划算，但也只有几个电池的差别，算是不亏不赚，所以这是B站设计好的。继续还是停手完全看你自己的心情（单位：电池）</p>` +
        `<table><thead><tr><th>第几个</th><th>现在收手</th><th>继续的平均收益</th><th>继续比收手多出</th></tr></thead>` +
        `<tbody>${costRows}</tbody></table>` +
        `</div></div>` +
        `<script>(function(){` +
        `var btn=document.getElementById('costBtn'),mask=document.getElementById('costMask'),cl=document.getElementById('costClose');` +
        `var unlimitedBtn=document.getElementById('unlimitedBtn'),frame=document.querySelector('iframe');` +
        `var unlimited=false;` +
        `function show(){mask.classList.add('show')}function hide(){mask.classList.remove('show')}` +
        `btn.addEventListener('click',show);cl.addEventListener('click',hide);` +
        `mask.addEventListener('click',function(e){if(e.target===mask)hide()});` +
        `document.addEventListener('keydown',function(e){if(e.key==='Escape')hide()});` +
        `unlimitedBtn.addEventListener('click',function(){` +
        `unlimited=!unlimited;` +
        `unlimitedBtn.textContent=unlimited?'点击关闭开挂模式':'破防了😭我要开挂';` +
        `unlimitedBtn.className=unlimited?'btn btn-fire-active':'btn btn-fire';` +
        `try{frame.contentWindow.postMessage({type:'unlimited',value:unlimited},'*');}catch(e){}` +
        `});` +
        `})();</script>` +
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

  // mock 配置：算法类型 + 活动参数（与 native 注入同构，shim 会合并到默认 CONFIG 之上）。
  // local_image_base：镜像模式下把 style_config_map / prize_config 里的 B站 CDN 图片 URL
  // 改写为本地镜像同源路径（避免跨域请求被浏览器 ORB 拦截导致背景图/按钮图缺失）。
  const mockConfig = {
    algorithmType: act.algorithmType || "stone-gongfang",
    ...(act.algorithmParams ?? {}),
    local_image_base: `/moniqi/mirror/${id}`,
  };

  const shimUrl = `/moniqi/mirror/${id}/mock-shim.js?v=10`;
  // 成名之路玩法区的整页背景(activity_bg)由页面内联 background-size:100%（仅限宽高）设置，
  // 并以内联 background-image 引用 B站 CDN(https://i0.hdslb.com/bfs/live/048ae887…png)。
  // 但 B站 CDN 是黑名单式防盗链：背景图请求一旦携带 Referer(如 external Chrome 发送
  // localhost:3000 源)就返回 403 → 图片加载失败 → 玩法区背景透明，露出外壳深紫底(h5-bg，错误背景)。
  // 这里把 CDN 背景改为指向本地镜像(同源 localhost:3000，才无 Referer 防盗链问题)，用 !important
  // 覆盖内联 CDN 背景，并强制 background-size 铺满整个玩法区。仅成名之路(road-to-fame)需要此覆盖，
  // 星座回响等玩法区背景走 no-referrer 直连即可。
  const roadBgCss =
    isolateSelector === ".road-to-fame-play"
      ? `.road-to-fame-play{` +
        `background-image:url('/moniqi/mirror/${id}/i0.hdslb.com/bfs/live/048ae887feff96ddf5cc03c2158d99388e663f00.png')!important;` +
        `background-size:cover!important;background-position:center!important;` +
        `background-repeat:no-repeat!important}` +
        ``
      : "";
  const injection =
    // 桌面浏览器下保持 B站 原始 H5 窄屏宽度（flexible 脚本 rem=37.5 对应 526px），居中显示，
    // 避免 body 100% 宽导致背景铺满全屏。
    `<style>` +
    `html{background:#1b1533!important}` +
    `body{max-width:540px!important;margin:0 auto!important;min-height:100vh}` +
    `${roadBgCss}` +
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
    // 只显示玩法元素：把玩法区容器（成名之路=.road-to-fame-play / 星座回响=.heart-embed）
    // 提升为全屏内容，隐藏 B站 外壳的 tab 栏/其他玩法等兄弟元素，让页面只呈现玩法本体。
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
    // 不强制背景色：让玩法区自带的整页背景正常显示。
    // 之前强制透明导致外壳的 KV 背景透出，出现错误的背景图。
    // 同时不给玩法区设超大 z-index（让弹窗/确认框能浮在其上层），按 DOM 顺序自然叠放。
    `}catch(e){}}` +
    `function apply(){var el=document.querySelector('${isolateSelector}');if(el){isolate(el);}}` +
    `apply();` +
    `new MutationObserver(apply).observe(document.documentElement,{childList:true,subtree:true});` +
    `})();</script>`;

  const out = html
    .replace(/<\/head>/i, injection + "</head>");

  return new NextResponse(out, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}