// 测试 getLotteryInfoWeb - 用用户的完整 Cookie
const cookie = "buvid3=358A0966-4CD1-DA57-092C-858792AC607E95985infoc; b_nut=1788965295; _uuid=23313F1010-9291-E3E9-4753-5B7331104776196098infoc; home_feed_column=5; browser_resolution=1600-831; buvid4=3F75C308-226B-0384-EB1C-776105EACE4096813-026090922-NjRDHa0r26QbOvSz7qOlWA%3D%3D; LIVE_BUVID=AUTO6217889655635970; fingerprint=b7bf4c9de1cb9082162c394e682cec28; buvid_fp_plain=undefined; SESSDATA=4d92421a%2C1804522140%2C15d81%2A92CjDVnt61NS9AAKY-yhSuPi7u6L3LqHKlvY3gGowXaWggM1f7OApjmgFEeQOTKsuswfYSVlo3TEhtQUJLZGxOM1M0Xzl1aVRlelBaYXp1T29VbDdpcU56M0RZNFVWVk9nU0ZWZ2pHTmxHV2tlNHBha1hnQ01HLW5DLUVtdi0walNKcDBhYjQwMHNRIIEC; bili_jct=722b36bc202f713a8e62fc9906a1104b; DedeUserID=3690974649781084; DedeUserID__ckMd5=22505b6a5cb3c262; sid=7z1s8h90; buvid_fp=b7bf4c9de1cb9082162c394e682cec28; bili_ticket=eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODkyMjkzNjAsImlhdCI6MTc4ODk3MDEwMCwicGx0IjotMX0.56X9o9-csWmtDDuiz-QldtGZiVqwOujKRZl9VYVW4dE; bili_ticket_expires=1789229300; PVID=2; b_lsid=F432B0B7_1A086EEF0D8";

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Referer": "https://live.bilibili.com/1832481269",
  "Origin": "https://live.bilibili.com",
  "Cookie": cookie,
};

// 测试1: 不带 w_rid/wts
console.log("=== Test 1: 无 Wbi ===");
const r1 = await fetch("https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?roomid=1832481269&need_guard=true&web_location=444.8", { headers });
const d1 = await r1.json();
console.log("code:", d1.code, "anchor:", d1.data?.anchor ? "有" : "无", "status:", d1.data?.anchor?.status);

// 测试2: 用你提供的 w_rid 和 wts
console.log("\n=== Test 2: 带 w_rid/wts (从浏览器) ===");
const r2 = await fetch("https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?roomid=1832481269&need_guard=true&web_location=444.8&w_rid=54e3f849a2f4290219c8156f08e3b881&wts=1788970201", { headers });
const d2 = await r2.json();
console.log("code:", d2.code, "anchor:", d2.data?.anchor ? "有" : "无", "status:", d2.data?.anchor?.status);
if (d2.data?.anchor) console.log("award:", d2.data.anchor.award_name, "x" + d2.data.anchor.award_num);
