#!/usr/bin/env node
/**
 * 网易云宠物 → 直播姬「浏览器源」中转
 *
 * 背景：宠物是网易云 Electron 的独立窗口（subApp.html?route=pet-desktop，app:// 协议），
 * 且该窗口被设置了禁止画面捕获（窗口/游戏捕获都会得到黑屏）。
 * 本脚本通过 Electron 的调试端口（CDP）订阅宠物页面的帧，转成一个本地网页，
 * 直播姬里「添加素材 → 浏览器」填 http://127.0.0.1:9321/ 即可显示宠物，页面背景透明。
 *
 * 用法：
 *   1. 用带调试端口的快捷方式启动网易云（本项目的 网易云音乐.lnk 已带 --remote-debugging-port=9229）
 *   2. node scripts/pet-relay.mjs            # 或 npm run pet-relay
 *   3. 直播姬 → 添加素材 → 浏览器 → URL 填 http://127.0.0.1:9321/
 *
 * 参数（可选）：
 *   --cdp=9229    网易云调试端口
 *   --http=9321   本地网页端口
 *   --width=800   截取帧的最大宽度
 */
import http from "node:http";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const CDP_PORT = Number(args.cdp || 9229);
const HTTP_PORT = Number(args.http || 9321);
const MAX_WIDTH = Number(args.width || 800);

/** 最新一帧（PNG base64）与尺寸 */
let latestFrame = "";
let frameAt = 0;
let frameMeta = { width: 0, height: 0 };
let ws = null;
let msgId = 0;
let petTitle = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(3000) });
  return await res.json();
}

function pickPetTarget(targets) {
  // 宠物页：subApp.html?route=pet-desktop；部分版本路由不同，退化为标题/地址含 pet
  return (
    targets.find((t) => /subApp\.html/i.test(t.url) && /pet/i.test(t.url)) ||
    targets.find((t) => /subApp\.html/i.test(t.url)) ||
    targets.find((t) => /pet/i.test(t.url) || /宠物/.test(t.title || "")) ||
    null
  );
}

function startScreencast() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ id: ++msgId, method: "Page.enable" }));
  ws.send(
    JSON.stringify({
      id: ++msgId,
      method: "Page.startScreencast",
      params: { format: "png", maxWidth: MAX_WIDTH, maxHeight: MAX_WIDTH, everyNthFrame: 1 },
    }),
  );
}

async function connect() {
  for (;;) {
    try {
      const targets = await listTargets();
      const pet = pickPetTarget(targets);
      if (!pet?.webSocketDebuggerUrl) {
        console.warn(
          `[pet-relay] 未找到宠物页面，当前目标：\n${targets
            .map((t) => `  [${t.type}] ${t.title} :: ${t.url}`)
            .join("\n")}`,
        );
        await sleep(5000);
        continue;
      }
      petTitle = pet.title || "pet";
      console.log(`[pet-relay] 已连接宠物页面：${pet.title} :: ${pet.url}`);
      ws = new WebSocket(pet.webSocketDebuggerUrl);

      ws.addEventListener("open", () => {
        startScreencast();
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        if (msg.method === "Page.screencastFrame") {
          const { data, sessionId, metadata } = msg.params || {};
          if (data) {
            latestFrame = data;
            frameAt = Date.now();
            if (metadata) {
              frameMeta = {
                width: metadata.deviceWidth || frameMeta.width,
                height: metadata.deviceHeight || frameMeta.height,
              };
            }
          }
          // 必须回 ack，否则 Chrome 会停止继续推帧
          if (sessionId != null) {
            ws.send(
              JSON.stringify({ id: ++msgId, method: "Page.screencastFrameAck", params: { sessionId } }),
            );
          }
        }
      });
      ws.addEventListener("close", () => {
        console.warn("[pet-relay] 调试连接已断开，5 秒后重连…");
        latestFrame = "";
      });
      ws.addEventListener("error", () => {
        /* 交给 close 处理 */
      });
      return;
    } catch (e) {
      console.warn(`[pet-relay] 连接调试端口 ${CDP_PORT} 失败：${e?.message || e}`);
      await sleep(5000);
    }
  }
}

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>netease-pet</title>
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100%}
  #pet{display:block;width:100vw;height:100vh;object-fit:contain;background:transparent}
</style></head>
<body><img id="pet" alt="">
<script>
  // 透明背景 + 轮询最新帧：避免长连接在部分浏览器源里被限制
  const img = document.getElementById('pet');
  let last = 0;
  async function tick(){
    try{
      const r = await fetch('/frame?t=' + Date.now(), {cache:'no-store'});
      if (r.ok) {
        const blob = await r.blob();
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const prev = img.dataset.url;
          img.onload = () => { if (prev) URL.revokeObjectURL(prev); };
          img.dataset.url = url;
          img.src = url;
        }
      }
    }catch(e){}
    setTimeout(tick, 100);
  }
  tick();
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${HTTP_PORT}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(PAGE_HTML);
    return;
  }
  if (url.pathname === "/frame") {
    if (!latestFrame) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("waiting for pet frame");
      return;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-frame-age": String(Date.now() - frameAt),
    });
    res.end(Buffer.from(latestFrame, "base64"));
    return;
  }
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(
      JSON.stringify(
        {
          pet: petTitle,
          connected: !!ws && ws.readyState === WebSocket.OPEN,
          frameAgeMs: latestFrame ? Date.now() - frameAt : null,
          ...frameMeta,
        },
        null,
        2,
      ),
    );
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`[pet-relay] 浏览器源地址： http://127.0.0.1:${HTTP_PORT}/`);
  console.log(`[pet-relay] 状态查看：     http://127.0.0.1:${HTTP_PORT}/status`);
  void connect();
});
