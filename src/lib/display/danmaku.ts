/**
 * 展示模块 —— 弹幕监听服务（运行于主窗口）。
 *
 * 用 bili-live-listener 监听"当前登录主播自己直播间"的实时弹幕：
 *  - 入场（INTERACT_WELCOME / 高级入场 ENTRY_EFFECT）→ 按配置过滤 → emit 到展示窗口
 *  - 礼物（SEND_GIFT）→ 累加记录到 .data/display-gifts-<mid>.json → 组装达标礼物清单 → emit
 *
 * 仅 Tauri（桌面）环境使用；Web 下不 emit 到独立窗口。
 */
import { getPlatform, type Platform } from "@/lib/platform";
import {
  type DisplayConfig,
  type DisplayEvent,
  type DisplayGiftItem,
  type LayoutElementId,
  type MovableRect,
  type ScreenOrientation,
} from "./types";
import {
  loadDisplayConfig,
  saveDisplayConfig,
  resolveAnimeVideo,
  resolveAnimeSegment,
} from "./config";
import {
  appendGiftRecord,
  loadTodayQualifyingGifts,
  tryHandleBlindBoxQuery,
} from "./gift-db";
import { ensureGiftCatalogLoaded, getGiftImg, getGiftList } from "@/lib/gift-catalog-client";

/** 浏览器源客户端 → 主窗口 的消息（经 display-server-message 事件） */
interface ServerMessage {
  type: "ready" | "saveLayout" | "orientation" | "log";
  mode?: "edit" | "source";
  id?: LayoutElementId;
  orientation?: ScreenOrientation;
  rect?: MovableRect;
  v?: ScreenOrientation;
  level?: string;
  text?: string;
}

/** 入场动画样本（编辑模式常驻预览用） */
interface AnimeSample {
  user: { uid: number; uname: string; face: string };
  videoSrc: string;
  startSec: number;
  endSec: number;
}

export type DisplayServiceStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "connected"; roomId: number }
  | { state: "error"; message: string };

/** 弹幕调试日志条目（面板展示用，data 为精简可读字段） */
export interface DanmuDebugEvent {
  /** HH:mm:ss */
  time: string;
  /** 消息命令，如 INTERACT_WORD / SEND_GIFT；业务阶段用 entry/gift */
  cmd: string;
  /** raw=原始收到 | 业务处理结果（如 emit/filtered/记录） */
  action: string;
  /** 关键数据（已精简） */
  data: unknown;
}

/** 落盘用调试记录：含完整时间戳与原始消息全字段（供深层排查弹幕问题） */
export interface DanmuDebugRecord {
  /** 事件发生的完整时间戳（UTC ISO，解析后按本地时区取自然天），用于按天归档与过期清理 */
  t: string;
  cmd: string;
  action: string;
  /** 原始消息完整字段（raw 阶段为未精简的原始对象；业务阶段与展示 data 一致） */
  data: unknown;
}

/** 本地自然天 YYYY-MM-DD */
function localDayStr(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 允许保留的最早自然天 = 昨天（保留"今天 + 昨天"两个自然天，非 48 小时窗口） */
function minKeepDay(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDayStr(d);
}

/** 按自然天过滤：仅保留最近两天（本地时间今天 + 昨天）；无法解析/旧格式记录直接丢弃。 */
function filterRecentDays(records: DanmuDebugRecord[]): DanmuDebugRecord[] {
  const min = minKeepDay();
  return records.filter((r) => {
    const d = new Date(r.t);
    if (Number.isNaN(d.getTime())) return false; // 旧格式（无 t 字段）或损坏记录 → 丢弃
    return localDayStr(d) >= min; // YYYY-MM-DD 字符串比较即日期比较
  });
}

/** 捕获的关键原始命令 */
const RAW_CMDS = [
  "INTERACT_WORD",
  "ENTRY_EFFECT",
  "SEND_GIFT",
  "SEND_GIFT_V2",
  "UNIVERSAL_EVENT_GIFT_V2",
  "DANMU_MSG",
  "GUARD_BUY",
  "WELCOME_GUARD",
  "SUPER_CHAT_MESSAGE",
];

/** 把原始弹幕包精简为可读的关键字段（避免 JSON 里塞满无用字段） */
function summarizeRaw(cmd: string, raw: any): any {
  try {
    if (cmd === "INTERACT_WORD") {
      const d = raw?.data ?? {};
      return {
        uid: d.uid,
        uname: d.uname,
        type: d.type,
        guardType: d.guard_type,
        medalLevel: d.fans_medal?.medal_level,
        timestamp: d.timestamp,
      };
    }
    if (cmd === "ENTRY_EFFECT") {
      const d = raw?.data ?? {};
      return {
        uid: d.uid,
        uname: d.uname,
        guardLevel: d.guard_level,
        copy: d.copy_writing,
        timestamp: d.timestamp,
      };
    }
    if (cmd === "SEND_GIFT") {
      const d = raw?.data ?? {};
      return {
        uid: d.uid,
        uname: d.uname,
        giftId: d.giftId,
        giftName: d.giftName,
        price: d.price,
        num: d.num,
        coinType: d.coin_type,
        timestamp: d.timestamp,
      };
    }
    if (cmd === "SEND_GIFT_V2" || cmd === "UNIVERSAL_EVENT_GIFT_V2") {
      // 新协议：SEND_GIFT_V2 为 protobuf（data.pb，base64），其他为 JSON 变体，这里展示解析结果与关键字段
      const parsed = parseGiftV2Pb(raw?.data) ?? parseNewGift(raw);
      return {
        parsed: parsed.map((g) => ({
          uid: g.user?.uid,
          uname: g.user?.uname,
          giftId: g.giftId,
          giftName: g.giftName,
          price: g.price,
          num: g.num,
          coinType: g.coinType,
        })),
        isPb: typeof raw?.data?.pb === "string",
        dataKeys: Object.keys(raw?.data ?? {}),
      };
    }
    if (cmd === "DANMU_MSG") {
      const info = raw?.info ?? raw?.data?.info;
      if (Array.isArray(info)) {
        const u = info[2] ?? [];
        const medal = (info[3] ?? [])[0] ?? {};
        return { uid: u[0], uname: u[1], content: info[1], medalLevel: medal?.medal_level, timestamp: info[0]?.[4] };
      }
      return { info };
    }
    if (cmd === "GUARD_BUY") {
      const d = raw?.data ?? {};
      return { uid: d.uid, uname: d.username, guardLevel: d.guard_level, giftName: d.gift_name, price: d.price, num: d.num };
    }
    if (cmd === "WELCOME_GUARD") {
      const d = raw?.data ?? {};
      return { uid: d.uid, uname: d.uname, guardLevel: d.guard_level, copy: d.copy_writing };
    }
    if (cmd === "SUPER_CHAT_MESSAGE") {
      const d = raw?.data ?? {};
      return { uid: d.uid, uname: d.user_info?.uname, price: d.price, content: d.message };
    }
  } catch {
    /* 精简失败则回退原始对象 */
  }
  return raw;
}

// ==================== protobuf 最小解码（SEND_GIFT_V2 专用） ====================
// SEND_GIFT_V2 的 data.pb 是 base64 编码的 protobuf（SendGiftBroadcast），不是 JSON。
// 字段号取自 blivedm（xfgryujk/blivedm，2026-08 仍活跃维护，models/pb.py），并经
// _probe_js/pb-decode.cjs 用真实抓包样本逐一验证一致。

interface PbField {
  field: number;
  /** 0=varint 1=64位固定 2=len-delimited 5=32位固定 */
  wire: number;
  value: bigint | Uint8Array;
}

/** 读一个 varint，返回 {value, next} */
function pbReadVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } {
  let value = BigInt(0);
  let shift = BigInt(0);
  while (pos < buf.length) {
    const b = buf[pos++];
    value |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += BigInt(7);
  }
  return { value, next: pos };
}

/** 把字节流解码为字段数组（遇到未知 wire type 即停止） */
function pbDecode(buf: Uint8Array, pos: number, end: number): PbField[] {
  const out: PbField[] = [];
  while (pos < end) {
    const tag = pbReadVarint(buf, pos);
    pos = tag.next;
    const field = Number(tag.value >> BigInt(3));
    const wire = Number(tag.value & BigInt(7));
    if (wire === 0) {
      const v = pbReadVarint(buf, pos);
      pos = v.next;
      out.push({ field, wire, value: v.value });
    } else if (wire === 2) {
      const len = pbReadVarint(buf, pos);
      pos = len.next;
      const start = pos;
      pos += Number(len.value);
      out.push({ field, wire, value: buf.slice(start, pos) });
    } else if (wire === 1) {
      const start = pos;
      pos += 8;
      out.push({ field, wire, value: buf.slice(start, pos) });
    } else if (wire === 5) {
      const start = pos;
      pos += 4;
      out.push({ field, wire, value: buf.slice(start, pos) });
    } else {
      break;
    }
  }
  return out;
}

/** 取字段的 varint 数值（不存在/非数值 → 0） */
function pbInt(fields: PbField[], field: number): number {
  const f = fields.find((x) => x.field === field);
  if (!f || f.wire !== 0) return 0;
  const n = f.value as bigint;
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
}

/** 取字段的字符串（不存在/非字符串 → ""） */
function pbStr(fields: PbField[], field: number): string {
  const f = fields.find((x) => x.field === field);
  if (!f || f.wire !== 2) return "";
  return new TextDecoder().decode(f.value as Uint8Array);
}

/** 取字段的嵌套子消息（不存在/非嵌套 → null） */
function pbMsg(fields: PbField[], field: number): PbField[] | null {
  const f = fields.find((x) => x.field === field);
  if (!f || f.wire !== 2) return null;
  const sub = f.value as Uint8Array;
  return pbDecode(sub, 0, sub.length);
}

/** 解析 SEND_GIFT_V2 的 protobuf 礼物包（data.pb）为一个或多个礼物对象。
 *  字段号与 blivedm 一致：顶层 uid=1 uname=2 face=3 guard_level=5 medal_info=8
 *  blind_gift=9 gift_list=10；gift_list 项 gift_id=1 gift_name=2 num=3 gift_type=4
 *  price=5 total_coin=7 coin_type=8 tid=9 timestamp=10 rnd=12 action=18
 *  gift_info=35（内含 img_basic=1）。盲盒一次打包多条 gift_list（爆出礼物逐条）。
 *  输出与 bili-live-listener 的 GiftData 对齐（d.user.uid/uname/face、d.giftId、
 *  d.giftName、d.price、d.num、d.coinType、d.timestamp），并附 d.img 直链图标，
 *  可直接复用 handleGift。data 非 pb 结构（无 data.pb）返回 null，由调用方回退 JSON。 */
function parseGiftV2Pb(data: any): any[] | null {
  const pbB64 = data?.pb;
  if (typeof pbB64 !== "string" || !pbB64) return null;
  let fields: PbField[];
  try {
    const raw = Uint8Array.from(atob(pbB64), (c) => c.charCodeAt(0));
    fields = pbDecode(raw, 0, raw.length);
  } catch {
    return null; // base64 损坏 → 交给 JSON 回退分支（会记"解析失败"便于排查）
  }
  const uid = pbInt(fields, 1);
  const uname = pbStr(fields, 2);
  const face = pbStr(fields, 3);
  const items = fields.filter((f) => f.field === 10 && f.wire === 2);
  if (!items.length) return [];
  const out: any[] = [];
  for (const it of items) {
    const sub = it.value as Uint8Array;
    const gf = pbDecode(sub, 0, sub.length);
    const gi = pbMsg(gf, 35);
    out.push({
      user: { uid, uname, face },
      giftId: pbInt(gf, 1),
      giftName: pbStr(gf, 2),
      price: pbInt(gf, 5),
      num: pbInt(gf, 3) || 1,
      coinType: pbStr(gf, 8) || "gold",
      timestamp: pbInt(gf, 10),
      img: gi ? pbStr(gi, 1) : "",
    });
  }
  return out;
}

/** 解析新协议礼物包（JSON 变体）为一个或多个礼物对象。
 *  背景：bili-live-listener 的 onGift 只订阅旧协议 SEND_GIFT/POPULARITY_RED_POCKET_NEW，
 *  B站对新主播/高人气房间灰度推送新协议（SEND_GIFT_V2 为 protobuf，见 parseGiftV2Pb；
 *  UNIVERSAL_EVENT_GIFT_V2 等可能为 JSON）。JSON 变体字段结构不稳定：
 *  扁平（data.uid/uname/giftId...）/ asset 嵌套（data.asset.gift_id...）/ user 嵌套
 *  （data.user.uid/uname）/ items 批量数组均有出现，这里自适应兼容，
 *  输出对象字段与 bili-live-listener 的 GiftData 对齐（d.user.uid、d.giftId、d.giftName、
 *  d.price、d.num、d.coinType、d.timestamp），可直接复用 handleGift。 */
function parseNewGift(raw: any): any[] {
  const d = raw?.data ?? {};
  if (!d || typeof d !== "object") return [];
  const items = Array.isArray(d.items) ? d.items : Array.isArray(d.gifts) ? d.gifts : null;
  const sources = items && items.length ? items : [d];
  const out: any[] = [];
  for (const s of sources) {
    if (!s || typeof s !== "object") continue;
    const asset = s.asset ?? {};
    const user = s.user ?? {};
    const uid = Number(s.uid ?? user.uid ?? asset.payer ?? 0) || 0;
    const uname = String(s.uname ?? user.uname ?? asset.uname ?? "");
    const giftId = Number(s.giftId ?? s.gift_id ?? asset.gift_id ?? 0) || 0;
    const giftName = String(s.giftName ?? s.gift_name ?? asset.gift_name ?? "");
    const price = Number(s.price ?? asset.price ?? 0) || 0;
    const num = Number(s.num ?? asset.num ?? 1) || 1;
    const coinType = String(s.coin_type ?? asset.coin_type ?? "gold");
    if (!uid && !giftId) continue; // 关键字段全部缺失 → 视为解析失败跳过
    out.push({
      user: { uid, uname },
      giftId,
      giftName,
      price,
      num,
      coinType,
      timestamp: Number(s.timestamp ?? d.timestamp) || 0,
    });
  }
  return out;
}

type StatusListener = (s: DisplayServiceStatus) => void;

/** 带超时的 Promise，避免底层 IPC/HTTP 挂起导致状态永久卡住 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时(>${Math.round(ms / 1000)}s)`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

class DisplayDanmakuService {
  private roomId = 0;
  /** 当前监听的主播 uid（供画布就绪后补推礼物清单） */
  private mid = 0;
  private live: any = null;
  private removeHandlers: Array<() => void> = [];
  private active = false;
  /** 本地浏览器源服务端口缓存（null=未启动/未知） */
  private serverPort: number | null = null;
  /** "display-server-message" 监听是否已注册（会话内只注册一次） */
  private serverListened = false;
  /** 重连定时器 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private statusListeners = new Set<StatusListener>();
  /** 最近一次状态：供后挂载的面板订阅时立即回放（打开软件自动恢复已连接后，面板再挂载时
   *  不至于停留在 idle，导致总开关卡片的连接状态行不显示） */
  private currentStatus: DisplayServiceStatus = { state: "idle" };
  // 弹幕 token 缓存：弹幕接口有风控，不能每次重连都重新拉取；
  // 首次进房间拉一次，后续断线重连直接复用，避免高频请求把 IP 打成 -352。
  private cachedToken: string | null = null;
  private cachedRoomId = 0;
  /** 底层 WS open 时刻（诊断用，用于计算连接存活时长） */
  private wsConnectedAt = 0;
  // ---- 调试日志 ----
  private debugListeners = new Set<(e: DanmuDebugEvent) => void>();
  private debugEvents: DanmuDebugEvent[] = [];
  /** 落盘原始记录（含完整时间戳与原始消息全字段） */
  private debugRecords: DanmuDebugRecord[] = [];
  private debugPersistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 调试日志写盘串行链：保证任意时刻只有一个写操作在进行，避免并发写触发底层存储冲突 */
  private debugPersistChain: Promise<void> = Promise.resolve();

  subscribe(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    // 立即回放当前状态：面板可能在自动恢复（autoStartDisplay）已连接后才挂载，
    // 若订阅时不回放，面板会一直停留在初始 idle，连接状态行永不显示。
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  /** 订阅调试事件；返回取消函数。 */
  subscribeDebug(listener: (e: DanmuDebugEvent) => void): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  /** 获取已缓冲的调试事件（最近 20 条，供面板展示）。 */
  getDebugEvents(): DanmuDebugEvent[] {
    return this.debugEvents.slice(-20);
  }

  private pushDebug(cmd: string, action: string, data: unknown, raw?: unknown) {
    const now = new Date();
    const ev: DanmuDebugEvent = {
      time: now.toLocaleTimeString("zh-CN", { hour12: false }),
      cmd,
      action,
      data,
    };
    this.debugEvents.push(ev);
    if (this.debugEvents.length > 300) this.debugEvents.shift();
    this.debugListeners.forEach((l) => l(ev));
    // 落盘记录：保存原始消息全字段（raw 阶段传 raw；业务阶段与展示 data 一致）
    this.debugRecords.push({
      t: now.toISOString(),
      cmd,
      action,
      data: raw !== undefined ? raw : data,
    });
    if (this.debugRecords.length > 400) this.debugRecords.shift();
    // 节流落盘到 .data/display-danmu-debug.json，避免高频弹幕反复写盘
    if (!this.debugPersistTimer) {
      this.debugPersistTimer = setTimeout(() => {
        this.debugPersistTimer = null;
        void this.persistDebug();
      }, 500);
    }
  }

  private persistDebug() {
    // 串行化写盘：前一次写完成前不启动下一次，杜绝并发写导致的
    // "Compaction failed: Another write batch or compaction is already active"
    this.debugPersistChain = this.debugPersistChain.then(async () => {
      try {
        const platform = await getPlatform();
        if (!platform.isNative || !this.mid) return;
        const dir = `${await platform.getDataDir()}/uid_${this.mid}`;
        await platform.writeFile(
          `${dir}/display-danmu-debug.json`,
          JSON.stringify(this.debugRecords.slice(-300), null, 2),
        );
      } catch {
        /* 调试文件写入失败忽略 */
      }
    });
  }

  /**
   * 启动时清理历史调试日志：仅保留最近两个自然天（今天 + 昨天）。
   * 写入时不做清理（避免每次写盘的开销）；即使应用长时间运行导致日志跨多天，
   * 影响也不大，下次启动（或跨天重启）时这里会统一清理。
   */
  private async cleanupExpiredDebugLog(mid: number) {
    try {
      const platform = await getPlatform();
      if (!platform.isNative || !mid) return;
      const dir = `${await platform.getDataDir()}/uid_${mid}`;
      const path = `${dir}/display-danmu-debug.json`;
      const raw = JSON.parse(await platform.readFile(path));
      if (!Array.isArray(raw)) return;
      const kept = filterRecentDays(raw as DanmuDebugRecord[]);
      if (kept.length === (raw as unknown[]).length) return; // 无过期记录，无需写盘
      await platform.writeFile(path, JSON.stringify(kept.slice(-300), null, 2));
    } catch {
      /* 文件不存在/损坏/非 Tauri 环境时忽略 */
    }
  }

  private emitStatus(s: DisplayServiceStatus) {
    this.currentStatus = s;
    this.statusListeners.forEach((l) => l(s));
  }

  isActive() {
    return this.active;
  }

  /** 启动监听：拉取弹幕 token → 建立 WS → 绑定事件。 */
  async start(roomId: number, mid: number) {
    // 若已连同一房间，忽略重复启动
    if (this.active && this.roomId === roomId) return;
    this.retry = 0;
    // 启动即清理过期调试日志（保留最近两个自然天），处理"长期离线后重新打开"的残留
    void this.cleanupExpiredDebugLog(mid);
    await this.connect(roomId, mid);
  }

  /**
   * 启动本地浏览器源服务（幂等）：Rust 端绑定 127.0.0.1:25100 起端口，并注册
   * `display-server-message` 全局监听（会话内只注册一次）。该监听按消息类型分发：
   *  - ready → 组装并广播初始 init（布局 / 朝向 / 今日礼物 / 入场动画样本）
   *  - saveLayout → 持久化布局并回放 layout
   *  - orientation → 持久化朝向并回放 orientation
   *  - log → 打印画布/浏览器源的调试日志
   */
  async startServer(): Promise<number> {
    const { invoke } = await import("@tauri-apps/api/core");
    const port = (await invoke("start_display_server")) as number;
    this.serverPort = port;
    this.registerServerListener();
    return port;
  }

  /** 已缓存的本地服务端口（null=未启动）。 */
  getServerPort(): number | null {
    return this.serverPort;
  }

  /** 本地浏览器源服务完整地址（含端口）；未启动返回空串。用于外部拼接 /api/video 探测地址。 */
  getDisplayBaseUrl(): string {
    return this.serverPort ? `http://127.0.0.1:${this.serverPort}` : "";
  }

  /**
   * 持久化展示朝向并广播到所有浏览器源客户端（画布据此切换横/竖屏）。与浏览器源
   * 编辑 iframe 发来的 {type:"orientation"} 走同一套持久化 + 广播逻辑。
   */
  async setOrientation(v: ScreenOrientation, mid: number): Promise<void> {
    const cfg = await loadDisplayConfig(mid);
    await saveDisplayConfig(mid, { ...cfg, screenOrientation: v });
    this.broadcast({ type: "orientation", v });
    // 朝向切换会改变入场动画选用的视频（横/竖屏各一套），须重发 init 让画布/编辑页
    // 更新 animeSample 到新朝向对应的视频源，否则视频源停留在旧朝向。
    await this.broadcastInit();
  }

  /** 会话内只注册一次"display-server-message"监听。 */
  private registerServerListener() {
    if (this.serverListened) return;
    this.serverListened = true;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        await listen<ServerMessage>("display-server-message", (event) => {
          void this.handleServerMessage(event.payload);
        });
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();
  }

  /** 分发浏览器源客户端发来的一个消息（ready/saveLayout/orientation/log）。 */
  private async handleServerMessage(msg: ServerMessage) {
    try {
      if (msg.type === "ready") {
        await this.broadcastInit();
      } else if (msg.type === "saveLayout") {
        const { id, orientation, rect } = msg;
        if (!id || !orientation || !rect) return;
        const cfg = await loadDisplayConfig(this.mid);
        const layout = cfg.layout;
        layout[id][orientation] = rect;
        await saveDisplayConfig(this.mid, { ...cfg, layout });
        // 回放已保存的布局给所有端（含发送者）
        this.broadcast({ type: "layout", id, orientation, rect });
      } else if (msg.type === "orientation") {
        const v: ScreenOrientation = msg.v === "portrait" ? "portrait" : "landscape";
        const cfg = await loadDisplayConfig(this.mid);
        await saveDisplayConfig(this.mid, { ...cfg, screenOrientation: v });
        this.broadcast({ type: "orientation", v });
        // 朝向切换 → 重发 init 更新入场动画样本（横/竖屏视频源不同），否则视频不随朝向切换。
        await this.broadcastInit();
      } else if (msg.type === "log") {
        const fn = msg.level === "error" ? console.error : console.log;
        fn(`[画布]${msg.text}`);
      }
    } catch (e) {
      console.warn("[展示]处理画布消息失败", (e as Error)?.message || e);
    }
  }

  /**
   * 浏览器源就绪后组提升级 init：布局 + 当前朝向 + 今日达标礼物 + 入场动画样本。
   * 这些信息全部持久化在主进程侧（.data/display-config.json），由主窗口组装后广播。
   */
  private async broadcastInit() {
    const cfg = await loadDisplayConfig(this.mid);
    const orientation = cfg.screenOrientation;
    // 礼物：今日达标清单
    let gifts: DisplayGiftItem[] = [];
    if (cfg.gift && this.mid) {
      try {
        gifts = await loadTodayQualifyingGifts(this.mid, cfg.giftPriceThreshold);
      } catch {
        /* 拉取失败则以空清单下发，画布自行占位 */
      }
    }
    // 入场动画样本：首个启用且带视频的 animeList 项（供编辑模式常驻预览）
    let animeSample: AnimeSample | null = null;
    const item = (cfg.animeList || []).find(
      (a) => a.enabled && (a.videoLandscape || a.videoPortrait),
    );
    if (item) {
      const video = resolveAnimeVideo(item, cfg.screenOrientation);
      const seg = resolveAnimeSegment(item, cfg.screenOrientation);
      animeSample = {
        user: { uid: item.uid, uname: item.uname, face: item.face },
        videoSrc: toDisplayVideoSrc(video),
        startSec: seg.startSec,
        endSec: seg.endSec,
      };
    }
    this.broadcast({
      type: "init",
      orientation: cfg.screenOrientation,
      layouts: cfg.layout,
      gifts,
      animeSample,
      flags: {
        master: cfg.master,
        entry: cfg.entry,
        gift: cfg.gift,
        anime: cfg.anime,
      },
    });
  }

  /** 广播当前各模块开关状态（master/entry/gift/anime）到浏览器源，画布据此即时显隐元素。
   *  在面板切换总开关或各模块开关后调用（配置已落盘），浏览器源无需重连即可响应。 */
  async broadcastFlags(): Promise<void> {
    const cfg = await loadDisplayConfig(this.mid);
    await this.broadcast({
      type: "flags",
      flags: {
        master: cfg.master,
        entry: cfg.entry,
        gift: cfg.gift,
        anime: cfg.anime,
      },
    });
  }

  /** 包装 broadcast_display：无服务/非 Tauri 时静默（Rust 端未启动同样是 no-op）。 */
  private async broadcast(json: unknown) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("broadcast_display", { json });
    } catch {
      /* server 未运行 / 非 Tauri（如 Web 预览）时静默跳过 */
    }
  }

  /** 实际连接（无重入保护）：start() 与重连定时器共用；重连必须走这里才能绕过 start 的同房保护。 */
  private async connect(roomId: number, mid: number) {
    this.stopListeners();
    this.active = true;
    this.roomId = roomId;
    this.mid = mid;

    // Tauri 环境：预热本地礼物目录（解析礼物图标）
    const platform = await getPlatform();
    if (platform.isNative) {
      try {
        await ensureGiftCatalogLoaded(platform);
      } catch {
        /* 礼物目录加载失败不阻塞监听 */
      }
    }

    this.emitStatus({ state: "connecting" });

    try {
      // 复用缓存的 token；仅首次进该房间或 token 缺失时才请求 getDanmuInfo
      let token = this.cachedToken;
      if (!token || this.cachedRoomId !== roomId) {
        token = await this.fetchDanmuToken(platform, roomId);
        this.cachedToken = token;
        this.cachedRoomId = roomId;
      }
      const { BiliLive } = (await import("bili-live-listener")) as {
        BiliLive: new (roomId: number, opts: { key: string; uid: number; isBrowser: boolean }) => any;
      };
      this.live = new BiliLive(roomId, { key: token, uid: mid, isBrowser: true });

      this.bindHandlers(mid);
      this.live.onOpen(() => {
        this.retry = 0;
        this.wsConnectedAt = Date.now();
        console.log("[展示]WS open（底层连接建立）", { roomId });
        this.pushDebug("ws", "open", { roomId });
        this.emitStatus({ state: "connected", roomId });
      });
      this.live.onLive(() => {
        console.log("[展示]WS 认证成功（auth code=0）", { roomId });
        this.pushDebug("ws", "auth", { roomId });
      });
      this.live.onHeartbeat((online: number) => {
        console.log("[展示]WS 心跳", { online });
      });
      this.live.onClose((code?: number, reason?: any) => {
        const ageSec = this.wsConnectedAt ? Math.round((Date.now() - this.wsConnectedAt) / 1000) : 0;
        console.log("[展示]WS close", { code, reason: reason?.message ?? reason, ageSec });
        this.pushDebug("ws", "close", { ageSec, code, reason: reason?.message ?? reason });
        this.scheduleReconnect(roomId, mid);
      });
      this.live.onError((err: any) => {
        const msg = err?.message || String(err);
        console.log("[展示]WS error", JSON.stringify(err), "->", msg);
        this.pushDebug("ws", "error", { msg });
        this.emitStatus({ state: "error", message: msg });
        this.scheduleReconnect(roomId, mid, msg);
      });

      this.emitStatus({ state: "connected", roomId });
      console.log("[展示]WS 建立成功", { roomId });
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.log("[展示]start 异常", e?.stack || e);
      this.emitStatus({ state: "error", message: msg });
      this.scheduleReconnect(roomId, mid, msg);
    }
  }

  /** 停止：断开 WS、取消重连、释放事件。 */
  stop() {
    this.active = false;
    this.roomId = 0;
    this.cachedToken = null;
    this.cachedRoomId = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopListeners();
    this.emitStatus({ state: "idle" });
  }

  private stopListeners() {
    this.removeHandlers.forEach((rm) => {
      try {
        rm();
      } catch {}
    });
    this.removeHandlers = [];
    try {
      this.live?.close();
    } catch {}
    this.live = null;
  }

  private scheduleReconnect(roomId: number, mid: number, errMsg?: string) {
    if (!this.active) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // -352 是风控/限流：必须大幅退避，否则高频重试会把 IP 一直锁在风控里。
    // 普通断线：较快重连。指数退避，封顶 5 分钟。
    const isRisk = /-352|风控|限流/.test(errMsg ?? "");
    const base = isRisk ? 60_000 : 5_000;
    const max = isRisk ? 300_000 : 120_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.retry, 4));
    this.retry = Math.min(this.retry + 1, 6);
    console.log(`[展示]${isRisk ? "风控" : "断线"}退避重连 ${delay}ms 后（第 ${this.retry} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.connect(roomId, mid);
    }, delay);
  }

  /** 获取弹幕服务器的 token（须携带登录 Cookie + buvid3，否则可能触发风控 -352）。 */
  private async fetchDanmuToken(platform: Platform, roomId: number): Promise<string> {
    const state = await platform.getSessionState();
    const session = (state.sessions || []).find((s: any) => s.sid === state.currentSid);
    const cookie: string[] = [];
    if (session) {
      if (session.biliCookies?.length) cookie.push(...session.biliCookies);
      if (session.biliSessdata && !cookie.some((c) => c.startsWith("SESSDATA="))) {
        cookie.push(`SESSDATA=${session.biliSessdata}`);
      }
    }
    // 弹幕服务器配置/token 用旧版 Danmu/getConf 接口：
    // getDanmuInfo 虽自 2025-05 起要求 WBI 签名（见 blivechat issue #264），但经实测：
    //   - 走 Tauri reqwest/rustls 客户端仍被 getDanmuInfo 的浏览器指纹风控拦截（-352）
    //   - getConf 在应用客户端可正常获取 token，且其 token 对弹幕 WS 认证有效（auth code=0）
    // 故保留 getConf；WBI 不适用于当前客户端的 token 获取路径。
    if (!cookie.some((c) => c.toLowerCase().startsWith("buvid3="))) {
      const buvid = await platform.getBuvidCookie();
      if (buvid) cookie.push(buvid);
    }
    const flat = cookie.flatMap((c) => c.split(";").map((s) => s.trim().split("=")[0]));
    console.log(
      "[展示]getConf 请求",
      JSON.stringify({ roomId, cookieKeys: flat, hasSess: flat.some((k) => k.toLowerCase() === "sessdata") }),
    );
    const data = await withTimeout(
      platform.fetchBilibiliJson<any>({
        url: `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`,
        cookie: cookie.join("; "),
        live: true, // 必须用 live 域 Referer/Origin
      }),
      10000,
      "获取弹幕服务器",
    );
    console.log(
      "[展示]getConf 返回",
      JSON.stringify({ code: data?.code, message: data?.message, msg: data?.msg, hasToken: !!data?.data?.token }),
    );
    if (data?.code !== 0 || !data?.data?.token) {
      const errMsg = data?.message || data?.msg;
      console.log("[展示]getConf 失败: code=", data?.code, "message=", data?.message, "msg=", data?.msg);
      throw new Error(String(errMsg ?? "获取弹幕服务器失败"));
    }
    return data.data.token;
  }

  private bindHandlers(mid: number) {
    // ---- 调试：捕获原始关键事件 ----
    for (const cmd of RAW_CMDS) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, (raw: any) => {
          // 面板展示精简字段，落盘保存原始消息全字段（便于深层排查）
          this.pushDebug(cmd, "raw", summarizeRaw(cmd, raw), raw);
        }),
      );
    }

    // ---- 入场 ----
    this.removeHandlers.push(
      this.live.onInteract(async (message: any) => {
        // Enter=1；Follow=2；Share=3；Like=4
        if (!message?.data || message.data.type !== 1) return;
        await this.handleEntry(mid, message.data.user);
      }),
    );
    this.removeHandlers.push(
      this.live.onEntryEffect(async (message: any) => {
        // 高级入场特效（通常是舰长/高等级用户），同样作为入场来源
        if (!message?.data?.user) return;
        await this.handleEntry(mid, message.data.user);
      }),
    );

    // ---- 礼物 ----
    this.removeHandlers.push(
      this.live.onGift(async (message: any) => {
        const d = message?.data;
        if (!d || d.coinType !== "gold") return; // 仅统计金瓜子（有价）礼物
        // 图标位于 message.raw（原始 SEND_GIFT 包）而非 message.data（库解析后的 GiftData），需一并传给 handleGift
        await this.handleGift(mid, d, message?.raw);
      }),
    );

    // ---- 礼物（新协议）：SEND_GIFT_V2 / UNIVERSAL_EVENT_GIFT_V2 ----
    // bili-live-listener 的 onGift 只订阅 SEND_GIFT/POPULARITY_RED_POCKET_NEW；B站对新主播/
    // 高人气房间灰度推送新协议（SEND_GIFT_V2 为 protobuf、data.pb 编码，经抓包验证；盲盒
    // 一次打包多条爆出礼物），未订阅则礼物静默丢失（表现为"测试号能收到、新主播号收不到
    // 送礼、无礼物记录文件"）。这里在底层 ws 直接监听原始包：SEND_GIFT_V2 走 pb 解码，
    // 其他 JSON 变体走 parseNewGift 自适应解析，逐条复用 handleGift，与旧协议走同一
    // 落盘/展示路径。解析失败时记录原始包便于排查。
    for (const cmd of ["SEND_GIFT_V2", "UNIVERSAL_EVENT_GIFT_V2"]) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, async (raw: any) => {
          const list = parseGiftV2Pb(raw?.data) ?? parseNewGift(raw);
          if (!list.length) {
            this.pushDebug(cmd, "解析失败", summarizeRaw(cmd, raw), raw);
            return;
          }
          for (const g of list) {
            if (g.coinType !== "gold") continue;
            await this.handleGift(mid, g, raw);
          }
        }),
      );
    }

    // ---- 盲盒盈亏 · 弹幕查询 ----
    this.removeHandlers.push(
      this.live.onDanmu(async (message: any) => {
        const d = message?.data;
        if (!d || !d.user?.uid) return;
        const content = String(d.content || "").trim();
        if (!content) return;

        const config = await loadDisplayConfig(mid);
        if (!config.blindBoxQuery?.enabled) return;
        const senderUid = Number(d.user.uid);
        // 当前主播账号查询为特例：不返回其自身盲盒记录，而是返回"全部粉丝"的盲盒数据（uid=0 = 不按用户过滤）
        const queryUid = senderUid === mid ? 0 : senderUid;
        try {
          const reply = await tryHandleBlindBoxQuery(mid, queryUid, content, this.roomId);
          if (reply) {
            this.pushDebug("danmu", "盲盒查询", {
              uid: senderUid,
              uname: d.user.uname || "",
              content,
              queryUid: queryUid === 0 ? "全部粉丝" : queryUid,
              reply,
            });
          }
        } catch (e) {
          console.warn("[展示]盲盒查询处理异常", (e as Error)?.message || e);
        }
      }),
    );
  }

  /** 处理一条入场信息：高级用户动画 + 普通入场提示（动画是额外的，不替代入场提示）。 */
  private async handleEntry(mid: number, user: any) {
    if (!this.active || !user || !user.uid) return;
    const config = await loadDisplayConfig(mid);
    const guardType = Number(user.guardType) || 0;
    const medalLevel = Number(user.fansMedal?.level) || 0;

    // 高级用户自定义入场动画：命中名单且启用 → 额外播放视频动画
    const animeCfg = Object.values(config.animeList).find(
      (a) => a.enabled && (a.videoLandscape || a.videoPortrait) && a.uid === user.uid,
    );
    if (config.anime && animeCfg && this.isNative()) {
      const video = resolveAnimeVideo(animeCfg, config.screenOrientation);
      const seg = resolveAnimeSegment(animeCfg, config.screenOrientation);
      this.pushDebug("entry", "anime", {
        uid: Number(user.uid),
        uname: user.uname || "",
        video,
        startSec: seg.startSec,
        endSec: seg.endSec,
      });
      this.emitTo({
        type: "anime",
        user: { uid: Number(user.uid), uname: user.uname || "", face: user.face || "" },
        videoSrc: toDisplayVideoSrc(video),
        startSec: seg.startSec,
        endSec: seg.endSec,
      });
      // 不 return：高级用户同样走普通入场提示
    }

    // 入场提示模块：应用筛选
    if (!config.entry || !this.matchesEntryFilter(config, guardType, medalLevel)) {
      this.pushDebug("entry", "filtered", {
        uid: Number(user.uid),
        uname: user.uname || "",
        guardType,
        medalLevel,
        entryOn: !!config.entry,
        matched: this.matchesEntryFilter(config, guardType, medalLevel),
      });
      return;
    }
    this.pushDebug("entry", "emit", { uid: Number(user.uid), uname: user.uname || "", guardType, medalLevel });
    this.emitTo({
      type: "entry",
      user: {
        uid: Number(user.uid),
        uname: user.uname || "",
        face: user.face || "",
        guardType: guardType as any,
        medalLevel,
      },
    });
  }

  /** 处理一条送礼信息：追加到礼物逐条记录 → 组装达标礼物清单 → emit。
   *  礼物记录（uid_<mid>/display-gift-records.json）同时供"礼物展示"与盲盒"今日/昨日"查询使用，
   *  是单一来源，不再各自维护一份今日聚合。
   *  @param d   — bili-live-listener 解析后的 GiftData（无图标字段）
   *  @param raw — 原始 SEND_GIFT 包 {cmd, danmu, data:{...}}；礼物图标在 raw.data.gift_info */
  private async handleGift(mid: number, d: any, raw?: any) {
    if (!this.active) return;
    const ts = Number(d.timestamp) || Math.floor(Date.now() / 1000);
    const giftId = Number(d.giftId) || 0;
    // price 单位 = 金瓜子；1 电池 = 100 金瓜子 → 换算为电池（与入库的电池口径一致）
    const priceBattery = (Number(d.price) || 0) / 100;
    // 送礼人信息在 d.user 内（uid/uname/face）
    const guser = d.user || {};
    const uid = Number(guser.uid) || 0;
    const uname = guser.uname || "";
    // 礼物图标直链：优先取 gif（动画），没有则用 img_basic（静态 png）。
    // 旧协议 SEND_GIFT 的图标位于 raw.data.gift_info；新协议 SEND_GIFT_V2 的图标在
    // protobuf 的 gift_info.img_basic（parseGiftV2Pb 已解出到 d.img）。
    const payload = raw?.data || {};
    const gi = payload?.gift_info || {};
    const asset = payload?.asset || {};
    const rawImg = String(gi.gif || gi.img_basic || asset.gif || asset.img_basic || asset.gift_img || d.img || "");
    // 少数老版本/特殊礼物可能不带 gift_info，回退礼物目录现查（Map 读取，非网络），保证记录图标不空
    const giftImg = rawImg || getGiftImg(giftId);

    // 逐条落盘（含 uid，供按用户聚合/盲盒盈亏查询；写盘串行、失败不影响直播展示）
    await appendGiftRecord(mid, {
      date: localDayStr(new Date(ts * 1000)),
      ts,
      uid,
      uname,
      giftId,
      giftName: d.giftName || "",
      price: priceBattery,
      num: Number(d.num) || 1,
      img: giftImg,
    });
    this.pushDebug("gift", "记录", { uid, uname, giftId, giftName: d.giftName, num: Number(d.num) || 1, hasImg: !!giftImg });

    if (!this.isNative()) return;

    const config = await loadDisplayConfig(mid);
    if (!config.gift) return;

    // 从礼物逐条记录聚合今日达标清单（单价 > 阈值；阈值 0 = 不限制）
    const qualifying: DisplayGiftItem[] = await loadTodayQualifyingGifts(
      mid,
      config.giftPriceThreshold,
    );
    this.pushDebug("gift", qualifying.length ? "emit" : "未达阈值", {
      threshold: config.giftPriceThreshold,
      list: qualifying.map((q) => ({ name: q.giftName, count: q.count })),
    });
    // 每次送礼都重发当前达标清单（含空清单 → 清空画布），保证画布与阈值始终一致
    this.emitTo({ type: "gift", gifts: qualifying });
  }

  /**
   * 配置变化（如修改礼物阈值）后，用当前配置重算今日达标礼物并即时重发到展示窗口，
   * 让阈值修改立刻生效，无需等下一次送礼。
   */
  async pushGiftUpdate(mid: number) {
    if (!this.active || !mid || !this.isNative()) return;
    const config = await loadDisplayConfig(mid);
    if (!config.gift) return;
    const qualifying = await loadTodayQualifyingGifts(mid, config.giftPriceThreshold);
    this.pushDebug("gift", qualifying.length ? "emit" : "清空", {
      threshold: config.giftPriceThreshold,
      list: qualifying.map((q) => ({ name: q.giftName, count: q.count })),
    });
    this.emitTo({ type: "gift", gifts: qualifying });
  }

  private matchesEntryFilter(config: DisplayConfig, guardType: number, medalLevel: number): boolean {
    const f = config.entryFilter;
    if (guardType === 3 && f.jianzhang) return true;
    if (guardType === 2 && f.tidu) return true;
    if (guardType === 1 && f.zongdu) return true;
    if (f.medalLevelThreshold > 0 && medalLevel >= f.medalLevelThreshold) return true;
    // 未勾选任何条件 → 放行所有入场
    if (!f.zongdu && !f.tidu && !f.jianzhang && f.medalLevelThreshold <= 0) return true;
    return false;
  }

  private isNative(): boolean {
    try {
      return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    } catch {
      return false;
    }
  }

  /** emit 到展示画布（浏览器源 / 编辑 iframe）。经 Rust 服务器广播 {type:"event",payload}，
   *  所有 WS 客户端（直播姬源 + 编辑 modal）都会收到。server 未运行 / 非 Tauri 时静默跳过。 */
  private async emitTo(event: DisplayEvent) {
    await this.broadcast({ type: "event", payload: event });
  }
}

/** 本地视频绝对路径 → 浏览器源可加载的相对 URL（经 Rust 服务器 /api/video 提供，自带 Range）。
 *  消费端（直播姬浏览器源 / 编辑 iframe / 主窗口编辑面板）与 server 同源，直接拼接相对路径即可。 */
export function toDisplayVideoSrc(path: string): string {
  return path ? `/api/video?p=${encodeURIComponent(path)}` : "";
}

/** 主窗口 UI 读取今日达标礼物（供"展示"页预览 + 关闭窗口后仍可查看）。 */
export async function getTodayQualifyingGifts(mid: number): Promise<DisplayGiftItem[]> {
  const platform = await getPlatform();
  if (platform.isNative) {
    try {
      await ensureGiftCatalogLoaded(platform);
    } catch {}
  }
  const config = await loadDisplayConfig(mid);
  return loadTodayQualifyingGifts(mid, config.giftPriceThreshold);
}

/** 全局单例服务 */
export const displayDanmaku = new DisplayDanmakuService();