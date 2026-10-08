/**
 * 展示模块 —— 弹幕监听服务（运行于主窗口）。
 *
 * 用 bili-live-listener 监听"当前登录主播自己直播间"的实时弹幕：
 *  - 入场（INTERACT_WORD / INTERACT_WORD_V2 / ENTRY_EFFECT，均在 raw 层防御式解析）
 *    → 按配置过滤 → emit 到展示窗口
 *  - 礼物（SEND_GIFT）→ 累加记录到 .data/display-gifts-<mid>.json → 组装达标礼物清单 → emit
 *
 * 仅 Tauri（桌面）环境使用；Web 下不 emit 到独立窗口。
 */
import { getPlatform, type Platform } from "@/lib/platform";
import {
  ENTRY_COOLDOWN_MS,
  type DisplayConfig,
  type DisplayEvent,
  type DisplayGiftItem,
  type EntryParticleMode,
  type GiftEffectFrameConfig,
  type LayoutElementId,
  type MovableRect,
  type ScreenOrientation,
} from "./types";
import {
  displayMaster,
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
import {
  ensureGiftCatalogLoaded,
  getGiftImg,
  getGiftList,
  resolveGiftAliasName,
} from "@/lib/gift-catalog-client";
import { getGiftEffectsMap } from "@/lib/gift-local-store";

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
  "INTERACT_WORD_V2",
  "ENTRY_EFFECT",
  "SEND_GIFT",
  "SEND_GIFT_V2",
  "UNIVERSAL_EVENT_GIFT_V2",
  "DANMU_MSG",
  "GUARD_BUY",
  "USER_TOAST_MSG",
  "WELCOME_GUARD",
  "SUPER_CHAT_MESSAGE",
];

/** GUARD_BUY/USER_TOAST_MSG 的 guard_level → 大航海名称兜底（1=总督 2=提督 3=舰长），
 *  两条命令都带 gift_name/role_name 时优先用其原值。 */
const GUARD_LEVEL_GIFT_NAME: Record<number, string> = { 1: "总督", 2: "提督", 3: "舰长" };

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
    if (cmd === "INTERACT_WORD_V2") {
      const v2 = parseInteractWordV2(raw?.data);
      return {
        uid: v2?.uid,
        uname: v2?.uname,
        msgType: v2?.msgType,
        isPb: typeof raw?.data?.pb === "string",
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
    if (cmd === "USER_TOAST_MSG") {
      const d = raw?.data ?? {};
      return { uid: d.uid, uname: d.username, guardLevel: d.guard_level, roleName: d.role_name, price: d.price, num: d.num };
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

/** 解析 INTERACT_WORD_V2 的 data.pb（protobuf）为入场所需的最小用户信息。
 *  背景：B站对部分特殊用户（高荣耀等级/大航海等高权重账号）会把进场消息从明文
 *  INTERACT_WORD 改为 INTERACT_WORD_V2（protobuf，data.pb 为 base64），而
 *  bili-live-listener 只订阅 INTERACT_WORD/ENTRY_EFFECT，未订阅 V2 → 这类用户的
 *  进场被整条丢弃（表现为"某个特殊用户永远无法触发入场提示与入场动画"）。
 *  字段号取自 blivedm（xfgryujk/blivedm，models/pb.py）：uid=1 uname=2 msg_type=5
 *  timestamp=7 uinfo=22；uinfo 子消息字段号：base=2（base.face=2）、medal=3（medal.level=2）、
 *  wealth=4（wealth.level=1）、title=5、guard=6（guard.level=1）；msg_type 1=进入 2=关注 3=分享。
 *  以上字段号经真实抓包样本解码逐一验证（medal.level/wealth.level 与 JSON 明文一致）。
 *  当 data 无 pb（JSON 变体）时回退读取明文字段。 */
function parseInteractWordV2(
  data: any,
): { uid: number; uname: string; face: string; msgType: number; guardType: number; medalLevel: number } | null {
  const pbB64 = data?.pb;
  if (typeof pbB64 === "string" && pbB64) {
    let fields: PbField[];
    try {
      const raw = Uint8Array.from(atob(pbB64), (c) => c.charCodeAt(0));
      fields = pbDecode(raw, 0, raw.length);
    } catch {
      return null; // base64 损坏 → 视为解析失败
    }
    const uid = pbInt(fields, 1);
    if (!uid) return null;
    const uinfo = pbMsg(fields, 22);
    const base = uinfo ? pbMsg(uinfo, 2) : null;
    const medal = uinfo ? pbMsg(uinfo, 3) : null;
    const guard = uinfo ? pbMsg(uinfo, 6) : null;
    return {
      uid,
      uname: pbStr(fields, 2),
      face: base ? pbStr(base, 2) : "",
      msgType: pbInt(fields, 5),
      guardType: guard ? pbInt(guard, 1) : 0,
      medalLevel: medal ? pbInt(medal, 2) : 0,
    };
  }
  // 无 pb → JSON 变体，字段与 INTERACT_WORD 同构，复用统一解析
  return parseEntryJson(data);
}

/** 防御式解析入场原始包（JSON）为入场所需最小信息。
 *  库内 dataProcessor 直接访问 data.uinfo.base.name / data.uinfo.guard.level，缺字段
 *  即抛异常并中断该命令的全部监听器 → 整条入场丢失。这里全部用可选链兜底，任何缺字段
 *  只退化为 0/空串，不会抛错。 */
function parseEntryJson(
  data: any,
): { uid: number; uname: string; face: string; msgType: number; guardType: number; medalLevel: number } | null {
  if (!data || typeof data !== "object") return null;
  const uid = Number(data.uid) || 0;
  if (!uid) return null;
  const uinfo = data.uinfo ?? {};
  const base = uinfo.base ?? {};
  const medal = uinfo.medal ?? data.fans_medal ?? {};
  const guard = uinfo.guard ?? {};
  return {
    uid,
    uname: String(base.name ?? data.uname ?? ""),
    face: String(data.face ?? base.face ?? ""),
    msgType: Number(data.msg_type) || 0,
    guardType: Number(guard.level ?? data.guard_level ?? data.guard_type) || 0,
    medalLevel: Number(medal.level ?? medal.medal_level) || 0,
  };
}

/** 判断 JSON 变体是否携带礼物特征字段。
 *  B站会把"互动会话汇总/房间统计"类包（biz_session_id、members、room_status、channel_users
 *  等，无任何礼物字段）也通过 UNIVERSAL_EVENT_GIFT_V2 通道推送——它们不是礼物事件，
 *  parseNewGift 必然返回空（无 uid/giftId），导致误报"解析失败"。此处区分：无任何礼物
 *  特征字段 → 非礼物事件，调用处静默跳过。 */
function isGiftJson(d: any): boolean {
  if (!d || typeof d !== "object") return false;
  if (Array.isArray(d.items) || Array.isArray(d.gifts)) return true;
  return [
    "uid", "uname", "giftId", "gift_id", "gift_name", "asset", "user", "price", "num",
  ].some((k) => d[k] !== undefined && d[k] !== null);
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

/** 获取弹幕服务器的 token（须携带登录 Cookie + buvid3，否则可能触发风控 -352）。
 *  模块级共享：展示监听与「礼物完整录屏」旁路监听都要用它建 WS。 */
async function fetchDanmuToken(platform: Platform, roomId: number): Promise<string> {
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
    "[弹幕]getConf 请求",
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
    "[弹幕]getConf 返回",
    JSON.stringify({ code: data?.code, message: data?.message, msg: data?.msg, hasToken: !!data?.data?.token }),
  );
  if (data?.code !== 0 || !data?.data?.token) {
    const errMsg = data?.message || data?.msg;
    console.log("[弹幕]getConf 失败: code=", data?.code, "message=", data?.message, "msg=", data?.msg);
    throw new Error(String(errMsg ?? "获取弹幕服务器失败"));
  }
  return data.data.token;
}

// ==================== 礼物关键字（弹幕精确匹配礼物名称 → 播放特效） ====================

/** 礼物名称 → gift_id 映射（仅包含"有特效"的礼物）。连接房间时重建，随礼物目录刷新。 */
let giftEffectNameMap: Map<string, number> | null = null;
/** 上次构建时间（空表时用于限频重建） */
let giftEffectNameMapAt = 0;

/** 重建礼物名称映射（只保留在特效绑定表中的礼物）。 */
function rebuildGiftEffectNameMap(): Map<string, number> {
  const effects = getGiftEffectsMap();
  const map = new Map<string, number>();
  for (const g of getGiftList()) {
    const id = Number(g?.id) || 0;
    const name = String(g?.name ?? "");
    if (!id || !name) continue;
    if (!effects[id]) continue; // 无特效的礼物不参与关键字匹配
    if (!map.has(name)) map.set(name, id);
  }
  giftEffectNameMap = map;
  giftEffectNameMapAt = Date.now();
  console.log("[展示]礼物关键字特效名表构建完成，可匹配礼物数=", map.size);
  return map;
}

/**
 * 获取礼物名称映射（懒构建 + 缓存）。
 * 注意：礼物目录（gift-list.json / gift-effects.json）可能晚于弹幕服务就绪，若建连那刻数据
 * 尚未加载会得到空表；空表不长期缓存，最多每 30s 重建一次，避免"一次空表永久失效"以及
 * 高频弹幕下反复重建。
 */
function getGiftEffectNameMap(): Map<string, number> {
  if (giftEffectNameMap && giftEffectNameMap.size > 0) return giftEffectNameMap;
  if (giftEffectNameMap && Date.now() - giftEffectNameMapAt < 30000) return giftEffectNameMap;
  return rebuildGiftEffectNameMap();
}

/**
 * 廉价预筛：判断弹幕内容是否"像"礼物名，用于在精确匹配前排除绝大多数非礼物弹幕（性能保护）：
 *  - 仅允许 汉字/英文字母/数字（含表情、标点、其他符号的直接排除）
 *  - 按"连续英文字母数字算 1 个字、汉字每个算 1 个字"计长度，礼物名称为 2~5 个字
 */
function looksLikeGiftName(content: string): boolean {
  const s = content.trim();
  if (!s || s.length > 16) return false;
  if (!/^[\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]+$/.test(s)) return false; // 含表情/标点/符号
  let units = 0;
  let inWord = false;
  for (const ch of s) {
    if (/[A-Za-z0-9]/.test(ch)) {
      if (!inWord) {
        units++;
        inWord = true;
      }
    } else {
      units++;
      inWord = false;
    }
    if (units > 5) return false;
  }
  return units >= 2;
}

/** 「同一次进场的重复下发包」合并窗口（ms）：B 站对同一次进场会同时下发
 *  INTERACT_WORD(_V2) 与 ENTRY_EFFECT，handleEntry 因此被调用多遍，这些都算同一次入场。 */
const ENTRY_DEDUP_MS = 2000;

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
   *  不至于停留在 idle，导致面板卡片的连接状态行不显示） */
  private currentStatus: DisplayServiceStatus = { state: "idle" };
  // 弹幕 token 缓存：弹幕接口有风控，不能每次重连都重新拉取；
  // 首次进房间拉一次，后续断线重连直接复用，避免高频请求把 IP 打成 -352。
  private cachedToken: string | null = null;
  private cachedRoomId = 0;
  /** 礼物特效配套 JSON 缓存（web_mp4_json URL → 配置；null=拉取失败，避免反复重试） */
  private effectJsonCache = new Map<string, GiftEffectFrameConfig | null>();
  /** 大航海特效去重（uid:guardLevel → 最近触发时刻）：GUARD_BUY 与 USER_TOAST_MSG 可能同时下发 */
  private guardEffectAt = new Map<string, number>();
  /** 入场触发去重（uid → 各类最近 emit 时刻）：同一次进场 B 站会对特殊用户同时下发
   *  INTERACT_WORD(_V2) 与 ENTRY_EFFECT，handleEntry 会被调用多次；冷却为 0（B站默认）
   *  时没有冷却兜底，若不去重会一次进场播两次特效。窗口 2s 只合并"同一次进场的重复
   *  下发包"，不改变冷却语义（用户快速再次进场仍可触发）。 */
  private entryEmitAt = new Map<number, { anime: number; entry: number }>();
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
        // 同步进调试日志（面板卡片展示 + 落盘 display-danmu-debug.json）：
        // 主窗口 console 只有 DevTools 能看，/display?diag=1 探针结果需经此可查
        if (msg.text) this.pushDebug("画布", "log", msg.text);
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
      bannerText: cfg.banner?.text ?? "",
      animeFeatherH: cfg.animeFeatherH,
      animeFeatherV: cfg.animeFeatherV,
      giftBarOrientation: cfg.giftBarOrientation,
      entryParticleMode: cfg.entryParticleMode,
      flags: {
        master: displayMaster(cfg),
        entry: cfg.entry,
        gift: cfg.gift,
        anime: cfg.anime,
        giftEffect: !!cfg.giftEffect?.enabled,
        banner: !!cfg.banner?.enabled,
      },
    });
  }

  /** 广播当前各模块开关状态（master/entry/gift/anime/giftEffect/banner）到浏览器源，画布据此即时
   *  显隐元素。在面板切换各模块开关后调用（配置已落盘），浏览器源无需重连即可响应。
   *  master 为派生值：任一画布显示子模块开启即为 true。 */
  async broadcastFlags(): Promise<void> {
    const cfg = await loadDisplayConfig(this.mid);
    await this.broadcast({
      type: "flags",
      flags: {
        master: displayMaster(cfg),
        entry: cfg.entry,
        gift: cfg.gift,
        anime: cfg.anime,
        giftEffect: !!cfg.giftEffect?.enabled,
        banner: !!cfg.banner?.enabled,
      },
    });
  }

  /** 广播横幅按钮最新文字到画布（面板输入框失焦后调用，配置已落盘）。 */
  async broadcastBannerText(text: string): Promise<void> {
    await this.broadcast({ type: "bannerText", text });
  }

  /** 广播入场动画视频边缘羽化强度（左右/上下）到画布（面板调整后调用，配置已落盘）。 */
  async broadcastAnimeFeather(h: number, v: number): Promise<void> {
    await this.broadcast({ type: "animeFeather", h, v });
  }

  /** 广播礼物展示条方向（横条/竖条）到画布（面板切换后调用，配置已落盘）。 */
  async broadcastGiftBarOrientation(v: "horizontal" | "vertical"): Promise<void> {
    await this.broadcast({ type: "giftBarOrientation", v });
  }

  /** 广播入场提示粒子聚散方式（中心聚散/左右聚散）到画布（面板切换后调用，配置已落盘）。 */
  async broadcastEntryParticleMode(mode: EntryParticleMode): Promise<void> {
    await this.broadcast({ type: "entryParticleMode", v: mode });
  }

  /** 触发一次撒花庆祝（纸屑 + 飘带，一次性效果；面板"撒花"按钮调用）。 */
  async celebrate(): Promise<void> {
    await this.broadcast({ type: "celebrate" });
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
        rebuildGiftEffectNameMap(); // 礼物目录就绪后重建"有特效礼物"名称映射（供关键字特效）
      } catch {
        /* 礼物目录加载失败不阻塞监听 */
      }
    }

    this.emitStatus({ state: "connecting" });

    try {
      // 复用缓存的 token；仅首次进该房间或 token 缺失时才请求 getDanmuInfo
      let token = this.cachedToken;
      if (!token || this.cachedRoomId !== roomId) {
        token = await fetchDanmuToken(platform, roomId);
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
    // 直接在底层 ws 监听入场原始包，不再依赖库的 dataProcessor，原因有二：
    //  1) 库只订阅 INTERACT_WORD / ENTRY_EFFECT，未订阅 INTERACT_WORD_V2 —— 后者是
    //     B站当前使用的入场命令（新版 protobuf，data.pb 为 base64）。未订阅该命令时，
    //     这类用户的下发整条被丢弃，入场提示与入场动画均不触发；
    //  2) 库的 dataProcessor 对 data.uinfo.base.name / data.uinfo.guard.level 等字段
    //     是非防御式访问，缺字段即抛异常；该类监听器注册在底层同一命令上，异常会中断
    //     该命令的全部监听器 → 整条入场丢失（表现为"某位用户永远无法触发入场"）。
    // 因此在 raw 层统一防御式解析，可同时覆盖以上两种情况；入场提示与入场动画都从
    // handleEntry 入口触发，一处修复即可同时生效。
    for (const cmd of ["INTERACT_WORD", "INTERACT_WORD_V2", "ENTRY_EFFECT"]) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, async (raw: any) => {
          if (!this.active) return;
          const src = cmd === "INTERACT_WORD_V2" ? parseInteractWordV2(raw?.data) : parseEntryJson(raw?.data);
          if (!src || !src.uid) return;
          // INTERACT_WORD 系列仅处理"进入"（msg_type 1=进入 2=关注 3=分享）；ENTRY_EFFECT 无 msg_type
          if (cmd !== "ENTRY_EFFECT" && src.msgType !== 1) return;
          await this.handleEntry(
            mid,
            {
              uid: src.uid,
              uname: src.uname,
              face: src.face,
              guardType: src.guardType,
              fansMedal: src.medalLevel ? { level: src.medalLevel } : undefined,
            },
            // INTERACT_WORD_V2 的 pb 变体已能解析出勋章等级/大航海等级（见
            // parseInteractWordV2），与明文路径同样参与入场筛选，不再绕过。
          );
        }),
      );
    }

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
          const pbList = parseGiftV2Pb(raw?.data);
          const jsonList = parseNewGift(raw);
          const list = pbList ?? jsonList;
          if (!list.length) {
            // JSON 变体且无任何礼物特征字段 → 非礼物事件（互动会话/房间统计等混入
            // 该通道的统计包），静默跳过，不误报"解析失败"
            if (!pbList && !isGiftJson(raw?.data)) return;
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

    // ---- 大航海（真实开通/续费舰长·提督·总督）：GUARD_BUY / USER_TOAST_MSG ----
    // 真实开通大航海时 B站下发的是这两条命令（并非 SEND_GIFT），bili-live-listener 的 onGift
    // 不会触发 → 特效漏播。这里单独触发礼物特效，名称统一交给 emitGiftEffect 做别名换算
    // （舰长→舰长一号…）。只播特效，不写礼物记录、不改收益口径，避免影响既有送礼流程。
    for (const cmd of ["GUARD_BUY", "USER_TOAST_MSG"]) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, async (raw: any) => {
          if (!this.active) return;
          const d = raw?.data ?? {};
          const uid = Number(d.uid) || 0;
          const guardLevel = Number(d.guard_level) || 0;
          const name = String(d.gift_name || d.role_name || "").trim() || GUARD_LEVEL_GIFT_NAME[guardLevel] || "";
          if (!name) return;
          // 「原始录屏」只读订阅点：审计口径 `price` 单位是金瓜子（1 电池 = 100 金瓜子），
          // 故舰长 138000 金瓜子 → 1380 电池。放在展示配置判定之前（录制不吃展示配置）。
          notifyQualifyingGift({
            giftName: name,
            priceBattery: (Number(d.price) || 0) / 100,
            ts: Math.floor(Date.now() / 1000),
            roomId: this.roomId,
          });
          const config = await loadDisplayConfig(mid);
          if (!config.giftEffect?.enabled) return;
          // 两条命令可能对同一次开通同时下发，短窗口内按"用户 + 等级"去重，避免特效播两遍
          const key = `${uid}:${guardLevel || name}`;
          const now = Date.now();
          if (now - (this.guardEffectAt.get(key) ?? 0) < 3000) return;
          this.guardEffectAt.set(key, now);
          this.pushDebug("guard", "开通/续费", { uid, guardLevel, giftName: name, cmd });
          await this.emitGiftEffect(Number(d.gift_id) || 0, name);
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

        // 礼物关键字特效：弹幕精确匹配"有特效礼物名称"→ 在收礼特效同位置播放（独立于盲盒查询）
        if (config.giftEffect?.enabled && config.giftEffect?.keyword) {
          if (looksLikeGiftName(content)) {
            const map = getGiftEffectNameMap();
            const key = content.trim();
            // 大航海：弹幕"舰长/提督/总督/上舰"精确匹配时换算成"舰长一号/提督一号/总督一号"再查
            const hitId = map.get(key) ?? map.get(resolveGiftAliasName(key)) ?? null;
            this.pushDebug("danmu", hitId ? "关键字命中" : "关键字候选未匹配", {
              content: key,
              giftId: hitId ?? 0,
              nameMapSize: map.size,
            });
            if (hitId) await this.emitGiftEffect(hitId, key);
          }
        }

        if (!config.blindBoxQuery?.enabled) return;
        const senderUid = Number(d.user.uid);
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

  /** 入场触发去重：同一 uid 同一类（anime/entry）在 2s 窗口内只允许 emit 一次。
   *  同步 check-and-set，与 emit 在同一同步段内完成，无 await 间隔、无竞态；
   *  被去重的调用不写冷却记录，不影响后续真正的再次进场。 */
  private shouldEmitEntry(uid: number, kind: "anime" | "entry"): boolean {
    const now = Date.now();
    const rec = this.entryEmitAt.get(uid);
    const last = rec ? rec[kind] : 0;
    if (last && now - last < ENTRY_DEDUP_MS) return false;
    if (rec) rec[kind] = now;
    else this.entryEmitAt.set(uid, { anime: kind === "anime" ? now : 0, entry: kind === "entry" ? now : 0 });
    // 过期清理：map 过大时删掉窗口外的旧项，避免长期运行无限增长
    if (this.entryEmitAt.size > 300) {
      for (const [k, v] of this.entryEmitAt) {
        if (now - Math.max(v.anime, v.entry) > ENTRY_DEDUP_MS) this.entryEmitAt.delete(k);
      }
    }
    return true;
  }

  /** 处理一条入场信息：高级用户动画 + 普通入场提示（动画是额外的，不替代入场提示）。
   *  入场提示是否展示由 matchesEntryFilter（大航海/粉丝勋章等级筛选）决定。 */
  private async handleEntry(mid: number, user: any) {
    if (!this.active || !user || !user.uid) return;
    const config = await loadDisplayConfig(mid);
    const guardType = Number(user.guardType) || 0;
    const medalLevel = Number(user.fansMedal?.level) || 0;
    const uid = Number(user.uid);

    // 先判定两个模块本次是否"本应触发"（都不触发则不记冷却时间）
    const animeCfg = Object.values(config.animeList).find(
      (a) => a.enabled && (a.videoLandscape || a.videoPortrait) && a.uid === user.uid,
    );
    const animeOn = !!(config.anime && animeCfg && this.isNative());
    const entryOn = !!(config.entry && this.matchesEntryFilter(config, guardType, medalLevel));
    if (!animeOn && !entryOn) {
      this.pushDebug("entry", "filtered", {
        uid,
        uname: user.uname || "",
        guardType,
        medalLevel,
        entryOn: !!config.entry,
        matched: this.matchesEntryFilter(config, guardType, medalLevel),
      });
      return;
    }

    // 入场提示 / 入场动画 各有独立冷却（同款选项、独立记录，互不影响）；
    // 记录随 display-config.json 本地持久化
    const now = Date.now();
    let needSave = false;

    // 高级用户自定义入场动画：命中名单且启用 → 播放视频动画（自查入场动画冷却）
    if (animeOn && animeCfg) {
      const animeCooldownMs =
        ENTRY_COOLDOWN_MS[config.animeCooldown] ?? ENTRY_COOLDOWN_MS.bilibili;
      const animeLast = Number(config.animeLastSeen[uid]) || 0;
      // 0 = 不设本地冷却（B站默认）：B 站自身对重复入场有去重/冷却，本地每次都触发
      if (animeCooldownMs > 0 && animeLast && now - animeLast < animeCooldownMs) {
        // 冷却中：不播动画、不更新时间（完全对照入场提示的冷却逻辑）
        this.pushDebug("entry", "anime-cooldown", {
          uid,
          uname: user.uname || "",
          waitSec: Math.ceil((animeCooldownMs - (now - animeLast)) / 1000),
        });
      } else {
        // 同一次进场 B 站会同时下发 INTERACT_WORD(_V2) + ENTRY_EFFECT，handleEntry 跑多遍；
        // emit 前同步去重（2s 窗口），防止一次进场播两次动画
        if (!this.shouldEmitEntry(uid, "anime")) {
          this.pushDebug("entry", "anime-dedup", { uid, uname: user.uname || "" });
        } else {
          const video = resolveAnimeVideo(animeCfg, config.screenOrientation);
          const seg = resolveAnimeSegment(animeCfg, config.screenOrientation);
          this.pushDebug("entry", "anime", {
            uid,
            uname: user.uname || "",
            video,
            startSec: seg.startSec,
            endSec: seg.endSec,
          });
          this.emitTo({
            type: "anime",
            user: { uid, uname: user.uname || "", face: user.face || "" },
            videoSrc: toDisplayVideoSrc(video),
            startSec: seg.startSec,
            endSec: seg.endSec,
          });
          // 记录动画触发时间（先同步写入共享配置对象，再落盘；并发 handleEntry 也能看到）
          // 冷却为 0 时不记录：记录只服务于冷却判定，写了反而让每次入场都落盘一次配置
          if (animeCooldownMs > 0) {
            config.animeLastSeen[uid] = now;
            needSave = true;
          }
        }
      }
      // 本次未播动画才继续走入场提示（播放了就不再重复展示，见下方 gate）
    }

    // 入场提示：本次已播入场动画则跳过（同一用户同一次入场只留一种特效，避免重复）。
    // 关键：不能只用「本遍调用」的局部标志判断——B 站对同一次进场会同时下发
    // INTERACT_WORD(_V2) + ENTRY_EFFECT，handleEntry 会跑多遍；第二遍动画往往被冷却/2s
    // 去重拦下，若用本遍标志会误判「没播动画」而照常 emit entry，导致特效同时出现。
    // 改为读共享时间戳 entryEmitAt[uid].anime（动画实际 emit 时由 shouldEmitEntry 写入）：
    // 无论哪一遍播的动画，后续同 uid 的调用都能看到「刚刚播过」，从而正确跳过入场提示。
    const animeAt = this.entryEmitAt.get(uid)?.anime || 0;
    const animeJustPlayed = animeAt > 0 && now - animeAt < ENTRY_DEDUP_MS;
    if (entryOn && !animeJustPlayed) {
      // 入场冷却：同一用户距上次触发不足设定间隔 → 不触发、不更新时间
      //（频繁进出直播间反复触发体验不好；0 = 不设本地冷却，跟随 B 站自身去重）
      const cooldownMs = ENTRY_COOLDOWN_MS[config.entryCooldown] ?? ENTRY_COOLDOWN_MS.bilibili;
      const last = Number(config.entryLastSeen[uid]) || 0;
      if (cooldownMs > 0 && last && now - last < cooldownMs) {
        this.pushDebug("entry", "cooldown", {
          uid,
          uname: user.uname || "",
          waitSec: Math.ceil((cooldownMs - (now - last)) / 1000),
        });
      } else {
        // 同一次进场 B 站会同时下发 INTERACT_WORD(_V2) + ENTRY_EFFECT，handleEntry 跑多遍；
        // emit 前同步去重（2s 窗口），防止一次进场播两次入场特效
        if (!this.shouldEmitEntry(uid, "entry")) {
          this.pushDebug("entry", "dedup", { uid, uname: user.uname || "" });
        } else {
          // 记录触发时间（先同步写入共享配置对象，再落盘；并发 handleEntry 也能看到）
          // 冷却为 0 时不记录：记录只服务于冷却判定，写了反而让每次入场都落盘一次配置
          if (cooldownMs > 0) {
            config.entryLastSeen[uid] = now;
            needSave = true;
          }
          this.pushDebug("entry", "emit", { uid, uname: user.uname || "", guardType, medalLevel });
          this.emitTo({
            type: "entry",
            user: {
              uid,
              uname: user.uname || "",
              face: user.face || "",
              guardType: guardType as any,
              medalLevel,
            },
          });
        }
      }
    } else if (entryOn && animeJustPlayed) {
      this.pushDebug("entry", "skip-entry-after-anime", { uid, uname: user.uname || "" });
    }

    if (needSave) void saveDisplayConfig(mid, config).catch(() => {});
  }

  /** 拉取礼物特效配套 JSON 配置（主窗口用 invoke fetch_json 绕过 CORS），带内存缓存。 */
  private async loadEffectConfig(url: string): Promise<GiftEffectFrameConfig | null> {
    if (!url) return null;
    if (this.effectJsonCache.has(url)) return this.effectJsonCache.get(url) ?? null;
    let cfg: GiftEffectFrameConfig | null = null;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      cfg = await invoke<GiftEffectFrameConfig>("fetch_json", { url });
    } catch {
      cfg = null; // 拉取失败：缓存 null 避免高频弹幕反复请求
    }
    this.effectJsonCache.set(url, cfg);
    return cfg;
  }

  /**
   * 查特效绑定表 → 拉配套 JSON → 下发画布播放礼物特效。
   * 画布运行在外部浏览器（直播姬浏览器源），无 Tauri IPC，故特效查找与 JSON 获取都在
   * 主窗口完成，仅把 {videoSrc, config} 经 WS 交给画布做 alpha/RGB 合成播放。
   */
  private async emitGiftEffect(giftId: number, giftName: string): Promise<void> {
    if (!this.active) return;
    const effects = getGiftEffectsMap();
    let id = effects[giftId]?.web_mp4 ? giftId : 0;
    if (!id) {
      // 大航海：开通/续费舰长/提督/总督触发的动画不在礼物列表与特效列表中，对应的是
      // "舰长一号/提督一号/总督一号"，故把名称换成别名后再查（名称表只收录带特效的 id）
      id = getGiftEffectNameMap().get(resolveGiftAliasName(giftName)) ?? 0;
    }
    const bind = id ? effects[id] : undefined;
    if (!id || !bind?.web_mp4) {
      this.pushDebug("giftEffect", "无特效", { giftId, giftName });
      return;
    }
    const config = await this.loadEffectConfig(bind.web_mp4_json);
    this.pushDebug("giftEffect", "emit", { giftId: id, giftName, hasConfig: !!config });
    this.emitTo({ type: "giftEffect", giftId: id, giftName, videoSrc: bind.web_mp4, config });
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

    // 「原始录屏」只读订阅点：与展示开关无关（录制不吃展示配置），放在 native 判定之前
    notifyQualifyingGift({ giftName: String(d.giftName || ""), priceBattery, ts, roomId: this.roomId });

    if (!this.isNative()) return;

    const config = await loadDisplayConfig(mid);

    // 礼物特效模块：该礼物在特效绑定表中有动画则下发画布播放（独立于"收到的礼物展示"开关）
    if (config.giftEffect?.enabled) {
      await this.emitGiftEffect(giftId, d.giftName || "");
    }

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

/** 收礼事件（只读订阅点用）。`priceBattery` = 礼物单价，单位电池。 */
export type QualifyingGiftEvent = {
  /** 礼物名；大航海为「舰长 / 提督 / 总督」 */
  giftName: string;
  /** 单价（电池） */
  priceBattery: number;
  /** 送礼时刻（秒） */
  ts: number;
  /** 礼物来源房间号（订阅方按房间过滤，避免把别的直播间的礼物当成自己的）。 */
  roomId: number;
};

const qualifyingGiftListeners = new Set<(e: QualifyingGiftEvent) => void>();

/**
 * 订阅「收到礼物」的只读通知（送礼分支 + 大航海分支各回调一次），与展示配置无关：
 * 「原始录屏」用它做触发判定（阈值比较 / 尾窗计时都在订阅方）。返回退订函数。
 */
export function subscribeQualifyingGift(cb: (e: QualifyingGiftEvent) => void): () => void {
  qualifyingGiftListeners.add(cb);
  return () => {
    qualifyingGiftListeners.delete(cb);
  };
}

function notifyQualifyingGift(e: QualifyingGiftEvent) {
  for (const cb of qualifyingGiftListeners) {
    try {
      cb(e);
    } catch (err) {
      console.error("[展示] 收礼订阅回调异常", err);
    }
  }
}

/** 全局单例服务 */
export const displayDanmaku = new DisplayDanmakuService();

/**
 * 旁路礼物监听服务（「礼物完整录屏」专用）。
 *
 * 与展示监听 displayDanmaku 彻底解耦：录屏可指定任意直播间做触发源，若复用展示单例会把
 * 展示监听劫持到指定房间（把别的直播间的礼物写进自己的展示列表/统计/画布）。这里用独立 WS
 * 只收礼物、只发 QualifyingGiftEvent 通知供录屏触发判定，不写礼物记录、不发画布、不回盲盒
 * 查询，从而保证录屏的「指定房间号」不影响展示/礼物统计。
 */
class GiftWatchService {
  private roomId = 0;
  private mid = 0;
  private live: any = null;
  private removeHandlers: Array<() => void> = [];
  private active = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private cachedToken: string | null = null;
  private cachedRoomId = 0;

  /** 启动监听指定房间的礼物（幂等：已在监听同一房间则直接返回；换房间则切换）。 */
  async start(roomId: number, mid: number): Promise<void> {
    if (this.active && this.roomId === roomId) return;
    this.retry = 0;
    await this.connect(roomId, mid);
  }

  /** 停止：断开 WS、取消重连、释放事件。 */
  stop(): void {
    this.active = false;
    this.roomId = 0;
    this.mid = 0;
    this.cachedToken = null;
    this.cachedRoomId = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeListeners();
  }

  private closeListeners(): void {
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

  private async connect(roomId: number, mid: number): Promise<void> {
    this.closeListeners();
    this.active = true;
    this.roomId = roomId;
    this.mid = mid;
    try {
      const platform = await getPlatform();
      // 复用缓存 token，避免高频重连触发风控
      let token = this.cachedToken;
      if (!token || this.cachedRoomId !== roomId) {
        token = await fetchDanmuToken(platform, roomId);
        this.cachedToken = token;
        this.cachedRoomId = roomId;
      }
      const { BiliLive } = (await import("bili-live-listener")) as {
        BiliLive: new (roomId: number, opts: { key: string; uid: number; isBrowser: boolean }) => any;
      };
      this.live = new BiliLive(roomId, { key: token, uid: mid, isBrowser: true });
      this.bindGiftHandlers();
      this.live.onOpen(() => {
        this.retry = 0;
        console.log("[旁路礼物]WS open", { roomId });
      });
      this.live.onClose(() => {
        console.log("[旁路礼物]WS close", { roomId });
        this.scheduleReconnect(roomId, mid);
      });
      this.live.onError((err: any) => {
        const msg = err?.message || String(err);
        console.log("[旁路礼物]WS error", msg);
        this.scheduleReconnect(roomId, mid, msg);
      });
      console.log("[旁路礼物]WS 建立", { roomId });
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.log("[旁路礼物]start 异常", msg);
      this.scheduleReconnect(roomId, mid, msg);
    }
  }

  /** 只绑礼物相关命令：旧协议 onGift、新协议 pb/json、大航海开通/续费。 */
  private bindGiftHandlers(): void {
    // 旧协议礼物
    this.removeHandlers.push(
      this.live.onGift((message: any) => {
        const d = message?.data;
        if (!d || d.coinType !== "gold") return; // 仅金瓜子（有价）礼物
        this.notifyGift(d);
      }),
    );
    // 新协议礼物（pb / json 变体），逐条复用解析
    for (const cmd of ["SEND_GIFT_V2", "UNIVERSAL_EVENT_GIFT_V2"]) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, (raw: any) => {
          const pbList = parseGiftV2Pb(raw?.data);
          const jsonList = parseNewGift(raw);
          const list = pbList ?? jsonList;
          if (!list.length) return;
          for (const g of list) {
            if (g.coinType !== "gold") continue;
            this.notifyGift(g);
          }
        }),
      );
    }
    // 大航海开通/续费（GUARD_BUY / USER_TOAST_MSG）
    for (const cmd of ["GUARD_BUY", "USER_TOAST_MSG"]) {
      this.removeHandlers.push(
        this.live.onRawMessage(cmd, (raw: any) => {
          const d = raw?.data ?? {};
          const guardLevel = Number(d.guard_level) || 0;
          const name = String(d.gift_name || d.role_name || "").trim() || GUARD_LEVEL_GIFT_NAME[guardLevel] || "";
          if (!name) return;
          notifyQualifyingGift({
            giftName: name,
            priceBattery: (Number(d.price) || 0) / 100,
            ts: Math.floor(Date.now() / 1000),
            roomId: this.roomId,
          });
        }),
      );
    }
  }

  /** 把一条礼物（GiftData 形状）转成只读通知；不落盘、不发画布、不回盲盒。 */
  private notifyGift(d: any): void {
    const ts = Number(d.timestamp) || Math.floor(Date.now() / 1000);
    notifyQualifyingGift({
      giftName: String(d.giftName || ""),
      priceBattery: (Number(d.price) || 0) / 100,
      ts,
      roomId: this.roomId,
    });
  }

  private scheduleReconnect(roomId: number, mid: number, errMsg?: string): void {
    if (!this.active) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // -352 是风控/限流：大幅退避；普通断线较快重连。指数退避，封顶 5 分钟。
    const isRisk = /-352|风控|限流/.test(errMsg ?? "");
    const base = isRisk ? 60_000 : 5_000;
    const max = isRisk ? 300_000 : 120_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.retry, 4));
    this.retry = Math.min(this.retry + 1, 6);
    console.log(`[旁路礼物]${isRisk ? "风控" : "断线"}退避重连 ${delay}ms 后（第 ${this.retry} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.connect(roomId, mid);
    }, delay);
  }
}

/** 「礼物完整录屏」旁路礼物监听单例（与展示监听 displayDanmaku 相互独立）。 */
export const giftWatch = new GiftWatchService();