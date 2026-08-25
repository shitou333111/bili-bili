import { publicEncrypt, constants } from "crypto";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

const SESSION = {
  biliCookies: [
    "SESSDATA=c8dfdda9%2C1802206712%2C0cc4d%2A81CjCaGnglqRS6DQ3IsjiENlBtPV9Bn9ZrWRjeFV2yTop51XINI53SkeutWLDz7pI_DOMSVlVpckxoeVA5MTNfdkZ6VXJlMmIzWHJvR2R4alhaSzUwUGNLNFdBLXI5TEd3NlBuaUk1S1ZFam1NWWRtRXF1YS1IOVB2LTJkMFR6TkpVS0RTamxqcTFnIIEC; bili_jct=bbe90ab0c0436ea9ff48fe5bf45eeb30; DedeUserID=3690974649781084; DedeUserID__ckMd5=22505b6a5cb3c262; sid=87kkxyaf"
  ],
  biliSessdata: "c8dfdda9%2C1802206712%2C0cc4d%2A81CjCaGnglqRS6DQ3IsjiENlBtPV9Bn9ZrWRjeFV2yTop51XINI53SkeutWLDz7pI_DOMSVlVpckxoeVA5MTNfdkZ6VXJlMmIzWHJvR2R4alhaSzUwUGNLNFdBLXI5TEd3NlBuaUk1S1ZFam1NWWRtRXF1YS1IOVB2LTJkMFR6TkpVS0RTamxqcTFnIIEC",
  biliRefreshToken: "8ef7e97841e740ca133945256d636481",
  bili_jct: "bbe90ab0c0436ea9ff48fe5bf45eeb30",
};

function genCorrespondPath(timestamp) {
  const data = Buffer.from(`refresh_${timestamp}`, "utf8");
  const enc = publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, data);
  return enc.toString("hex");
}

async function refresh() {
  let ts = Date.now();
  try {
    const info = await fetch("https://passport.bilibili.com/x/passport-login/web/cookie/info", {
      headers: { "User-Agent": UA, "Cookie": SESSION.biliCookies.join("; ") },
      cache: "no-store",
    });
    const b = await info.json();
    if (b.code === 0 && b.data?.timestamp) ts = b.data.timestamp;
  } catch {}
  const path = genCorrespondPath(ts);
  const resp = await fetch(`https://www.bilibili.com/correspond/1/${path}`, {
    headers: { "User-Agent": UA, "Cookie": SESSION.biliCookies.join("; ") },
    cache: "no-store",
  });
  const html = await resp.text();
  let csrf = (html.match(/id="1-name"\s+data-id="([^"]+)"/) || [])[1];
  if (!csrf) csrf = (html.match(/data-id="([a-f0-9]+)"/) || [])[1];
  if (!csrf) csrf = (html.match(/data-id\s*=\s*["']([^"']{8,})["']/) || [])[1];
  console.log("refresh_csrf:", csrf ? csrf.slice(0, 12) + "..." : "MISSING");
  if (!csrf) { console.log("correspond html:", html.replace(/\s+/g," ").slice(0,300)); return null; }

  const refreshUrl = "https://passport.bilibili.com/x/passport-login/web/cookie/refresh";
  const body = `csrf=${encodeURIComponent(SESSION.bili_jct)}&refresh_csrf=${encodeURIComponent(csrf)}&refresh_token=${encodeURIComponent(SESSION.biliRefreshToken)}&source=main_web`;
  const rr = await fetch(refreshUrl, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.bilibili.com/", "Cookie": SESSION.biliCookies.join("; ") },
    body,
  });
  const j = await rr.json();
  console.log("refresh result:", j.code, j.message);
  if (j.code !== 0) return null;
  const cks = (rr.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]);
  return cks;
}

async function testBagList(cookies, params) {
  const url = "https://api.live.bilibili.com/xlive/web-room/v1/gift/bag_list" + (params ? "?" + params : "");
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://live.bilibili.com/", Origin: "https://live.bilibili.com", "Cookie": cookies.join("; ") + ";buvid3=xx;buvid4=yy" },
      cache: "no-store",
    });
    const j = await r.json();
    const n = j.data?.list?.length ?? 0;
    console.log(`PARAMS[${params || "(none)"}] => code=${j.code} msg=${j.message} listCount=${n}`);
    if (n > 0 && params === "room_id=23915535") {
      console.log("  first:", JSON.stringify(j.data.list[0], (k,v)=>k==="gift_config"?undefined:v).slice(0,300));
    }
    return j.code;
  } catch (e) {
    console.log(`PARAMS[${params}] => ERROR ${e.message}`);
    return null;
  }
}

const newCks = await refresh();
if (!newCks) { console.log("refresh failed"); process.exit(1); }
console.log("new cookies:", newCks.map((c)=>c.split("=")[0]).join(","));
const cs = [...newCks, "DedeUserID=3690974649781084", "DedeUserID__ckMd5=22505b6a5cb3c262"];

// test with varying params
await testBagList(cs, "room_id=23915535");
await testBagList(cs, "");
await testBagList(cs, "t=1787612928560&room_id=23915535&mobi_app=web&receive_users=[]&web_location=444.8");
await testBagList(cs, "room_id=23915535&platform=pc");