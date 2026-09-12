/**
 * 纯 JS MD5 实现（标准 RFC 1321，支持 UTF-8 输入）
 *
 * 用于客户端（浏览器/WebView）计算 B站签名（w_rid 等），
 * 因为浏览器环境没有 Node 的 crypto.createHash。
 *
 * 注意：必须与标准 MD5 完全一致，否则 B 站风控会返回 -352。
 * 可用 `md5("abc") === "900150983cd24fb0d6963f7d28e17f72"` 自检。
 */

/** 每轮左移位数 */
const SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** 常量表 K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function rotl(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

/** 将字符串按 UTF-8 编码为字节数组 */
function utf8Encode(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      // UTF-16 代理对 -> 码点
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return bytes;
}

/** 小端序输出 32 位字为 8 位十六进制 */
function wordToHexLE(n: number): string {
  let hex = "";
  for (let i = 0; i < 4; i++) {
    hex += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

export function md5(input: string): string {
  const bytes = utf8Encode(input);
  const bitLen = bytes.length * 8;

  // 填充：0x80 + 若干 0，使长度 % 64 == 56
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  // 追加 64 位原始长度（小端序）
  bytes.push(
    bitLen & 0xff,
    (bitLen >>> 8) & 0xff,
    (bitLen >>> 16) & 0xff,
    (bitLen >>> 24) & 0xff,
    0,
    0,
    0,
    0,
  );

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let chunk = 0; chunk < bytes.length; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      const p = chunk + i * 4;
      M[i] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        f = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        f = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (f >>> 0) + A + K[i] + M[g];
      B = (B + rotl(sum >>> 0, SHIFT[i])) >>> 0;
      A = tmp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return (
    wordToHexLE(a0) + wordToHexLE(b0) + wordToHexLE(c0) + wordToHexLE(d0)
  ).toLowerCase();
}
