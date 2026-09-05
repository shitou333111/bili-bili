// 抓包探针：连接直播间，完整打印所有含 GIFT 的消息 payload，验证 SEND_GIFT_V2 / UNIVERSAL_EVENT_GIFT_V2 真实格式
const { KeepLiveWS } = require("bilibili-live-ws/browser");
const roomId = Number(process.argv[2] || 1989943935);
const t0 = Date.now();
const seen = new Set();

async function main() {
  const conf = await (await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
  )).json();
  const token = conf?.data?.token;
  console.log(`[${elapsed()}] getConf code=${conf?.code} hasToken=${!!token} room=${roomId}`);

  const live = new KeepLiveWS(roomId, { key: token, uid: 0, protover: 2 });
  live.on("open", () => console.log(`[${elapsed()}] open`));
  live.on("live", () => console.log(`[${elapsed()}] auth ok`));
  live.on("close", (code, reason) => {
    console.log(`[${elapsed()}] CLOSE code=${code} reason=${reason?.message ?? reason}`);
    process.exit(0);
  });
  live.on("error", (e) => console.log(`[${elapsed()}] ERROR ${e?.message ?? e}`));
  live.on("msg", (m) => {
    const cmd = m?.cmd || m?.msg?.cmd || "";
    if (!cmd.includes("GIFT")) return;
    if (!seen.has(cmd)) {
      seen.add(cmd);
      console.log(`[${elapsed()}] === 首次发现 ${cmd} ===`);
    }
    console.log(`[${elapsed()}] ${cmd} FULL: ${JSON.stringify(m)}`);
  });

  setTimeout(() => {
    console.log(`[${elapsed()}] 600s 观察结束`);
    process.exit(0);
  }, 600000);
}
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(0)}s`; }
main().catch((e) => { console.error(e); process.exit(1); });
