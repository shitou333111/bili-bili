/**
 * 上传数据加密（客户端 / 服务器共用模块）
 *
 * 背景：客户端把用户私有数据上传到自建服务器时，若明文传输，抓包者能轻易识别
 * 上传目录结构（uid_<mid>）、文件名（pay-records.json 等）与文件内容。
 *
 * 方案：客户端在发送前对整个 payload（{mid, uname, files}）做 AES-256-GCM 加密，
 * 再以 Base64 编码的密文 JSON 传输；服务器接收后先用同一密钥解密还原，
 * 再按原有方案落盘存储。因此"上传前收集文件"与"落盘后按文件名处理"两端逻辑完全不变。
 *
 * 注意：密钥内置于客户端与服务器代码中，防御目标是"传输被抓包无法识别目录/文件名/内容"，
 * 而非抵御逆向提取密钥的定向攻击（属于用户要求的"不需要太复杂"的轻量方案）。
 */

/** 共享密钥（AES-256，32 字节，Base64 编码） */
const UPLOAD_KEY_B64 = "13LC3Ym/Mz+6WBa/GgZFbrxU1CX4l5pFX4+wTwjnn/w=";

/** 上传的明文 payload 结构（与旧版 POST JSON 一致，仅多了加密层） */
export type UploadPayload = {
  mid: number;
  uname: string;
  files: Record<string, string>;
  /** 传输层标记：true 表示 files 各值已 gzip 压缩并经 Base64 编码（仅传输使用，不落盘） */
  compressed?: boolean;
};

/** 加密后的传输结构 */
export type UploadEncrypted = {
  iv: string; // 12 字节随机 IV（Base64）
  data: string; // AES-GCM 密文（Base64）
};

async function getSubtle(): Promise<SubtleCrypto> {
  const g = globalThis as any;
  if (g.crypto?.subtle) return g.crypto.subtle as SubtleCrypto;
  // Node < 20 兜底（Next 16 要求 Node 20.9+，正常不会走到这里）
  const { webcrypto } = await import("node:crypto");
  return webcrypto.subtle as unknown as SubtleCrypto;
}

function b64encode(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

/**
 * Base64 编码（分块并让出事件循环）：超大 batch（如几十 MB）若一次性同步编码会长时间
 * 占满主线程 → UI 卡顿、console 日志来不及刷新。实现要点：
 *  - 用 String.fromCharCode.apply 整块转二进制串（比逐字节 += 快一个数量级）
 *  - 每 256KB 让出一次主线程，单次阻塞控制在毫秒级，且定时器开销降到 ~1/8
 *  - 分块大小必须是 3 的倍数：否则每块 btoa 末尾带 '=' 填充，拼接后 '=' 出现在
 *    字符串中间，服务端 atob 整串解码会报 InvalidCharacterError → HTTP 400。
 *    0x7FFE = 32766（= 10922×3），恰好整除，单块无填充。
 */
async function b64encodeAsync(buf: Uint8Array): Promise<string> {
  const SUB = 0x7ffe; // 32766，3 的倍数（避免分块拼接时出现中间 '=' 填充）
  const YIELD_EVERY = 8; // 每 SUB*8≈256KB 让出一次事件循环
  let out = "";
  let since = 0;
  for (let i = 0; i < buf.length; i += SUB) {
    const end = Math.min(i + SUB, buf.length);
    out += btoa(String.fromCharCode.apply(null, buf.subarray(i, end) as unknown as number[]));
    if (++since >= YIELD_EVERY) {
      since = 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * gzip 压缩（异步原生实现，不阻塞主线程）：上传前先压缩各文件内容。
 * JSON 数据可压缩 80~95%，把几十 MB 的大文件压到几 MB，后续 AES / base64 / 网络 /
 * 服务端解析整体缩小一个量级，直接消除大文件上传时的主线程卡顿。
 * CompressionStream 在 Chrome/Edge/Android WebView 80+、Safari/iOS 16.4+ 可用；
 * 不可用时由调用方回退为明文传输（兼容旧端）。
 */
async function gzipBytes(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  // 运行时 data 恒为 ArrayBuffer 支撑（非 SharedArrayBuffer），此处仅做类型收窄，
  // 以满足 BlobPart 的类型约束（TS 5.7 起 Uint8Array 默认参数为 ArrayBufferLike）
  const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  const stream = new Blob([view]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** gzip 解压（服务器/Node 优先 zlib，非 Node 环境回退 DecompressionStream） */
async function gunzipBytes(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const { gunzipSync } = await import("node:zlib");
    return new Uint8Array(gunzipSync(data));
  } catch {
    const view = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    const stream = new Blob([view]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }
}

async function importKey(usage: KeyUsage): Promise<CryptoKey> {
  const subtle = await getSubtle();
  return subtle.importKey(
    "raw",
    b64decode(UPLOAD_KEY_B64),
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

/** 客户端加密整个上传 payload（隐藏目录结构、文件名与内容） */
export async function encryptUploadPayload(payload: UploadPayload): Promise<UploadEncrypted> {
  const subtle = await getSubtle();
  const key = await importKey("encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const t0 = performance.now();

  // 传输前先 gzip 压缩各文件内容（CompressionStream 为异步原生实现，不阻塞主线程）。
  // 支持时把 files 各值替换为"gzip 压缩后 Base64"，并打 compressed 标记供服务端解压还原；
  // 不支持时保持明文传输（兼容旧端/旧服务端，字段值仍是原始字符串）。
  const toEncrypt: UploadPayload = { ...payload };
  let gzipMs = 0;
  if (typeof CompressionStream !== "undefined") {
    const g0 = performance.now();
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(payload.files)) {
      const gz = await gzipBytes(new TextEncoder().encode(content));
      // 文件内容已从"原始 JSON 字符串"变为"gzip 后 Base64"，不再参与 JSON 转义，
      // 避免 33MB 大文件在 JSON.stringify 时被转义放大
      files[name] = await b64encodeAsync(gz);
    }
    toEncrypt.files = files;
    toEncrypt.compressed = true;
    gzipMs = performance.now() - g0;
  }

  // 诊断日志：分阶段计时，定位大文件加密卡在哪个步骤（gzip / stringify / encode / AES / base64）
  const plaintext = new TextEncoder().encode(JSON.stringify(toEncrypt));
  const t1 = performance.now();
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const t2 = performance.now();
  const data = await b64encodeAsync(new Uint8Array(ciphertext));
  const t3 = performance.now();
  console.log(
    `[Encrypt] 明文 ${(plaintext.length / 1024 / 1024).toFixed(1)} MB（gzip=${toEncrypt.compressed ? "on" : "off"}）：gzip ${gzipMs.toFixed(0)} ms，stringify+encode ${(t1 - t0).toFixed(0)} ms，AES-GCM ${(t2 - t1).toFixed(0)} ms，base64 ${(t3 - t2).toFixed(0)} ms`,
  );
  return { iv: b64encode(iv), data };
}

/** 服务器解密还原上传 payload（供原有落盘逻辑继续使用） */
export async function decryptUploadPayload(enc: UploadEncrypted): Promise<UploadPayload> {
  const subtle = await getSubtle();
  const key = await importKey("decrypt");
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(enc.iv) },
    key,
    b64decode(enc.data),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as UploadPayload;
  // 客户端 gzip 压缩标记：files 各值为"gzip 后 Base64"，这里解压还原为明文内容
  if (payload.compressed && payload.files) {
    const files: Record<string, string> = {};
    for (const [name, data] of Object.entries(payload.files)) {
      files[name] = new TextDecoder().decode(await gunzipBytes(b64decode(data)));
    }
    payload.files = files;
  }
  return payload;
}
