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

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: b64encode(iv), data: b64encode(new Uint8Array(ciphertext)) };
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
  return JSON.parse(new TextDecoder().decode(plaintext));
}
