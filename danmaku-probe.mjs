// 临时探针：验证当前（已打补丁）的 bili-live-listener + bilibili-live-ws 是否能
// 在房间 1989943935（uid_3546682924992864，直播中，2698 在线）收到 SEND_GIFT。
import { BiliLive } from "bili-live-listener";

const roomId = 1989943935;

const res = await fetch(
  `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
);
const conf = await res.json();
const token = conf?.data?.token;
console.log("getConf code:", conf?.code, "hasToken:", !!token);
if (!token) {
  console.error("无法获取 token，退出");
  process.exit(1);
}

const live = new BiliLive(roomId, { key: token, uid: 0, isBrowser: true });
let t0 = Date.now();
let danmuRaw = 0,
  danmuParsed = 0,
  giftRaw = 0,
  giftParsed = 0,
  interactRaw = 0;

live.onOpen(() => console.log("open"));
live.onLive(() => console.log("auth ok"));
live.onHeartbeat((online) =>
  console.log(`hb online=${online} age=${((Date.now() - t0) / 1000).toFixed(0)}s`),
);
live.onClose((code, reason) =>
  console.log(
    "CLOSE code=",
    code,
    "reason=",
    reason?.message ?? reason,
    `age=${((Date.now() - t0) / 1000).toFixed(0)}s`,
  ),
);
live.onError((e) => console.log("ERROR", e?.message ?? e));

live.onRawMessage("SEND_GIFT", () => {
  giftRaw++;
});
live.onGift((m) => {
  giftParsed++;
  if (giftParsed <= 2)
    console.log(
      "GIFT parsed:",
      JSON.stringify(m.data).slice(0, 300),
    );
});
live.onRawMessage("DANMU_MSG", () => danmuRaw++);
live.onDanmu(() => danmuParsed++);
live.onRawMessage("INTERACT_WORD", () => interactRaw++);

setInterval(() => {
  const age = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `[${age}s] danmuRaw=${danmuRaw} danmuParsed=${danmuParsed} interactRaw=${interactRaw} giftRaw=${giftRaw} giftParsed=${giftParsed}`,
  );
}, 10000);

setTimeout(() => {
  console.log("DONE exit");
  process.exit(0);
}, 80000);
