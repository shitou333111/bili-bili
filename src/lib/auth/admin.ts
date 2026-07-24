import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";

const STATE_DIR = path.join(process.cwd(), ".data");
const ADMIN_STATE_FILE = path.join(STATE_DIR, "admin-sessions.json");
const ADMIN_COOKIE_NAME = "admin_sid";

const ADMIN_USER = "admin";
const ADMIN_PASS = "333";

type AdminSession = {
  sid: string;
  loginAt: string;
};

async function ensureAdminFile() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  try {
    await fs.access(ADMIN_STATE_FILE);
  } catch {
    await fs.writeFile(ADMIN_STATE_FILE, JSON.stringify([]), "utf8");
  }
}

async function readAdminSessions(): Promise<AdminSession[]> {
  await ensureAdminFile();
  const raw = await fs.readFile(ADMIN_STATE_FILE, "utf8");
  try {
    return JSON.parse(raw) as AdminSession[];
  } catch {
    return [];
  }
}

async function writeAdminSessions(sessions: AdminSession[]) {
  await ensureAdminFile();
  await fs.writeFile(ADMIN_STATE_FILE, JSON.stringify(sessions, null, 2), "utf8");
}

export function verifyAdmin(username: string, password: string): boolean {
  return username === ADMIN_USER && password === ADMIN_PASS;
}

export async function createAdminSession(): Promise<string> {
  const sid = randomUUID();
  const sessions = await readAdminSessions();
  sessions.push({ sid, loginAt: new Date().toISOString() });
  await writeAdminSessions(sessions);
  return sid;
}

export async function validateAdminSession(sid: string | null): Promise<boolean> {
  if (!sid) return false;
  const sessions = await readAdminSessions();
  return sessions.some((s) => s.sid === sid);
}

export function getAdminCookieName() {
  return ADMIN_COOKIE_NAME;
}
