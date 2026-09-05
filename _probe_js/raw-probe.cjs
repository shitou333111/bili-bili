// 直接使用 isomorphic-ws 探测弹幕服务器，观察握手后关闭原因
const WebSocket = require("isomorphic-ws");

const roomId = Number(process.argv[2] || 1832481269);

async function getBuvid() {
  const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi").then((w) => w.json());
  return r.data && (r.data.b_3 || r.data.b_4);
}

(async () => {
  const buvid3 = await getBuvid();
  const tokenRes = await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
    { headers: { Cookie: `buvid3=${buvid3};` } },
  ).then((w) => w.json());
  const key = tokenRes.data && tokenRes.data.token;
  console.log("token:", key ? "OK" : "NONE", "code:", tokenRes.code);

  const ws = new WebSocket("wss://broadcastlv.chat.bilibili.com/sub");
  const t0 = Date.now();
  const log = (tag, ...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag}`, ...a);
  ws.onopen = () => {
    log("OPEN, readyState", ws.readyState);
    // 发送认证包：header 16 字节 + body
    const body = JSON.stringify({ uid: 110934547, roomid: roomId, protover: 2, platform: "web", type: 2, key, buvid: buvid3 });
    const h = Buffer.alloc(16);
    h.writeInt32BE(body.length + 16, 0);
    h.writeInt16BE(16, 4);
    h.writeInt16BE(1, 6);
    h.writeInt32BE(7, 8);
    h.writeInt32BE(1, 12);
    ws.send(Buffer.concat([h, Buffer.from(body)]));
  };
  ws.onmessage = async (ev) => {
    const buf = Buffer.from(await new Response(ev.data).arrayBuffer());
    const op = buf.readInt32BE(8);
    const proto = buf.readInt16BE(6);
    const len = buf.readInt32BE(0);
    log("MSG", `op=${op} proto=${proto} len=${len}`, op === 8 ? String(buf.slice(16, len)) : op === 5 ? String(buf.slice(16, Math.min(300, len))) : "");
  };
  ws.onerror = (e) => log("ERROR", e.message || e);
  ws.onclose = (e) => { log("CLOSE", "code=" + e.code, "reason=" + e.reason, "clean=" + e.wasClean); process.exit(0); };
  setTimeout(() => { log("=== 60s done"); process.exit(0); }, 60000);
})();
