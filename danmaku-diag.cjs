// 深度诊断：检查 getConf / getDanmuInfo 返回与不同 protover/host 下的消息接收情况
const { KeepLiveWS } = require("bilibili-live-ws/browser");
const roomId = 1989943935;
const t0 = Date.now();
let danmu = 0, gift = 0;

async function tryConnect(label, token, host, protover) {
  console.log(`\n=== ${label} host=${host} protover=${protover} ===`);
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const live = new KeepLiveWS(roomId, {
      key: token,
      uid: 0,
      protover,
      address: host ? `wss://${host}/sub` : undefined,
    });
    let t = setTimeout(finish, 20000);
    live.on("open", () => console.log("  open"));
    live.on("live", () => console.log("  auth ok"));
    live.on("heartbeat", (online) => console.log(`  hb online=${online}`));
    live.on("close", (code, reason) => { console.log("  CLOSE", code, reason?.message ?? reason); clearTimeout(t); finish(); });
    live.on("error", (e) => console.log("  ERROR", e?.message ?? e));
    live.on("SEND_GIFT", (m) => { gift++; console.log("  GIFT:", JSON.stringify(m?.data).slice(0, 150)); });
    live.on("DANMU_MSG", () => { danmu++; if (danmu <= 2) console.log("  DANMU_MSG"); });
    live.on("msg", (m) => { if (m && m.cmd && !/DANMU_MSG|SEND_GIFT/.test(m.cmd) && Math.random() < 0.05) console.log("  msg:", m.cmd); });
    setTimeout(() => {
      const age = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  [${age}s] danmu=${danmu} gift=${gift}`);
    }, 15000);
  });
}

async function main() {
  const conf = await (await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
  )).json();
  console.log("getConf full:", JSON.stringify(conf).slice(0, 800));

  const token = conf?.data?.token;
  const host = conf?.data?.host || conf?.data?.host_list?.[0]?.host;
  console.log("token:", !!token, "host:", host, "host_list:", JSON.stringify(conf?.data?.host_list));

  // 尝试 getDanmuInfo（客串无 WBI 签名）
  const dmi = await (await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}&type=0`,
  )).json();
  console.log("getDanmuInfo code:", dmi?.code, "msg:", dmi?.message || dmi?.msg, "token:", !!dmi?.data?.token);

  await tryConnect("getConf-token protover2 默认host", token, null, 2);
  await tryConnect("getConf-token protover3 默认host", token, null, 3);
  if (host) await tryConnect("getConf-token protover2 getConf-host", token, host, 2);
  if (dmi?.data?.token && dmi?.data?.token !== token)
    await tryConnect("getDanmuInfo-token protover2 默认host", dmi.data.token, null, 2);

  console.log("\nDONE");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
