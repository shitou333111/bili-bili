/**
 * 点歌听 · 软件内播放的短时流令牌
 *
 * 客户端播放音频时直连 /api/sing/stream，不能把服务器上的音乐账号变成公开代理，
 * 因此 Next 在解析/播放前签发一个带 HMAC 的短时令牌，流接口校验通过才反代到
 * 本机 music-service。令牌里只带取流必需的歌曲信息，不包含任何账号凭据。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SongRef } from "./types";

interface StreamPayload {
  /** 平台 */
  p: string;
  /** 平台歌曲 id */
  i: string;
  /** 播放专用 id（QQ 十进制 songid / 酷狗 mixsongid） */
  pd?: string;
  n?: string;
  a?: string;
  d?: number;
  /** 过期时间（epoch ms） */
  exp: number;
}

let secretCache: Buffer | null = null;

/** 流令牌密钥：优先环境变量，否则在 .data/sing/stream-secret 持久化一个随机值 */
async function streamSecret(): Promise<Buffer> {
  if (secretCache) return secretCache;
  const env = (process.env.INAPP_STREAM_SECRET || "").trim();
  if (env) {
    secretCache = Buffer.from(env, "utf8");
    return secretCache;
  }
  const file = path.join(process.cwd(), ".data", "sing", "stream-secret");
  try {
    const raw = (await fs.readFile(file, "utf8")).trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      secretCache = Buffer.from(raw, "hex");
      return secretCache;
    }
  } catch {
    /* 不存在就创建 */
  }
  const buf = crypto.randomBytes(32);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf.toString("hex"), { mode: 0o600 });
  secretCache = buf;
  return buf;
}

function sign(body: string, secret: Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

/** 默认令牌有效期：2 小时（点歌排队通常远短于此，播放中不会过期） */
const DEFAULT_TTL_MS = 2 * 60 * 60_000;

export async function createStreamUrl(
  song: SongRef,
  ttlMs = DEFAULT_TTL_MS,
): Promise<{ url: string; expiresAt: number }> {
  const payload: StreamPayload = {
    p: song.platform,
    i: song.id,
    pd: song.playId,
    n: song.name || undefined,
    a: song.artists?.join("/") || undefined,
    d: song.duration || undefined,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(body, await streamSecret());
  return { url: `/api/sing/stream?t=${body}.${sig}`, expiresAt: payload.exp };
}

export async function verifyStreamToken(
  token: string,
): Promise<{ ok: true; payload: StreamPayload } | { ok: false; error: string }> {
  const raw = (token || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return { ok: false, error: "bad_token" };
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = sign(body, await streamSecret());
  // 长度不同直接拒绝，长度相同时用 timingSafeEqual 防时序攻击
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return { ok: false, error: "bad_signature" };
  }
  let payload: StreamPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "bad_payload" };
  }
  if (!payload || typeof payload.p !== "string" || typeof payload.i !== "string") {
    return { ok: false, error: "bad_payload" };
  }
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
    return { ok: false, error: "expired" };
  }
  return { ok: true, payload };
}
