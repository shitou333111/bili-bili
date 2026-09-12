// 诊断 WBI 签名：对比 nav 取 key 的两种方式，验证 getLotteryInfoWeb
import { createHash } from "node:crypto";

const cookie = "buvid3=358A0966-4CD1-DA57-092C-858792AC607E95985infoc; b_nut=1788965295; _uuid=23313F1010-9291-E3E9-4753-5B7331104776196098infoc; home_feed_column=5; browser_resolution=1600-831; buvid4=3F75C308-226B-0384-EB1C-776105EACE4096813-026090922-NjRDHa0r26QbOvSz7qOlWA%3D%3D; LIVE_BUVID=AUTO6217889655635970; fingerprint=b7bf4c9de1cb9082162c394e682cec28; buvid_fp_plain=undefined; SESSDATA=4d92421a%2C1804522140%2C15d81%2A92CjDVnt61NS9AAKY-yhSuPi7u6L3LqHKlvY3gGowXaWggM1f7OApjmgFEeQOTKsuswfYSVlo3TEhtQUJKZGxOM1M0Xzl1aVRlelBaYXp1T29VbDdpcU56M0RZNFVWVk9nU0ZWZ2pHTmxHV2tlNHBha1hnQ01HLW5DLUVtdi0walNKcDBhYjQwMHNRIIEC; bili_jct=722b36bc202f713a8e62fc9906a1104b; DedeUserID=3690974649781084; DedeUserID__ckMd5=22505b6a5cb3c262; sid=7z1s8h90; buvid_fp=b7bf4c9de1cb9082162c394e682cec28; bili_ticket=eyJhbGciOiJIUzI1NiIsImtpZCI6InMwMyIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODkyMjkzNjAsImlhdCI6MTc4ODk3MDEwMCwicGx0IjotMX0.56X9o9-csWmtDDuiz-QldtGZiVqwOujKRZl9VYVW4dE; bili_ticket_expires=1789229300; PVID=2; b_lsid=F432B0B7_1A086EEF0D8";

const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const baseHeaders = {
  "User-Agent": ua,
  Accept: "*/*",
  Referer: "https://live.bilibili.com/1832481269",
  Origin: "https://live.bilibili.com",
  Cookie: cookie,
};

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function getMixinKey(raw) {
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}
function md5(s) {
  return createHash("md5").update(s).digest("hex");
}
function signParams(params, mixinKey) {
  const wts = String(Math.floor(Date.now() / 1000));
  const signed = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(signed[k]))}`)
    .join("&");
  return { wts, w_rid: md5(query + mixinKey), query };
}

async function getNav(withCookie) {
  const h = { "User-Agent": ua, Accept: "*/*", Referer: "https://live.bilibili.com/", Origin: "https://live.bilibili.com" };
  if (withCookie) h.Cookie = cookie;
  const r = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: h });
  const j = await r.json();
  return j;
}

const navAnon = await getNav(false);
const navAuth = await getNav(true);
const keyOf = (nav) => {
  const img = nav.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] ?? "";
  const sub = nav.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] ?? "";
  return img + sub;
};
console.log("nav(anon) code=", navAnon.code, "keys=", keyOf(navAnon));
console.log("nav(auth) code=", navAuth.code, "keys=", keyOf(navAuth));
console.log("keys equal:", keyOf(navAnon) === keyOf(navAuth));

async function tryLottery(mixinKey, roomId, label) {
  const { wts, w_rid, query } = signParams({ roomid: String(roomId), need_guard: "true", web_location: "444.8" }, mixinKey);
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?${query}&w_rid=${w_rid}`;
  const r = await fetch(url, { headers: baseHeaders });
  const j = await r.json();
  console.log(`[${label}] wts=${wts} w_rid=${w_rid} => code=${j.code} msg=${j.message ?? ""} anchor=${j.data?.anchor ? "有" : "无"}`);
}

const room = 1832481269;
await tryLottery(getMixinKey(keyOf(navAnon)), room, "anon-key");
await tryLottery(getMixinKey(keyOf(navAuth)), room, "auth-key");
// 控制组：浏览器抓包的 w_rid/wts
{
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?roomid=${room}&need_guard=true&web_location=444.8&w_rid=54e3f849a2f4290219c8156f08e3b881&wts=1788970201`;
  const r = await fetch(url, { headers: baseHeaders });
  const j = await r.json();
  console.log(`[browser-wrid] => code=${j.code} msg=${j.message ?? ""}`);
}
