// 实时探针：连接正在直播的房间，验证消息接收 + 连接存活时长 + 抓取礼物消息完整 payload
const { KeepLiveWS } = require("bilibili-live-ws/browser");
const roomId = Number(process.argv[2] || 1989943935);
const t0 = Date.now();
const counts = {};
let total = 0;

async function main() {
  const conf = await (await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
  )).json();
  const token = conf?.data?.token;
  console.log("getConf code:", conf?.code, "hasToken:", !!token);

  const live = new KeepLiveWS(roomId, { key: token, uid: 0, protover: 2 });
  const openedAt = Date.now();
  live.on("open", () => console.log(`[${elapsed()}] open`));
  live.on("live", () => console.log(`[${elapsed()}] auth ok`));
  live.on("heartbeat", (online) => console.log(`[${elapsed()}] hb online=${online}`));
  live.on("heartbeat-sent", () => {});
  live.on("close", (code, reason) => {
    console.log(`[${elapsed()}] CLOSE code=${code} reason=${reason?.message ?? reason} age=${((Date.now() - openedAt) / 1000).toFixed(0)}s`);
    process.exit(0);
  });
  live.on("error", (e) => console.log(`[${elapsed()}] ERROR`, e?.message ?? e));
  live.on("msg", (m) => {
    total++;
    const cmd = m?.cmd || m?.msg?.cmd || "?";
    counts[cmd] = (counts[cmd] || 0) + 1;
    if (cmd === "SEND_GIFT" || cmd === "UNIVERSAL_EVENT_GIFT_V2") {
      console.log(`[${elapsed()}] ${cmd} FULL: ${JSON.stringify(m)}`);
    }
  });

  // 每 10s 打印一次统计 + 存活检查
  const timer = setInterval(() => {
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`[${elapsed()}] alive age=${((Date.now() - openedAt) / 1000).toFixed(0)}s total=${total} ${top}`);
  }, 10000);

  setTimeout(() => {
    console.log(`\n[${elapsed()}] 300s 观察结束 total=${total}`);
    clearInterval(timer);
    live.close();
    process.exit(0);
  }, 300000);
}

function elapsed() {
  return `${((Date.now() - t0) / 1000).toFixed(0)}s`;
}

main().catch((e) => { console.error(e); process.exit(1); });
