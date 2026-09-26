/**
 * 浏览器侧离线缓存（WEB 端专用）
 *
 * 背景：WEB 端浏览器无法直连 B站（CORS 限制），所有 B站 数据都由服务器路由拉取后返回。
 * 一旦服务器不可达/断网，界面就没有任何可展示的数据。本模块用 IndexedDB 把服务器返回的
 * 业务数据（账号、消费记录、盲盒/合成/其他统计、认证信息）按账号(mid)隔离缓存，
 * 让"离线模式下使用本地缓存数据"真正成立。
 *
 * 约定：
 * - 客户端(Tauri)不启用：本地文件本身就是权威数据源，缓存没有意义。
 * - 按 mid 隔离键，切换账号不会串号；账号列表与"最近账号"是设备级键。
 * - 带版本号信封，版本不符视为未命中并删除旧值（升级数据结构时递增 CACHE_VERSION）。
 * - 所有操作静默失败：缓存属于增强能力，任何异常都不得阻塞主流程。
 */

const DB_NAME = "bili_live_cache";
const DB_VERSION = 1;
const STORE = "kv";
/** 缓存数据结构版本：不一致时旧值视为失效 */
const CACHE_VERSION = 1;

export const cacheKeys = {
  /** 本机账号列表（设备级） */
  accounts: "accounts",
  /** 最近一次使用的账号（设备级，用于离线秒显） */
  lastAccount: "last-account",
  /** 消费记录快照 */
  snapshot: (mid: number) => `snapshot:${mid}`,
  /** 盲盒统计 */
  blindBox: (mid: number) => `blindbox:${mid}`,
  /** 合成统计 */
  synthesis: (mid: number) => `synthesis:${mid}`,
  /** 其他统计 */
  other: (mid: number) => `other:${mid}`,
  /** 认证信息 */
  certification: (mid: number) => `certification:${mid}`,
};

type Envelope = { v: number; savedAt: number; data: unknown };

/** 缓存是否可用：无 IndexedDB（SSR/旧浏览器）或客户端(Tauri) 时一律不启用 */
function available(): boolean {
  if (typeof indexedDB === "undefined") return false;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return false;
  return true;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!available()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 读取缓存；未命中/版本不符/异常均返回 null */
export async function cacheGet<T>(key: string): Promise<{ data: T; savedAt: number } | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const env = await new Promise<Envelope | undefined>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as Envelope | undefined);
      req.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    });
    if (!env) return null;
    if (env.v !== CACHE_VERSION) {
      void cacheDelete(key);
      return null;
    }
    return { data: env.data as T, savedAt: env.savedAt };
  } catch {
    return null;
  }
}

/** 写入缓存（静默失败，含配额超限） */
export async function cacheSet<T>(key: string, data: T): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const env: Envelope = { v: CACHE_VERSION, savedAt: Date.now(), data };
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(env, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // 静默：缓存失败不影响主流程
  }
}

async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // 静默
  }
}

/** 清空某账号(mid)的所有缓存键（重建数据库后调用，避免旧数据回显） */
export async function cacheClearMid(mid: number): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const keys = await new Promise<string[]>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map((k) => String(k)));
      req.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    });
    const suffix = `:${mid}`;
    await Promise.all(keys.filter((k) => k.endsWith(suffix)).map((k) => cacheDelete(k)));
  } catch {
    // 静默
  }
}