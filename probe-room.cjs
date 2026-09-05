const { KeepLiveWS } = require("bilibili-live-ws/browser");
async function getBuvid() {
  const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi").then(w=>w.json());
  return r.data && r.data.b_3;
}
async function getTokenOld(roomid, buvid3) {
  const r = await fetch(`https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomid}&platform=pc&player=web`, { headers: { "Cookie": `buvid3=${buvid3};` } }).then(w=>w.json());
  console.log("getConf code:", r.code, "msg:", r.msg);
  return r.data && r.data.token;
}
(async () => {
  const roomId = Number(process.argv[2]);
  const buvid3 = await getBuvid();
  console.log("buvid3:", buvid3 ? "OK" : "NONE");
  const key = await getTokenOld(roomId, buvid3);
  console.log("token:", key ? "OK" : "NONE");
  const live = new KeepLiveWS(roomId, { key, uid: 110934547, buvid: buvid3, isBrowser: true });
  let count = 0;
  const stats = {};
  live.on("open", () => console.log("OPEN"));
  live.on("live", () => console.log("AUTH OK"));
  live.on("msg", (data) => {
    const cmd = data.cmd;
    if (!cmd) return;
    count++;
    stats[cmd] = (stats[cmd]||0)+1;
    if (cmd === "SEND_GIFT" || cmd === "DANMU_MSG") {
      console.log(new Date().toISOString(), cmd, cmd === "DANMU_MSG" ? String((data.info||[])[1]).slice(0,30) : ((data.data&&data.data.giftName)+"x"+(data.data&&data.data.num)));
    }
  });
  live.on("close", (c, r) => { console.log("CLOSE", c, String(r)); process.exit(0); });
  live.on("heartbeat", (o) => console.log("HB online:", o));
  setTimeout(() => { console.log("=== 90s done, total:", count, "stats:", JSON.stringify(stats)); process.exit(0); }, 90000);
})();
