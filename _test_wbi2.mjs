// 隔离 -352 触发条件：Referer / UA / cookie 精简
import { createHash } from "node:crypto";

const fullCookie = "buvid3=358A0966-4CD1-DA57-092C-858792AC607E95985infoc; b_nut=1788965295; _uuid=23313F1010-9291-E3E9-4753-5B7331104776196098infoc; home_feed_column=5; browser_resolution=1600-831; buvid4=3F75C308-226B-0384-EB1C-776105EACE4096813-026090922-NjRDHa0r26QbOvSz7qOlWA%3D%3D; LIVE_BUVID=AUTO6217889655635970; fingerprint=b7bf4c9de1cb9082162c394e682cec28; buvid_fp_plain=undefined; SESSDATA=4d92421a%2C1804522140%2C15d81%2A92CjDVnt61NS9AAKY-yhSuPi7u6L3LqHKlvY3gGowXaWggM1f7OApjmgFEeQOTKsuswfYSVlo3TEhtQUJKZGxOM1M0Xzl1aVRlelBaYXp1T29VbDdpcU56M0RZNFVWVk9nU0ZWZ2pHTmxHV2tlNHBha1hnQ01HLW5DLUVtdi0walNKcDBhYjQwMHNRIIEC; bili_jct=722b36bc202f713a8e62fc9906a1104b; DedeUserID=3690974649781084; DedeUserID__ckMd5=22505b6a5cb3c262; sid=7z1s8h90; buvid_fp=b7bf4c9de1cb9082162c394e682cec28; bili_ticket=eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODkyMjkzNjAsImlhdCI6MTc4ODk3MDEwMCwicGx0IjotMX0.56X9o9-csWmtDDuiz-QldtGZiVqwOujKRZl9VYVW4dE; bili_ticket_expires=1789229300; PVID=2; b_lsid=F432B0B7_1A086EEF0D8";

// 模拟 app：仅登录态 + buvid3（cookie_len ≈ 486）
const shortCookie = "buvid3=358A0966-4CD1-DA57-092C-858792AC607E95985infoc; buvid4=3F75C308-226B-0384-EB1C-776105EACE4096813-026090922-NjRDHa0r26QbOvSz7qOlWA%3D%3D; SESSDATA=4d92421a%2C1804522140%2C15d81%2A92CjDVnt61NS9AAKY-yhSuPi7u6L3LqHKlvY3gGowXaWggM1f7OApjmgFEeQOTKsuswfYSVlo3TEhtQUJKZGxOM1M0Xzl1aVRlelBaYXp1T29VbDdpcU56M0RZNFVWVk9nU0ZWZ2pHTmxHV2tlNHBha1hnQ01HLW5DLUVtdi0walNKcDBhYjQwMHNRIIEC; bili_jct=722b36bc202f713a8e62fc9906a1104b; DedeUserID=3690974649781084; DedeUserID__ckMd5=22505b6a5cb3c262";
console.log("shortCookie len=", shortCookie.length);

const UA131 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA152 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const md5 = (s) => createHash("md5").update(s).digest("hex");
const getMixinKey = (raw) => MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);

const nav = await (await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: { "User-Agent": UA152, Referer: "https://live.bilibili.com/" } })).json();
const img = nav.data.wbi_img.img_url.split("/").pop().split(".")[0];
const sub = nav.data.wbi_img.sub_url.split("/").pop().split(".")[0];
const mixinKey = getMixinKey(img + sub);

function sign(params) {
  const wts = String(Math.floor(Date.now() / 1000));
  const signed = { ...params, wts };
  const query = Object.keys(signed).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]))}`).join("&");
  return { query, w_rid: md5(query + mixinKey) };
}
const room = 1832481269;
const { query, w_rid } = sign({ roomid: String(room), need_guard: "true", web_location: "444.8" });
const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?${query}&w_rid=${w_rid}`;

async function attempt(label, extra) {
  const headers = { Accept: "*/*", ...extra };
  const r = await fetch(url, { headers });
  const j = await r.json();
  console.log(`[${label}] code=${j.code} msg=${j.message ?? ""}`);
}

await attempt("room-referer+UA152+full", { "User-Agent": UA152, Referer: `https://live.bilibili.com/${room}`, Origin: "https://live.bilibili.com", Cookie: fullCookie });
await attempt("generic-referer+UA152+full", { "User-Agent": UA152, Referer: "https://live.bilibili.com/", Origin: "https://live.bilibili.com", Cookie: fullCookie });
await attempt("generic-referer+UA131+full", { "User-Agent": UA131, Referer: "https://live.bilibili.com/", Origin: "https://live.bilibili.com", Cookie: fullCookie });
await attempt("room-referer+UA131+short", { "User-Agent": UA131, Referer: `https://live.bilibili.com/${room}`, Origin: "https://live.bilibili.com", Cookie: shortCookie });
await attempt("generic-referer+UA131+short", { "User-Agent": UA131, Referer: "https://live.bilibili.com/", Origin: "https://live.bilibili.com", Cookie: shortCookie });
await attempt("no-referer+UA131+short", { "User-Agent": UA131, Cookie: shortCookie });
