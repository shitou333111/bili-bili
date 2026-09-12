// 诊断：验证应用内 md5/wbi 签名是否与标准实现一致，并复现 getLotteryInfoWeb -352
import crypto from "node:crypto";

// ===== 从 src/lib/md5.ts 原样复制 =====
function md5App(string) {
  function rotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
  function addUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000, lY4 = lY & 0x40000000, lX8 = lX & 0x80000000, lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) return lResult ^ 0x40000000 ^ 0x80000000 ^ lX8 ^ lY8;
    return lResult ^ lX8 ^ lY8;
  }
  function F(x, y, z) { return (x & y) | ((~x) & z); }
  function G(x, y, z) { return (x & z) | (y & (~z)); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | (~z)); }
  function FF(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
  function GG(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
  function HH(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
  function II(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
  function convertToWordArray(str) {
    const lWordCount = ((str.length + 8 - (str.length + 8) % 64) / 64 + 1) * 16;
    const lWordArray = new Array(lWordCount - 1);
    let lBytePosition = 0, lByteCount = 0;
    while (lByteCount < str.length) {
      const lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordPosition] = (lWordArray[lWordPosition] | (str.charCodeAt(lByteCount) << lBytePosition));
      lByteCount++;
    }
    const lWordPosition = (lByteCount - (lByteCount % 4)) / 4;
    lBytePosition = (lByteCount % 4) * 8;
    lWordArray[lWordPosition] = lWordArray[lWordPosition] | (0x80 << lBytePosition);
    lWordArray[lWordCount - 2] = str.length << 3;
    lWordArray[lWordCount - 1] = str.length >>> 29;
    return lWordArray;
  }
  function wordToHex(lValue) {
    let v = "", t = "";
    for (let i = 0; i <= 3; i++) {
      const lByte = (lValue >>> (i * 8)) & 255;
      t = "0" + lByte.toString(16);
      v = v + t.substr(t.length - 2, 2);
    }
    return v;
  }
  const x = convertToWordArray(string);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const S11 = 7, S12 = 12, S13 = 17, S14 = 22, S21 = 5, S22 = 9, S23 = 14, S24 = 20, S31 = 4, S32 = 11, S33 = 16, S34 = 23, S41 = 6, S42 = 10, S43 = 15, S44 = 21;
  for (let k = 0; k < x.length; k += 16) {
    const AA = a, BB = b, CC = c, DD = d;
    a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478); d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756); c = FF(c, d, a, b, x[k + 2], S13, 0x242070db); b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
    a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf); d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a); c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
    a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8); d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af); c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1); b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
    a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122); d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193); c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e); b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
    a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562); d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340); c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51); b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
    a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d); d = GG(d, a, b, c, x[k + 10], S22, 0x2441453); c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681); b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
    a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6); d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6); c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87); b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
    a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905); d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8); c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9); b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
    a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681); c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122); b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
    a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44); d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9); c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60); b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
    a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6); d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa); c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085); b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
    a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039); d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5); c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8); b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
    a = II(a, b, c, d, x[k + 0], S41, 0xf4292244); d = II(d, a, b, c, x[k + 13], S42, 0x432aff97); c = II(c, d, a, b, x[k + 10], S43, 0xab9423a7); b = II(b, c, d, a, x[k + 7], S44, 0xfc93a039);
    a = II(a, b, c, d, x[k + 4], S41, 0x655b59c3); d = II(d, a, b, c, x[k + 1], S42, 0x8f0ccc92); c = II(c, d, a, b, x[k + 14], S43, 0xffeff47d); b = II(b, c, d, a, x[k + 11], S44, 0x85845dd1);
    a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f); d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0); c = II(c, d, a, b, x[k + 6], S43, 0xa3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
    a = II(a, b, c, d, x[k + 2], S41, 0xf7537e82); d = II(d, a, b, c, x[k + 9], S42, 0xbd3af235); c = II(c, d, a, b, x[k + 0], S43, 0x2ad7d2bb); b = II(b, c, d, a, x[k + 5], S44, 0xeb86d391);
    a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
  }
  return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
}

const md5node = (s) => crypto.createHash("md5").update(s).digest("hex");

// 1) md5 正确性
const samples = ["abc", "hello world", "need_guard=true&roomid=12231251&web_location=444.8&wts=1789128383"];
let md5ok = true;
for (const s of samples) {
  const a = md5App(s), n = md5node(s);
  if (a !== n) md5ok = false;
  console.log(`[md5] "${s.slice(0, 30)}" app=${a} node=${n} ${a === n ? "OK" : "MISMATCH!!!"}`);
}
console.log(`[md5] 应用内 md5 实现 ${md5ok ? "正确 ✅" : "错误 ❌"}`);

// 2) 取 nav 的 wbi 密钥
const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const nav = await (await fetch("https://api.bilibili.com/x/web-interface/nav", {
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Referer": "https://www.bilibili.com/" },
})).json();
const imgKey = nav.data.wbi_img.img_url.split("/").pop().split(".")[0];
const subKey = nav.data.wbi_img.sub_url.split("/").pop().split(".")[0];
const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => (imgKey + subKey)[i]).join("").slice(0, 32);
console.log(`[nav] imgKey=${imgKey} subKey=${subKey}`);
console.log(`[nav] mixinKey=${mixinKey}`);

// 3) 用日志中的 wts 复核日志中的 w_rid
const LOG_WTS = "1789128383";
const LOG_WRID = "153492517a2ef0efccf60acfacbffc5a";
const logQuery = `need_guard=true&roomid=12231251&web_location=444.8&wts=${LOG_WTS}`;
const recomputed = md5node(logQuery + mixinKey);
console.log(`[复核] 日志 w_rid   = ${LOG_WRID}`);
console.log(`[复核] 重算 w_rid   = ${recomputed}  ${recomputed === LOG_WRID ? "一致 ✅" : "不一致 ❌（说明应用签名时使用的 mixinKey 与现在不同，或签名逻辑有误）"}`);
console.log(`[复核] 日志查询串   = ${logQuery}`);

// 4) 实际发请求对比
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://live.bilibili.com/",
  "Origin": "https://live.bilibili.com",
};
async function probe(label, qs) {
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?${qs}`;
  const r = await (await fetch(url, { headers })).json();
  console.log(`[请求] ${label}\n        ${url}\n        => code=${r.code} msg=${r.message ?? r.msg ?? ""}`);
}
const nowWts = String(Math.floor(Date.now() / 1000));
const freshQuery = `need_guard=true&roomid=12231251&web_location=444.8&wts=${nowWts}`;
const freshRid = md5node(freshQuery + mixinKey);
const freshSigned = `${freshQuery}&w_rid=${freshRid}`;

await probe("A. 日志原样参数（含日志 w_rid）", `roomid=12231251&need_guard=true&web_location=444.8&wts=${LOG_WTS}&w_rid=${LOG_WRID}`);
await probe("B. 现算正确签名", freshSigned);
await probe("C. 错误 w_rid（随便写）", `roomid=12231251&need_guard=true&web_location=444.8&wts=${nowWts}&w_rid=deadbeefdeadbeefdeadbeefdeadbeef`);
await probe("D. 只带 wts 不带 w_rid", `roomid=12231251&need_guard=true&web_location=444.8&wts=${nowWts}`);
await probe("E. 完全不带签名", `roomid=12231251&need_guard=true&web_location=444.8`);
