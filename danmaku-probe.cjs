// 临时探针（CJS）：验证当前（已打补丁）的 bilibili-live-ws 底层在房间 1989943935
// （uid_3546682924992864，直播中）能否收到 SEND_GIFT / DANMU_MSG，并存活超过 60s（旧看门狗窗口）。
const { KeepLiveWS } = require("bilibili-live-ws/browser");

const roomId = 1989943935;
const t0 = Date.now();
let danmu = 0,
  gift = 0,
  interact = 0;

async function main() {
  const res = await fetch(
    `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
  );
  const conf = await res.json();
  console.log("getConf code:", conf?.code, "hasToken:", !!conf?.data?.token);
  if (!conf?.data?.token) process.exit(1);
  const token = conf.data.token;

  const live = new KeepLiveWS(roomId, { key: token, uid: 0 });
  live.on("open", () => console.log("open"));
  live.on("live", () => console.log("auth ok"));
  live.on("heartbeat", (online) =>
    console.log(`hb online=${online} age=${((Date.now() - t0) / 1000).toFixed(0)}s`),
  );
  live.on("close", (code, reason) =>
    console.log(
      "CLOSE code=",
      code,
      "reason=",
      reason?.message ?? reason,
      `age=${((Date.now() - t0) / 1000).toFixed(0)}s`,
    ),
  );
  live.on("error", (e) => console.log("ERROR", e?.message ?? e));
  live.on("SEND_GIFT", (m) => {
    gift++;
    if (gift <= 3)
      console.log("SEND_GIFT raw data:", JSON.stringify(m?.data).slice(0, 300));
  });
  live.on("DANMU_MSG", () => danmu++);
  live.on("INTERACT_WORD", () => interact++);

  setInterval(() => {
    const age = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[${age}s] danmu=${danmu} interact=${interact} gift=${gift}`);
  }, 10000);

  setTimeout(() => {
    console.log("DONE exit");
    process.exit(0);
  }, 80000);
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
