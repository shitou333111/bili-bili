// 诊断：验证非 Web 版 getLotteryInfo 能否返回真实的天选/红包数据
const SESSDATA = "92204a1a%2C1804676386%2C35843%2A91CjBaLH_zbbf7k-JmOqbcKJg1a9BTGRxEezPt3jvNj0aM_WndUpSDzV6nBT83Ufkzp1MSVkRodUg5Y2VyeVNMRFhSc0I0QzA1SEFIazlBZHZiTzlJd3o5Y3pMOHRsb1Bzc3cyVUFGUS05UTRfSzBRZlpmOFRvajdZZG1GaTlfOVNHQW0wLUczVjNRIIEC";
const LOGIN = [`SESSDATA=${SESSDATA}`, "bili_jct=49d288571d1642f5be12a5ced920e2ff", "DedeUserID=1280871616", "DedeUserID__ckMd5=a79d76abc0865dc4", "sid=gsf6ofg4"].join("; ");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const spi = await (await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: { "User-Agent": UA } })).json();
const buvid = `buvid3=${spi.data.b_3};buvid4=${spi.data.b_4 || ""}`;
const FULL = buvid + "; " + LOGIN;
const H = { "User-Agent": UA, "Accept": "application/json, text/plain, */*", Referer: "https://live.bilibili.com/", Cookie: FULL };

// 1) 用 getRoomList 收集热门房间
const roomIds = [];
for (const area of [1, 2, 3, 9, 10]) {
  for (let page = 1; page <= 2; page++) {
    const u = `https://api.live.bilibili.com/room/v1/area/getRoomList?parent_area_id=${area}&area_id=0&page=${page}&page_size=30&sort_type=online`;
    const r = await (await fetch(u, { headers: H })).json();
    if (r.code === 0 && Array.isArray(r.data)) for (const it of r.data) roomIds.push(it.roomid);
    await new Promise((s) => setTimeout(s, 300));
  }
}
console.log(`收集到 ${roomIds.length} 个房间`);

// 2) 逐个用 getLotteryInfo 检测
let hit = 0, fail = 0;
for (const room of roomIds) {
  const r = await (await fetch(`https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfo?roomid=${room}`, { headers: H })).json();
  if (r.code !== 0) { fail++; continue; }
  const d = r.data || {};
  const found = [];
  if (d.anchor) found.push(`anchor:${d.anchor.award_name}x${d.anchor.award_num}(status=${d.anchor.status})`);
  if (d.the_chosen_one) found.push(`the_chosen_one:${JSON.stringify(d.the_chosen_one).slice(0, 120)}`);
  if (d.red_pocket) found.push(`red_pocket:${JSON.stringify(d.red_pocket).slice(0, 120)}`);
  if (d.popularity_red_pocket) found.push(`pop_red:${JSON.stringify(d.popularity_red_pocket).slice(0, 120)}`);
  if (d.anchor_lottery_info) found.push(`anchor_lottery_info:${JSON.stringify(d.anchor_lottery_info).slice(0, 150)}`);
  if (found.length) { hit++; console.log(`room=${room} ${found.join(" | ")}`); }
  await new Promise((s) => setTimeout(s, 200));
}
console.log(`\n完成：${roomIds.length} 房间，${hit} 个有抽奖数据，${fail} 个请求失败`);
