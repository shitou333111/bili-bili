/**
 * 自动抢天选/红包 —— 服务端扫描引擎
 *
 * 为什么放到服务器：扫描过程对所有客户端完全相同，没必要每个客户端各扫一遍；
 * 由服务器统一慢速持续扫描，结果供所有客户端读取，客户端只负责"抢"。
 *
 * 设计要点：
 * - 天选扫描使用匿名接口 getLotteryInfoWeb（实测无需登录、Wbi 签名即可），避免登录凭证高频消耗；
 * - 红包扫描需要登录（RedPocketActiveList 匿名返回 -101），因此使用 admin 配置的专用扫描账号；
 * - 请求严格串行 + 固定间隔 + 命中风控(-352/-412)指数退避，频率慢但持续；
 * - 结果按"单份礼物价值"阈值过滤（默认 50 电池）；
 * - 天选风控判断：要求送礼/大航海一律跳过（实物天选往往要求送贵重礼物），粉丝团/免费可参与；
 * - 常发红包直播间：达到阈值的红包房间永久记录并按次数排序，每轮先确认在播再扫描。
 */

import { promises as fs } from "fs";
import path from "path";
import { fetchBilibiliJson, getBuvidCookie } from "./bilibili/client";
import { ensureGiftCatalogLoaded, getGiftList, getGiftPrice } from "./gift-catalog";
import { md5 } from "./md5";

const STATE_DIR = path.join(process.cwd(), ".data");
const CONFIG_FILE = path.join(STATE_DIR, "lottery-scan-config.json");
const STATE_FILE = path.join(STATE_DIR, "lottery-scan-state.json");
const HISTORY_FILE = path.join(STATE_DIR, "lottery-scan-history.json");

/** 1 电池 = 100 金瓜子 */
const GOLD_PER_BATTERY = 100;
/** 单轮最多扫描房间数（超出时优先保留自定义/常发红包/人气，裁剪分区热门） */
const MAX_ROOMS_PER_ROUND = 1500;
/** 分区热门接口每页条数（实测上限 30） */
const HOT_PARTITION_PAGE_SIZE = 30;
/** 常发红包直播间最多保留数量 */
const MAX_HISTORY_ROOMS = 2000;
/** 常发红包热度半衰期：2 天（近期记录权重更高） */
const HISTORY_HALF_LIFE_MS = 2 * 24 * 60 * 60 * 1000;
/** 结果最多保留条数 */
const MAX_RESULTS = 400;
/** 开奖后结果在快照中继续保留的秒数（供客户端暂留展示开奖结果） */
const RESULT_LINGER_SEC = 8;
/** 限流事件最多保留条数 */
const MAX_RATE_LIMIT_EVENTS = 60;
/** 运行日志最多保留条数 */
const MAX_LOGS = 120;

const HOT_ROOM_PARTITIONS = [
  { id: 1, name: "娱乐" }, { id: 2, name: "网游" }, { id: 3, name: "手游" },
  { id: 5, name: "电台" }, { id: 6, name: "单机游戏" }, { id: 9, name: "虚拟主播" },
  { id: 10, name: "生活" }, { id: 11, name: "知识" }, { id: 13, name: "赛事" },
  { id: 14, name: "聊天室" }, { id: 15, name: "互动玩法" }, { id: 16, name: "购物" },
  { id: 301, name: "帮我玩" },
];

// ===== 类型 =====

export type RoomSource = "custom" | "history" | "rank" | "hot";

export type ScanRoom = {
  roomid: number;
  uid: number;
  uname: string;
  face: string;
  title: string;
  source: RoomSource;
  /** 分区名称（仅 source=hot 时有值），用于结果来源标注 */
  areaName?: string;
};

export type ScanResult = {
  /** 唯一 key：lottery:{id} / red:{lotId} */
  key: string;
  kind: "lottery" | "red_pocket";
  roomId: number;
  uid: number;
  uname: string;
  face: string;
  title: string;
  source: RoomSource;
  /** 分区名称（仅 source=hot 时有值） */
  areaName?: string;
  /** 单份礼物价值（电池） */
  value: number;
  /** 开奖时间（unix 秒） */
  endTime: number;
  foundAt: number;
  /** 天选字段 */
  lotteryId?: number;
  awardName?: string;
  awardNum?: number;
  awardImage?: string;
  danmu?: string;
  requireText?: string;
  requireType?: number;
  /** 红包字段 */
  lotId?: number;
  rpType?: number;
  totalPrice?: number;
  awards?: { giftId: number; giftName: string; num: number; giftPic: string }[];
};

export type RateLimitEvent = {
  at: number;
  endpoint: "lottery" | "red_pocket";
  code: number;
  streak: number;
  cooldownMs: number;
  message: string;
};

export type ScanLog = { at: number; msg: string; type: "info" | "success" | "warn" | "error" };

export type ScanAccount = {
  cookie: string;
  csrf: string;
  uid: number;
  uname: string;
  updatedAt: string;
};

export type CustomRoom = {
  uid: number;
  roomid: number;
  uname: string;
  face: string;
  title?: string;
};

export type ScanConfig = {
  enabled: boolean;
  /** 单份礼物最低价值（电池），默认 50 */
  minValue: number;
  /** 两轮扫描之间的间隔（毫秒），默认 5 分钟 */
  scanIntervalMs: number;
  /** 天选请求最小间隔（毫秒） */
  requestIntervalMs: number;
  /** 红包请求最小间隔（毫秒） */
  redIntervalMs: number;
  /** 每个分区取前 N 个热门直播间 */
  hotRoomsPerPartition: number;
  account: ScanAccount | null;
  customRooms: CustomRoom[];
};

export type HistoryRoom = {
  roomid: number;
  uid: number;
  uname: string;
  face: string;
  /** 达到阈值的红包出现次数 */
  count: number;
  lastAt: number;
  /** 最近记录过的红包 id，避免同一红包被重复计数 */
  lastLotIds: number[];
  /**
   * 热度分（用于 2000 上限淘汰）：
   * 每次出现累加「数量权重 + 金额权重」，并按半衰期随时间衰减，近期记录权重更高。
   * 旧数据没有该字段时回退用 count。
   */
  hot?: number;
};

export type RoundStats = {
  rooms: number;
  lottery: number;
  red: number;
  skipped: number;
  failed: number;
  durationMs: number;
};

export type ScanState = {
  scanning: boolean;
  lastScanAt: number | null;
  lastScanFinishedAt: number | null;
  nextScanAt: number | null;
  /** 当前轮进度 */
  progress: { done: number; total: number; currentRoom: number | null };
  results: ScanResult[];
  rateLimitEvents: RateLimitEvent[];
  lastRound: RoundStats | null;
  logs: ScanLog[];
  /** 扫描账号最近一次校验结果 */
  accountStatus: { valid: boolean; mid: number; uname: string; checkedAt: number; message: string } | null;
};

const DEFAULT_CONFIG: ScanConfig = {
  enabled: false,
  minValue: 50,
  scanIntervalMs: 5 * 60 * 1000,
  requestIntervalMs: 450,
  redIntervalMs: 450,
  hotRoomsPerPartition: 100,
  account: null,
  customRooms: [],
};

const DEFAULT_STATE: ScanState = {
  scanning: false,
  lastScanAt: null,
  lastScanFinishedAt: null,
  nextScanAt: null,
  progress: { done: 0, total: 0, currentRoom: null },
  results: [],
  rateLimitEvents: [],
  lastRound: null,
  logs: [],
  accountStatus: null,
};

// ===== Wbi 签名 =====

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
let cachedMixinKey: { key: string; ts: number } | null = null;

function getMixinKey(raw: string): string {
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join("").slice(0, 32);
}

async function fetchMixinKey(): Promise<string> {
  if (cachedMixinKey && Date.now() - cachedMixinKey.ts < 25 * 60 * 1000) {
    return cachedMixinKey.key;
  }
  const data = await fetchBilibiliJson<{
    code: number;
    data?: { wbi_img?: { img_url: string; sub_url: string } };
  }>({
    url: "https://api.bilibili.com/x/web-interface/nav",
    cookie: await getBuvidCookie(),
    live: true,
  });
  const imgKey = data.data?.wbi_img?.img_url?.split("/").pop()?.split(".")[0] ?? "";
  const subKey = data.data?.wbi_img?.sub_url?.split("/").pop()?.split(".")[0] ?? "";
  if (!imgKey || !subKey) throw new Error("获取 Wbi 密钥失败");
  const key = getMixinKey(imgKey + subKey);
  cachedMixinKey = { key, ts: Date.now() };
  return key;
}

async function signWbi(params: Record<string, string>): Promise<Record<string, string>> {
  const mixinKey = await fetchMixinKey();
  const wts = String(Math.floor(Date.now() / 1000));
  const signed: Record<string, string> = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k].replace(/[!'()*]/g, ""))}`)
    .join("&");
  return { ...signed, w_rid: md5(query + mixinKey) };
}

// ===== 通用工具 =====

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const nowSec = () => Math.floor(Date.now() / 1000);

function fixFaceUrl(url: string): string {
  if (!url || /\/noface\.jpg$/.test(url)) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

async function ensureDir() {
  await fs.mkdir(STATE_DIR, { recursive: true });
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, data: unknown) {
  await ensureDir();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

// ===== 引擎单例 =====

type EndpointRate = {
  /** 下一次允许请求的时间戳 */
  nextAt: number;
  /** 冷却截止时间 */
  blockedUntil: number;
  /** 连续命中风控次数 */
  streak: number;
};

type Engine = {
  config: ScanConfig;
  state: ScanState;
  history: HistoryRoom[];
  loaded: boolean;
  loading: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  roundInFlight: boolean;
  lotteryRate: EndpointRate;
  redRate: EndpointRate;
  /** 扫描结果版本号：结果有任何新增/变化时 +1，供客户端长轮询感知 */
  generation: number;
  /** 等待结果变化的客户端回调（长轮询） */
  waiters: Set<() => void>;
};

const G = globalThis as unknown as { __biliLotteryScan?: Engine };

function engine(): Engine {
  if (!G.__biliLotteryScan) {
    G.__biliLotteryScan = {
      config: { ...DEFAULT_CONFIG, customRooms: [] },
      state: { ...DEFAULT_STATE, results: [], rateLimitEvents: [], logs: [] },
      history: [],
      loaded: false,
      loading: null,
      timer: null,
      roundInFlight: false,
      lotteryRate: { nextAt: 0, blockedUntil: 0, streak: 0 },
      redRate: { nextAt: 0, blockedUntil: 0, streak: 0 },
      generation: 0,
      waiters: new Set(),
    };
  }
  return G.__biliLotteryScan;
}

/** 通知所有等待中的客户端：扫描结果有更新 */
function notifyChange() {
  const e = engine();
  e.generation += 1;
  for (const resolve of e.waiters) resolve();
  e.waiters.clear();
}

/**
 * 合并本轮结果到快照：保留上一版中尚未超出保留期的结果（含刚开奖的），
 * 避免开奖瞬间结果被新一轮扫描结果整体替换而立刻消失。
 */
function commitResults(next: ScanResult[], notify: boolean): void {
  const e = engine();
  const t = nowSec();
  const map = new Map<string, ScanResult>();
  for (const r of e.state.results) {
    if (r.endTime + RESULT_LINGER_SEC > t) map.set(r.key, r);
  }
  for (const r of next) map.set(r.key, r);
  e.state.results = [...map.values()]
    .filter((r) => r.endTime + RESULT_LINGER_SEC > t)
    .sort((a, b) => a.endTime - b.endTime)
    .slice(-MAX_RESULTS);
  if (notify) notifyChange();
}

function addLog(msg: string, type: ScanLog["type"] = "info") {
  const e = engine();
  e.state.logs.push({ at: Date.now(), msg, type });
  if (e.state.logs.length > MAX_LOGS) e.state.logs = e.state.logs.slice(-MAX_LOGS);
}

async function ensureLoaded(): Promise<void> {
  const e = engine();
  if (e.loaded) return;
  if (e.loading) return e.loading;
  e.loading = (async () => {
    const [cfg, st, hist] = await Promise.all([
      readJsonFile<Partial<ScanConfig>>(CONFIG_FILE, {}),
      readJsonFile<Partial<ScanState>>(STATE_FILE, {}),
      readJsonFile<HistoryRoom[] | { rooms?: HistoryRoom[] }>(HISTORY_FILE, []),
    ]);
    const rawHistory = Array.isArray(hist) ? hist : (hist.rooms ?? []);
    e.config = {
      ...DEFAULT_CONFIG,
      ...cfg,
      account: cfg.account ?? null,
      customRooms: Array.isArray(cfg.customRooms) ? cfg.customRooms : [],
      minValue: Math.max(0, num(cfg.minValue) || DEFAULT_CONFIG.minValue),
      scanIntervalMs: Math.max(60_000, num(cfg.scanIntervalMs) || DEFAULT_CONFIG.scanIntervalMs),
      requestIntervalMs: Math.max(200, num(cfg.requestIntervalMs) || DEFAULT_CONFIG.requestIntervalMs),
      redIntervalMs: Math.max(200, num(cfg.redIntervalMs) || DEFAULT_CONFIG.redIntervalMs),
      hotRoomsPerPartition: Math.max(0, num(cfg.hotRoomsPerPartition) || DEFAULT_CONFIG.hotRoomsPerPartition),
    };
    e.state = {
      ...DEFAULT_STATE,
      ...st,
      scanning: false,
      progress: { done: 0, total: 0, currentRoom: null },
      results: Array.isArray(st.results) ? st.results : [],
      rateLimitEvents: Array.isArray(st.rateLimitEvents) ? st.rateLimitEvents : [],
      logs: Array.isArray(st.logs) ? st.logs : [],
    };
    e.history = rawHistory
      .filter((r) => r && num(r.roomid) > 0)
      .map((r) => ({
        roomid: num(r.roomid),
        uid: num(r.uid),
        uname: String(r.uname ?? ""),
        face: String(r.face ?? ""),
        count: Math.max(1, num(r.count) || 1),
        lastAt: num(r.lastAt) || Date.now(),
        lastLotIds: Array.isArray(r.lastLotIds) ? r.lastLotIds.map(num) : [],
        hot: num(r.hot) || 0,
      }));
    // 旧数据没有 hot 字段时回退为 count，避免热度全部为 0
    for (const h of e.history) if (!h.hot) h.hot = h.count;
    pruneHistory();
    e.loaded = true;
    e.loading = null;
    addLog("扫描引擎已从本地数据恢复");
    startLoop();
  })();
  return e.loading;
}

async function saveConfig() {
  await writeJsonFile(CONFIG_FILE, engine().config);
}

async function saveState() {
  await writeJsonFile(STATE_FILE, engine().state);
}

async function saveHistory() {
  await writeJsonFile(HISTORY_FILE, engine().history);
}

// ===== 限流与节奏控制 =====

function rateOf(endpoint: "lottery" | "red_pocket"): EndpointRate {
  return endpoint === "lottery" ? engine().lotteryRate : engine().redRate;
}

/** 等待到允许的请求时刻并占用下一个时间片 */
async function pace(endpoint: "lottery" | "red_pocket", intervalMs: number): Promise<boolean> {
  const rate = rateOf(endpoint);
  const now = Date.now();
  if (now < rate.blockedUntil) return false;
  const wait = rate.nextAt - now;
  if (wait > 0) await sleep(wait);
  rate.nextAt = Date.now() + intervalMs;
  return true;
}

/** 记录限流事件并进入指数退避 */
function recordRateLimit(endpoint: "lottery" | "red_pocket", code: number, message: string) {
  const e = engine();
  const rate = rateOf(endpoint);
  rate.streak += 1;
  const cooldown = Math.min(10 * 60 * 1000, 15_000 * 2 ** (rate.streak - 1));
  rate.blockedUntil = Date.now() + cooldown;
  rate.nextAt = Math.max(rate.nextAt, rate.blockedUntil);
  e.state.rateLimitEvents.push({
    at: Date.now(),
    endpoint,
    code,
    streak: rate.streak,
    cooldownMs: cooldown,
    message,
  });
  if (e.state.rateLimitEvents.length > MAX_RATE_LIMIT_EVENTS) {
    e.state.rateLimitEvents = e.state.rateLimitEvents.slice(-MAX_RATE_LIMIT_EVENTS);
  }
  addLog(
    `${endpoint === "lottery" ? "天选" : "红包"}接口触发限流 ${code}（连续第 ${rate.streak} 次），冷却 ${Math.round(cooldown / 1000)} 秒`,
    "warn",
  );
}

function resetRate(endpoint: "lottery" | "red_pocket") {
  const rate = rateOf(endpoint);
  rate.streak = 0;
  rate.blockedUntil = 0;
}

// ===== B站 接口 =====

type BiliResponse<T> = { code: number; message?: string; msg?: string; data?: T };

/** 单个请求最长等待时间：避免个别请求长时间挂起拖慢整轮扫描 */
const REQUEST_TIMEOUT_MS = 7000;

async function biliGet<T>(url: string, cookie?: string): Promise<BiliResponse<T> | null> {
  try {
    const result = await Promise.race([
      fetchBilibiliJson<BiliResponse<T>>({ url, cookie, live: true }),
      sleep(REQUEST_TIMEOUT_MS).then(() => null),
    ]);
    if (result === null) {
      console.warn(`[LotteryScan] 请求超时 ${url}`);
      return null;
    }
    return result;
  } catch (err) {
    console.warn(`[LotteryScan] 请求异常 ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 获取扫描账号的 cookie（含设备指纹） */
async function scanAccountCookie(): Promise<string | null> {
  const account = engine().config.account;
  if (!account?.cookie) return null;
  const buvid = await getBuvidCookie().catch(() => "");
  return buvid ? `${buvid}; ${account.cookie}` : account.cookie;
}

/** 获取匿名扫描 cookie（仅设备指纹，不含登录凭证） */
async function anonCookie(): Promise<string | undefined> {
  const buvid = await getBuvidCookie().catch(() => "");
  return buvid || undefined;
}

// ----- 天选检测 -----

type LotteryAnchor = {
  id?: number;
  room_id?: number;
  status?: number;
  award_name?: string;
  award_num?: number;
  award_image?: string;
  award_price?: number;
  award_type?: number;
  danmu?: string;
  time?: number;
  current_time?: number;
  require_text?: string;
  require_type?: number;
  ruid?: number;
};

async function fetchLotteryAnchor(roomId: number): Promise<LotteryAnchor | null> {
  const e = engine();
  const ok = await pace("lottery", e.config.requestIntervalMs);
  if (!ok) return null;
  const signed = await signWbi({ roomid: String(roomId), web_location: "444.8", platform: "web" });
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/lottery/getLotteryInfoWeb?${new URLSearchParams(signed).toString()}`;
  const res = await biliGet<{ anchor?: LotteryAnchor | null }>(url, await anonCookie());
  if (!res) return null;
  if (res.code === -352 || res.code === -412) {
    recordRateLimit("lottery", res.code, res.message || res.msg || "触发风控");
    return null;
  }
  if (res.code !== 0) {
    resetRate("lottery");
    return null;
  }
  resetRate("lottery");
  return res.data?.anchor ?? null;
}

/** 天选奖品单份价值（电池）：优先 award_price（金瓜子），否则按礼物名查目录 */
function lotteryValue(anchor: LotteryAnchor): number {
  const gold = num(anchor.award_price);
  if (gold > 0) return Math.round(gold / GOLD_PER_BATTERY);
  const name = String(anchor.award_name ?? "");
  if (!name) return 0;
  const gift = getGiftList().find((g) => g.name === name);
  if (gift?.coin_type === "gold" && num(gift.price) > 0) {
    return Math.round(num(gift.price) / GOLD_PER_BATTERY);
  }
  return 0;
}

/**
 * 天选是否应跳过（赠送礼物 / 大航海 / 实物）。
 * 粉丝团（require_type=2）与免费参与允许；粉丝牌自动赠送是常见且可接受的条件。
 */
function shouldSkipLottery(anchor: LotteryAnchor): string | null {
  const requireText = String(anchor.require_text ?? "");
  const requireType = num(anchor.require_type);
  const awardName = String(anchor.award_name ?? "");
  const awardType = anchor.award_type;

  // 大航海/舰长等需付费开通的条件
  if (requireType === 3) return "参与条件为大航海";
  if (/大航海|舰长|提督|总督|守护/.test(requireText)) return "参与条件为付费舰队";

  // 粉丝团/粉丝牌会自动赠送一个粉丝牌，属于可接受条件（非常普遍），不按"送礼"跳过
  const fansMedal = /粉丝团|粉丝牌|粉丝勋章|灯牌/.test(requireText);

  // 需要送礼物（任意礼物都跳过：实物天选常以贵重礼物为参与条件）
  if (!fansMedal && /送出|赠送|送礼|送.{0,4}礼物|发送.{0,4}礼物|购买|打赏|电池.{0,3}送/.test(requireText)) {
    return `参与条件需送礼：${requireText}`;
  }

  // 实物天选：价值无法按礼物单价衡量，且高风险，直接跳过
  const physical = awardType === 0 || /实物|手办|周边|模型|抱枕|立牌|门票|快递|奖杯/.test(awardName);
  if (physical) return `实物天选（${awardName}）`;

  return null;
}

async function scanRoomLottery(room: ScanRoom): Promise<ScanResult | null> {
  const anchor = await fetchLotteryAnchor(room.roomid);
  if (!anchor?.id) return null;
  if (num(anchor.status) !== 1) return null;
  const endTime = num(anchor.current_time) + num(anchor.time);
  if (endTime <= nowSec()) return null;

  const skip = shouldSkipLottery(anchor);
  if (skip) {
    addLog(`跳过天选 #${anchor.id}（${room.uname}）：${skip}`, "info");
    return null;
  }

  const value = lotteryValue(anchor);
  if (value < engine().config.minValue) return null;

  return {
    key: `lottery:${anchor.id}`,
    kind: "lottery",
    roomId: room.roomid,
    uid: room.uid,
    uname: room.uname,
    face: room.face,
    title: room.title,
    source: room.source,
    areaName: room.areaName,
    value,
    endTime,
    foundAt: Date.now(),
    lotteryId: num(anchor.id),
    awardName: String(anchor.award_name ?? "天选"),
    awardNum: num(anchor.award_num) || 1,
    awardImage: String(anchor.award_image ?? ""),
    danmu: String(anchor.danmu ?? ""),
    requireText: String(anchor.require_text ?? ""),
    requireType: num(anchor.require_type),
  };
}

// ----- 红包检测 -----

type RedPocketItem = {
  lot_id?: number;
  awards?: { gift_id?: number; num?: number; gift_name?: string; gift_pic?: string }[];
  end_time?: number;
  current_time?: number;
  lot_status?: number;
  user_status?: number;
  rp_type?: number;
  total_price?: number;
  icon_url?: string;
};

const RED_POCKET_STATISTICS = JSON.stringify({ appId: 1, version: "9.8.0", abtest: "", platform: 3 });

async function fetchRedPockets(roomId: number): Promise<RedPocketItem[] | null> {
  const e = engine();
  const account = e.config.account;
  if (!account) return null;
  const ok = await pace("red_pocket", e.config.redIntervalMs);
  if (!ok) return null;

  const signed = await signWbi({
    csrf: account.csrf,
    mobi_app: "android",
    platform: "android",
    room_id: String(roomId),
    statistics: RED_POCKET_STATISTICS,
    web_location: "444.248",
  });
  const url = `https://api.live.bilibili.com/xlive/lottery-interface/v1/popularityRedPocket/RedPocketActiveList?${new URLSearchParams(signed).toString()}`;
  const res = await biliGet<{ list?: RedPocketItem[] }>(url, (await scanAccountCookie()) ?? undefined);
  if (!res) return null;

  if (res.code === -352 || res.code === -412) {
    recordRateLimit("red_pocket", res.code, res.message || res.msg || "触发风控");
    return null;
  }
  if (res.code === -101 || res.code === -111) {
    // 扫描账号失效
    e.state.accountStatus = {
      valid: false,
      mid: account.uid,
      uname: account.uname,
      checkedAt: Date.now(),
      message: "扫描账号登录已失效，请到管理后台重新配置 Cookie",
    };
    addLog("红包扫描账号登录已失效（-101），红包扫描暂停", "error");
    return null;
  }
  if (res.code !== 0) {
    resetRate("red_pocket");
    return null;
  }
  resetRate("red_pocket");
  const list = res.data?.list ?? [];
  return list.filter((rp) => num(rp.lot_status) === 1 && num(rp.rp_type) !== 4);
}

/** 红包单份价值（电池） */
function redPocketValue(rp: RedPocketItem): number {
  const awards = rp.awards ?? [];
  const rpType = num(rp.rp_type);
  if (rpType === 3 || rpType === 5) {
    const shares = awards.reduce((s, a) => s + num(a.num), 0) || 0;
    const totalBattery = Math.floor(num(rp.total_price) / GOLD_PER_BATTERY);
    return shares > 0 ? Math.floor(totalBattery / shares) : totalBattery;
  }
  // 礼物红包：取单个礼物最大价值
  return Math.max(0, ...awards.map((a) => getGiftPrice(num(a.gift_id))));
}

function collectRedResults(room: ScanRoom, list: RedPocketItem[]): ScanResult[] {
  const out: ScanResult[] = [];
  const minValue = engine().config.minValue;
  for (const rp of list) {
    const lotId = num(rp.lot_id);
    if (!lotId) continue;
    const endTime = num(rp.end_time);
    if (endTime <= nowSec()) continue;
    const value = redPocketValue(rp);
    if (value < minValue) continue;
    out.push({
      key: `red:${lotId}`,
      kind: "red_pocket",
      roomId: room.roomid,
      uid: room.uid,
      uname: room.uname,
      face: room.face,
      title: room.title,
      source: room.source,
      areaName: room.areaName,
      value,
      endTime,
      foundAt: Date.now(),
      lotId,
      rpType: num(rp.rp_type),
      totalPrice: num(rp.total_price),
      // 按单份礼物价值降序，awards[0] 即价值最高的奖品（UI 只展示这一个）
      awards: (rp.awards ?? [])
        .map((a) => ({
          giftId: num(a.gift_id),
          giftName: String(a.gift_name ?? ""),
          num: num(a.num),
          giftPic: String(a.gift_pic ?? ""),
        }))
        .sort((a, b) => getGiftPrice(b.giftId) - getGiftPrice(a.giftId)),
    });
  }
  return out;
}

// ----- 房间列表 -----

type RoomListEntry = {
  roomid?: number; uid?: number; title?: string; uname?: string;
  online?: number; face?: string;
  parent_id?: number; area_id?: number; area_name?: string;
  area_v2_parent_id?: number; area_v2_id?: number; area_v2_name?: string;
};

async function fetchHotRankRooms(): Promise<ScanRoom[]> {
  const signed = await signWbi({ web_location: "444.7" });
  const url = `https://api.live.bilibili.com/xlive/web-interface/v1/index/getHotRankList?${new URLSearchParams(signed).toString()}`;
  const res = await biliGet<{ list?: RoomListEntry[] }>(url, await anonCookie());
  if (!res || res.code !== 0) return [];
  return (res.data?.list ?? [])
    .filter((r) => num(r.roomid) > 0)
    .slice(0, 60)
    .map((r) => ({
      roomid: num(r.roomid),
      uid: num(r.uid),
      uname: String(r.uname ?? ""),
      face: fixFaceUrl(String(r.face ?? "")),
      title: String(r.title ?? ""),
      source: "rank" as const,
    }));
}

async function fetchHotPartitionRooms(limit: number): Promise<ScanRoom[]> {
  if (limit <= 0) return [];
  const out: ScanRoom[] = [];
  const maxPages = Math.max(1, Math.ceil(limit / HOT_PARTITION_PAGE_SIZE));
  for (const partition of HOT_ROOM_PARTITIONS) {
    const seen = new Set<number>();
    let taken = 0;
    // 单页上限 30，按配置的每区热门数翻页抓取
    for (let page = 1; page <= maxPages && taken < limit; page++) {
      const params = new URLSearchParams({
        parent_area_id: String(partition.id),
        area_id: "0",
        page: String(page),
        page_size: String(HOT_PARTITION_PAGE_SIZE),
        sort_type: "online",
      });
      const url = `https://api.live.bilibili.com/room/v1/area/getRoomList?${params.toString()}`;
      const res = await biliGet<RoomListEntry[] | { list?: RoomListEntry[] }>(url, await anonCookie());
      if (!res || res.code !== 0) break;
      const list = Array.isArray(res.data) ? res.data : (res.data?.list ?? []);
      if (list.length === 0) break;
      for (const r of list) {
        const roomid = num(r.roomid);
        if (!roomid || seen.has(roomid)) continue;
        seen.add(roomid);
        out.push({
          roomid,
          uid: num(r.uid),
          uname: String(r.uname ?? ""),
          face: fixFaceUrl(String(r.face ?? "")),
          title: String(r.title ?? ""),
          source: "hot",
          // 展示一级分区名（娱乐/网游/虚拟主播…），而不是接口返回的二级分区名
          areaName: partition.name,
        });
        taken += 1;
        if (taken >= limit) break;
      }
      // 不满一页说明已到最后一页
      if (list.length < HOT_PARTITION_PAGE_SIZE) break;
    }
  }
  return out;
}

type RoomInfoOld = {
  roomid?: number;
  uid?: number;
  liveStatus?: number;
  live_status?: number;
  title?: string;
};

/** 通过 UID 查询直播间信息（公开接口，无需登录） */
export async function resolveRoomByUid(uid: number): Promise<{ roomid: number; uname: string; face: string; title: string; live: boolean } | null> {
  const res = await biliGet<RoomInfoOld>(
    `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${uid}`,
    await anonCookie(),
  );
  const roomid = num(res?.data?.roomid);
  if (!res || res.code !== 0 || roomid <= 0) return null;
  const live = num(res.data?.liveStatus ?? res.data?.live_status) === 1;
  let uname = `UID${uid}`;
  let face = "";
  const card = await biliGet<{ uname?: string; face?: string }>(
    `https://api.live.bilibili.com/live_user/v1/card/card_up?uid=${uid}&browser=0`,
    await anonCookie(),
  );
  if (card?.code === 0 && card.data) {
    uname = card.data.uname || uname;
    face = fixFaceUrl(card.data.face ?? "");
  }
  return { roomid, uname, face, title: String(res.data?.title ?? ""), live };
}

/** 常发红包直播间：先确认在播，未开播略过 */
async function collectHistoryRooms(): Promise<ScanRoom[]> {
  const out: ScanRoom[] = [];
  const e = engine();
  const now = Date.now();
  // 近年热度高的优先收集（单轮房间数有上限，冷门直播间可能轮不到）
  for (const h of [...e.history].sort((a, b) => effectiveHot(b, now) - effectiveHot(a, now))) {
    const res = await biliGet<RoomInfoOld>(
      `https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${h.uid}`,
      await anonCookie(),
    );
    if (!res || res.code !== 0) continue;
    const live = num(res.data?.liveStatus ?? res.data?.live_status) === 1;
    if (!live) continue;
    const roomid = num(res.data?.roomid) || h.roomid;
    out.push({
      roomid,
      uid: h.uid,
      uname: h.uname || `UID${h.uid}`,
      face: h.face,
      title: String(res.data?.title ?? ""),
      source: "history",
    });
  }
  return out;
}

async function collectRooms(): Promise<ScanRoom[]> {
  const e = engine();
  addLog("开始收集扫描直播间列表…");
  const custom = e.config.customRooms
    .filter((r) => num(r.roomid) > 0)
    .map((r) => ({
      roomid: num(r.roomid),
      uid: num(r.uid),
      uname: String(r.uname ?? ""),
      face: String(r.face ?? ""),
      title: String(r.title ?? ""),
      source: "custom" as const,
    }));
  const history = await collectHistoryRooms();
  const rank = await fetchHotRankRooms();
  const hot = await fetchHotPartitionRooms(e.config.hotRoomsPerPartition);

  const merged: ScanRoom[] = [];
  const seen = new Set<number>();
  for (const list of [custom, history, rank, hot]) {
    for (const room of list) {
      if (seen.has(room.roomid)) continue;
      seen.add(room.roomid);
      merged.push(room);
      if (merged.length >= MAX_ROOMS_PER_ROUND) break;
    }
    if (merged.length >= MAX_ROOMS_PER_ROUND) break;
  }
  addLog(`收集完成：自定义 ${custom.length}、常发红包 ${history.length}、人气 ${rank.length}、分区热门 ${hot.length}，去重后 ${merged.length}`);
  return merged;
}

// ===== 历史（常发红包直播间） =====

/**
 * 单个红包对热度的贡献：基础 1 分（数量），再按金额加权（50 电池约 +1 分，最高 +4 分）。
 * 这样「多」和「大」都能提分，但不会让单个巨额红包无限压过大量小红包。
 */
function redHotWeight(value: number): number {
  return 1 + Math.min(4, Math.max(0, Number(value) || 0) / 50);
}

/** 当前有效热度：按 lastAt 做半衰期衰减（半衰期 2 天） */
function effectiveHot(h: HistoryRoom, nowMs = Date.now()): number {
  const base = h.hot ?? h.count;
  const dt = Math.max(0, nowMs - (h.lastAt || 0));
  return base * Math.pow(0.5, dt / HISTORY_HALF_LIFE_MS);
}

/** 超出上限时按有效热度淘汰最冷门的直播间 */
function pruneHistory(): void {
  const e = engine();
  if (e.history.length <= MAX_HISTORY_ROOMS) return;
  const now = Date.now();
  const sorted = [...e.history].sort((a, b) => effectiveHot(b, now) - effectiveHot(a, now));
  const removed = sorted.length - MAX_HISTORY_ROOMS;
  e.history = sorted.slice(0, MAX_HISTORY_ROOMS);
  addLog(`常发红包直播间超过 ${MAX_HISTORY_ROOMS} 个，已按近期热度淘汰 ${removed} 个`, "warn");
}

function recordHistoryRedPacket(room: ScanRoom, lots: { lotId: number; value?: number }[]) {
  const e = engine();
  const now = Date.now();
  for (const { lotId, value } of lots) {
    let entry = e.history.find((h) => h.roomid === room.roomid || (room.uid > 0 && h.uid === room.uid));
    if (!entry) {
      entry = {
        roomid: room.roomid,
        uid: room.uid,
        uname: room.uname,
        face: room.face,
        count: 0,
        lastAt: 0,
        lastLotIds: [],
        hot: 0,
      };
      e.history.push(entry);
    }
    if (entry.lastLotIds.includes(lotId)) continue;
    // 先按时间衰减旧热度，再累加本次红包的权重
    entry.hot = effectiveHot(entry, now) + redHotWeight(value ?? 0);
    entry.count += 1;
    entry.lastAt = now;
    entry.roomid = room.roomid;
    entry.uid = room.uid || entry.uid;
    entry.uname = room.uname || entry.uname;
    entry.face = room.face || entry.face;
    entry.lastLotIds = [...entry.lastLotIds, lotId].slice(-50);
  }
  pruneHistory();
}

// ===== 单轮扫描 =====

async function runRound(): Promise<void> {
  const e = engine();
  if (e.roundInFlight) return;
  e.roundInFlight = true;
  e.state.scanning = true;
  e.state.lastScanAt = Date.now();
  e.state.nextScanAt = null;
  e.state.accountStatus = e.config.account
    ? { valid: true, mid: e.config.account.uid, uname: e.config.account.uname, checkedAt: Date.now(), message: "" }
    : null;
  const startedAt = Date.now();
  addLog("开始一轮扫描");
  try {
    await ensureGiftCatalogLoaded().catch(() => {});
    const rooms = await collectRooms();
    e.state.progress = { done: 0, total: rooms.length, currentRoom: null };
    const results: ScanResult[] = [];
    const foundRedLots = new Map<number, { room: ScanRoom; lots: { lotId: number }[] }>();
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < rooms.length; i++) {
      if (!e.config.enabled) {
        addLog("扫描已被管理后台终止", "warn");
        break;
      }
      // 天选接口处于风控冷却或连续命中多次时，提前结束本轮，避免持续试探加深风控
      if (Date.now() < e.lotteryRate.blockedUntil || e.lotteryRate.streak >= 4) {
        addLog("天选接口处于限流冷却，提前结束本轮等待冷却", "warn");
        break;
      }
      const room = rooms[i];
      e.state.progress = { done: i, total: rooms.length, currentRoom: room.roomid };
      let added = 0;
      // 天选（匿名）
      try {
        const lot = await scanRoomLottery(room);
        if (lot) {
          results.push(lot);
          added += 1;
        }
      } catch {
        failed += 1;
      }
      // 红包（专用账号）
      if (e.config.account) {
        try {
          const list = await fetchRedPockets(room.roomid);
          if (list) {
            const reds = collectRedResults(room, list);
            if (reds.length === 0) skipped += 1;
            for (const r of reds) results.push(r);
            added += reds.length;
            if (reds.length > 0) {
              foundRedLots.set(room.roomid, {
                room,
                lots: reds.map((r) => ({ lotId: r.lotId ?? 0, value: r.value })).filter((x) => x.lotId > 0),
              });
            }
          } else {
            skipped += 1;
            // 账号失效时终止本轮，避免继续无效请求
            if (e.state.accountStatus?.valid === false) break;
          }
        } catch {
          failed += 1;
        }
      }
      // 有新结果时立即更新快照并通知客户端（客户端长轮询可近实时拿到新红包/天选）
      if (added > 0) {
        commitResults(results, true);
      }
      // 每 30 个房间落盘一次进度，避免进程重启丢失太多
      if ((i + 1) % 30 === 0) {
        commitResults(results, false);
        await saveState().catch(() => {});
      }
    }

    for (const [, v] of foundRedLots) recordHistoryRedPacket(v.room, v.lots);

    const now = Date.now();
    commitResults(results, false);
    e.state.lastRound = {
      rooms: rooms.length,
      lottery: results.filter((r) => r.kind === "lottery").length,
      red: results.filter((r) => r.kind === "red_pocket").length,
      skipped,
      failed,
      durationMs: now - startedAt,
    };
    e.state.lastScanFinishedAt = now;
    e.state.progress = { done: rooms.length, total: rooms.length, currentRoom: null };
    notifyChange();
    addLog(
      `本轮完成：${rooms.length} 个房间，天选 ${e.state.lastRound.lottery} 个，红包 ${e.state.lastRound.red} 个，失败 ${failed} 个，耗时 ${Math.round((now - startedAt) / 1000)} 秒`,
      "success",
    );
    await Promise.all([saveState().catch(() => {}), saveHistory().catch(() => {})]);
  } catch (err) {
    addLog(`扫描异常：${err instanceof Error ? err.message : String(err)}`, "error");
  } finally {
    e.state.scanning = false;
    e.roundInFlight = false;
    // 命中限流时，下一轮至少等到冷却结束并额外留出余量
    const cooldownLeft = Math.max(0, e.lotteryRate.blockedUntil - Date.now());
    const delay = Math.max(e.config.scanIntervalMs, cooldownLeft + 60_000);
    e.state.nextScanAt = Date.now() + delay;
    await saveState().catch(() => {});
    scheduleNext(delay);
  }
}

// ===== 定时循环 =====

function scheduleNext(delayMs: number) {
  const e = engine();
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    void tick();
  }, Math.max(1000, delayMs));
}

async function tick() {
  const e = engine();
  await ensureLoaded();
  if (!e.config.enabled) {
    e.state.nextScanAt = null;
    scheduleNext(30_000);
    return;
  }
  if (e.roundInFlight) {
    scheduleNext(10_000);
    return;
  }
  await runRound();
}

function startLoop() {
  const e = engine();
  if (e.timer) return;
  // 启动后稍等再检查，避免模块加载期间抢占请求
  scheduleNext(5_000);
}

// ===== 对外接口 =====

export type PublicScanSnapshot = {
  enabled: boolean;
  scanning: boolean;
  minValue: number;
  serverNow: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  /** 扫描结果版本号（配合 /api/lottery/scan/wait 长轮询） */
  generation: number;
  results: ScanResult[];
};

export async function getPublicSnapshot(): Promise<PublicScanSnapshot> {
  await ensureLoaded();
  startLoop();
  const e = engine();
  return {
    enabled: e.config.enabled,
    scanning: e.state.scanning,
    minValue: e.config.minValue,
    serverNow: Date.now(),
    lastScanAt: e.state.lastScanAt,
    nextScanAt: e.state.nextScanAt,
    generation: e.generation,
    results: e.state.results.filter((r) => r.endTime + RESULT_LINGER_SEC > nowSec()),
  };
}

export type AdminScanSnapshot = {
  config: Omit<ScanConfig, "account"> & {
    account: { uid: number; uname: string; updatedAt: string; cookieTail: string } | null;
  };
  state: ScanState;
  history: HistoryRoom[];
};

export async function getAdminSnapshot(): Promise<AdminScanSnapshot> {
  await ensureLoaded();
  startLoop();
  const e = engine();
  return {
    config: {
      ...e.config,
      account: e.config.account
        ? {
            uid: e.config.account.uid,
            uname: e.config.account.uname,
            updatedAt: e.config.account.updatedAt,
            cookieTail: e.config.account.cookie.slice(-6),
          }
        : null,
    },
    state: e.state,
    history: [...e.history].sort((a, b) => effectiveHot(b) - effectiveHot(a)),
  };
}

export async function setScanEnabled(enabled: boolean): Promise<{ ok: boolean; message?: string }> {
  await ensureLoaded();
  const e = engine();
  // 红包扫描依赖登录账号，未配置账号时不允许启动，避免误以为在完整扫描
  if (enabled && !e.config.account) {
    return { ok: false, message: "请先选择红包扫描账号后再开始扫描" };
  }
  e.config.enabled = enabled;
  await saveConfig();
  if (enabled) {
    addLog("管理后台启动扫描", "success");
    e.state.nextScanAt = Date.now();
    if (!e.roundInFlight) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      scheduleNext(500);
    }
  } else {
    addLog("管理后台停止扫描", "warn");
    e.state.nextScanAt = null;
    addLog("等待当前请求结束…", "info");
    await saveState().catch(() => {});
  }
  return { ok: true };
}

export async function updateScanConfig(patch: {
  minValue?: number;
  scanIntervalMs?: number;
  requestIntervalMs?: number;
  redIntervalMs?: number;
  hotRoomsPerPartition?: number;
}): Promise<ScanConfig> {
  await ensureLoaded();
  const e = engine();
  if (patch.minValue !== undefined) e.config.minValue = Math.max(0, Math.floor(num(patch.minValue)));
  if (patch.scanIntervalMs !== undefined) {
    e.config.scanIntervalMs = Math.max(60_000, Math.floor(num(patch.scanIntervalMs)));
  }
  if (patch.requestIntervalMs !== undefined) {
    e.config.requestIntervalMs = Math.max(200, Math.floor(num(patch.requestIntervalMs)));
  }
  if (patch.redIntervalMs !== undefined) {
    e.config.redIntervalMs = Math.max(200, Math.floor(num(patch.redIntervalMs)));
  }
  if (patch.hotRoomsPerPartition !== undefined) {
    e.config.hotRoomsPerPartition = Math.max(0, Math.floor(num(patch.hotRoomsPerPartition)));
  }
  await saveConfig();
  return e.config;
}

/** 验证并设置专用扫描账号 */
export async function setScanAccount(cookie: string): Promise<{ ok: boolean; message: string; account?: ScanAccount }> {
  await ensureLoaded();
  const e = engine();
  const trimmed = cookie.trim();
  if (!trimmed) {
    e.config.account = null;
    await saveConfig();
    addLog("已清除扫描账号，红包扫描停止", "warn");
    return { ok: true, message: "已清除扫描账号" };
  }
  const csrf = trimmed.match(/bili_jct=([a-f0-9]+)/i)?.[1] ?? "";
  if (!csrf) return { ok: false, message: "Cookie 中缺少 bili_jct，无法参与红包接口" };
  const buvid = await getBuvidCookie().catch(() => "");
  const fullCookie = buvid ? `${buvid}; ${trimmed}` : trimmed;
  const nav = await biliGet<{ isLogin?: boolean; mid?: number; uname?: string }>(
    "https://api.bilibili.com/x/web-interface/nav",
    fullCookie,
  );
  if (!nav || nav.code !== 0 || !nav.data?.isLogin) {
    return { ok: false, message: "Cookie 无效或登录已失效" };
  }
  const account: ScanAccount = {
    cookie: trimmed,
    csrf,
    uid: num(nav.data.mid),
    uname: String(nav.data.uname ?? ""),
    updatedAt: new Date().toISOString(),
  };
  e.config.account = account;
  e.state.accountStatus = { valid: true, mid: account.uid, uname: account.uname, checkedAt: Date.now(), message: "" };
  await saveConfig();
  addLog(`扫描账号已设置为 ${account.uname}（UID ${account.uid}）`, "success");
  return { ok: true, message: `已验证：${account.uname}`, account };
}

export async function addCustomRoom(uid: number): Promise<{ ok: boolean; message: string }> {
  await ensureLoaded();
  const e = engine();
  if (e.config.customRooms.some((r) => r.uid === uid)) {
    return { ok: false, message: "该直播间已在指定列表中" };
  }
  const info = await resolveRoomByUid(uid);
  if (!info) return { ok: false, message: `UID ${uid} 没有直播间或查询失败` };
  e.config.customRooms.push({ uid, roomid: info.roomid, uname: info.uname, face: info.face, title: info.title });
  await saveConfig();
  addLog(`添加指定直播间 ${info.uname}（#${info.roomid}）`, "success");
  return { ok: true, message: `已添加 ${info.uname}` };
}

export async function removeCustomRoom(uid: number): Promise<void> {
  await ensureLoaded();
  const e = engine();
  e.config.customRooms = e.config.customRooms.filter((r) => r.uid !== uid);
  await saveConfig();
}

/** 从「常发红包的直播间」中移除一条记录 */
export async function removeHistoryRoom(roomid: number): Promise<void> {
  await ensureLoaded();
  const e = engine();
  const before = e.history.length;
  e.history = e.history.filter((h) => h.roomid !== roomid);
  if (e.history.length !== before) {
    await saveHistory();
    addLog(`已移除常发红包直播间 #${roomid}`, "info");
  }
}

/** 清空「常发红包的直播间」记录 */
export async function clearHistoryRooms(): Promise<void> {
  await ensureLoaded();
  const e = engine();
  e.history = [];
  await saveHistory();
  addLog("已清空常发红包直播间记录", "warn");
}

/**
 * 等待扫描结果变化（客户端长轮询）。
 * 若版本号已变化或在超时时间内发生变化则立即返回，供客户端近实时获取新红包。
 */
export async function waitForScanUpdate(
  since: number,
  timeoutMs = 25_000,
): Promise<{ generation: number; changed: boolean; serverNow: number }> {
  await ensureLoaded();
  const e = engine();
  if (e.generation !== since) {
    return { generation: e.generation, changed: true, serverNow: Date.now() };
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      e.waiters.delete(finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1000, timeoutMs));
    e.waiters.add(finish);
  });
  return { generation: e.generation, changed: e.generation !== since, serverNow: Date.now() };
}

export function getScanRuntimeInfo(): { nextScanAt: number | null; scanning: boolean; enabled: boolean } {
  const e = engine();
  return { nextScanAt: e.state.nextScanAt, scanning: e.state.scanning, enabled: e.config.enabled };
}
