import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { saveAccountInfo } from "@/lib/user-data";

const STATE_DIR = path.join(process.cwd(), ".data");
const STATE_FILE = path.join(STATE_DIR, "web-login-state.json");
const SESSION_COOKIE_NAME = "bili_live_sid";
const USER_TOKEN_COOKIE_NAME = "bili_live_user_token";

// 文件写入互斥锁，防止并发写入导致 "Compaction failed" 错误
let writeLock: Promise<void> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

export type AuthSession = {
  sid: string;
  uname: string;
  mid: number;
  face?: string;
  biliSessdata: string;
  biliRefreshToken: string;
  biliCookies?: string[];
  source: "qr" | "dev" | "server";
  userToken: string; // 用户级别标识，用于隔离不同浏览器/设备的账号
  createdAt: string;
  updatedAt: string;
};

export type SessionState = {
  currentSid: string | null;
  sessions: AuthSession[];
};

const defaultState: SessionState = {
  currentSid: null,
  sessions: [],
};

async function ensureStateFile() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  try {
    await fs.access(STATE_FILE);
  } catch {
    await fs.writeFile(STATE_FILE, JSON.stringify(defaultState, null, 2), "utf8");
  }
}

export async function readState(): Promise<SessionState> {
  await ensureStateFile();
  let raw = await fs.readFile(STATE_FILE, "utf8");
  // 去除 UTF-8 BOM (EF BB BF)
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    return {
      currentSid: parsed.currentSid ?? null,
      sessions: parsed.sessions ?? [],
    };
  } catch {
    return defaultState;
  }
}

export async function writeState(state: SessionState) {
  await withWriteLock(async () => {
    await ensureStateFile();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  });
}

export async function getAllSessions(): Promise<AuthSession[]> {
  const state = await readState();
  return state.sessions;
}

export async function getCurrentSid(): Promise<string | null> {
  const state = await readState();
  return state.currentSid;
}

export function createSessionInput(input: Omit<AuthSession, "sid" | "createdAt" | "updatedAt">): AuthSession {
  const now = new Date();
  return {
    sid: randomUUID(),
    uname: input.uname,
    mid: input.mid,
    face: input.face,
    biliSessdata: input.biliSessdata,
    biliRefreshToken: input.biliRefreshToken,
    biliCookies: input.biliCookies,
    source: input.source,
    userToken: input.userToken,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function saveSession(session: AuthSession): Promise<AuthSession> {
  const effectiveSession = await withWriteLock(async () => {
    const state = await readState();
    // 先按 sid 找，找不到再按 mid（B站用户ID）找，避免同一账号重复
    let index = state.sessions.findIndex((item) => item.sid === session.sid);
    if (index < 0) {
      index = state.sessions.findIndex((item) => item.mid === session.mid);
    }
    let result: AuthSession;
    if (index >= 0) {
      // 保留原有 sid，更新其他信息
      const existingSid = state.sessions[index].sid;
      result = { ...session, sid: existingSid };
      state.sessions[index] = result;
      state.currentSid = existingSid;
    } else {
      result = session;
      state.sessions.unshift(session);
      state.currentSid = session.sid;
    }
    await ensureStateFile();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    return result;
  });
  // 保存用户个人信息到 account-info.json（供 admin 模式读取）
  if (effectiveSession.face) {
    saveAccountInfo(effectiveSession.mid, effectiveSession.uname, effectiveSession.face).catch(() => {});
  }
  return effectiveSession;
}

export async function getSessionBySid(sid: string | null | undefined) {
  if (!sid) return null;
  const state = await readState();
  return state.sessions.find((item) => item.sid === sid) ?? null;
}

export async function setCurrentSession(sid: string | null) {
  return withWriteLock(async () => {
    const state = await readState();
    state.currentSid = sid;
    await ensureStateFile();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  });
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export function getUserTokenCookieName() {
  return USER_TOKEN_COOKIE_NAME;
}

/**
 * 根据用户标识获取该用户的所有会话
 */
export async function getSessionsByUserToken(userToken: string | null | undefined): Promise<AuthSession[]> {
  if (!userToken) return [];
  const state = await readState();
  return state.sessions.filter((item) => item.userToken === userToken);
}

/**
 * 获取当前会话（通过 Cookie 中的 sid）
 * 注意：不再有过期检查，session 一旦创建就有效，直到被覆盖或删除
 */
export async function getActiveSessionFromCookie(cookieSid: string | null | undefined) {
  const session = await getSessionBySid(cookieSid);
  if (!session) return null;
  return session;
}

/**
 * 更新 session 的 B站凭证（refresh 成功后调用）
 */
export async function updateSessionCredentials(
  sid: string,
  credentials: {
    biliSessdata?: string;
    biliRefreshToken?: string;
    biliCookies?: string[];
  },
) {
  return withWriteLock(async () => {
    const state = await readState();
    const session = state.sessions.find((item) => item.sid === sid);
    if (!session) return null;

    if (credentials.biliSessdata) {
      session.biliSessdata = credentials.biliSessdata;
    }
    if (credentials.biliRefreshToken) {
      session.biliRefreshToken = credentials.biliRefreshToken;
    }
    if (credentials.biliCookies) {
      session.biliCookies = credentials.biliCookies;
    }
    session.updatedAt = new Date().toISOString();

    await ensureStateFile();
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    return session;
  });
}
