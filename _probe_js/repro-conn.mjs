// 复现弹幕连接生命周期：模仿 APP 的 danmaku.ts 连接方式（getConf token，不带 buvid）
// 观察 open→live→close 是否在 ~45s 循环，判断是库问题还是构建/环境问题。
import { KeepLiveWS } from "bilibili-live-ws/browser";

const roomId = Number(process.argv[2] || 1989943935);

async function getBuvid() {
  const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi").then((w) => w.json());
  return r.data && (r.data.b_3 || r.data.b_4);
}

async function getTokenOld(roomid, buvid3) {
  const r = await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomid}&platform=pc&player=web`,
    { headers: { Cookie: `buvid3=${buvid3};` } },
  ).then((w) => w.json());
  console.log("[getConf] code:", r.code, "msg:", r.msg);
  return r.data && r.data.token;
}

(async () => {
  const buvid3 = await getBuvid();
  console.log("buvid3:", buvid3 ? "OK" : "NONE");
  const key = await getTokenOld(roomId, buvid3);
  console.log("token:", key ? "OK" : "NONE");
  if (!key) process.exit(1);

  const live = new KeepLiveWS(roomId, { key, uid: 110934547, isBrowser: true });
  const t0 = Date.now();
  const log = (tag, extra = "") => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${tag} ${extra}`);
  let hbCount = 0;
  live.on("open", () => log("OPEN"));
  live.on("live", () => log("AUTH OK"));
  live.on("heartbeat-sent", () => { hbCount++; log("HB-SENT", `#${hbCount}`); });
  live.on("heartbeat", (o) => log("HB-RECV", `online=${o}`));
  live.on("msg", (data) => {
    if (data.cmd) log("MSG", data.cmd);
  });
  live.on("close", (c, r) => { log("CLOSE", `code=${c} reason=${String(r)}`); process.exit(0); });
  live.on("error", (e) => log("ERROR", String(e?.message || e)));
  setTimeout(() => { log("=== 90s done, hb-sent=" + hbCount); process.exit(0); }, 90000);
})();
