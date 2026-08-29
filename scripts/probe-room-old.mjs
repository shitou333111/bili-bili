// 只读诊断脚本：查询 getRoomInfoOld 原始返回，确认 roomStatus / roomid。
// 用法：node scripts/probe-room-old.mjs <mid>
const mid = process.argv[2];
if (!mid || !/^\d+$/.test(mid)) {
  console.error("用法: node scripts/probe-room-old.mjs <mid>");
  process.exit(1);
}

const url = `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${mid}`;

const res = await fetch(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://live.bilibili.com/",
  },
  cache: "no-store",
});

const json = await res.json();
console.log("HTTP", res.status);
console.log("完整返回:", JSON.stringify(json, null, 2));

if (json?.code === 0 && json?.data) {
  const d = json.data;
  console.log("\n判定结果:");
  console.log("  roomStatus =", d.roomStatus, d.roomStatus === 1 ? "(有房/主播)" : "(无房)");
  console.log("  roomid     =", d.roomid);
  console.log("  hasLiveRoom 应采用:", d.roomStatus === 1 ? "true" : "false");
}