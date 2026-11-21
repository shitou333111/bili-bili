/**
 * 展示模块 · 信息面板数据源。
 *
 * 画布上的信息面板（榜一 / PK任务 / 心动盲盒）由主窗口的弹幕服务定时/事件触发拉取，
 * 再经 WS 下发到浏览器源。这里只放纯请求与计算逻辑，不含 React / 定时器。
 *
 * 三个接口均无需登录凭证：
 * - 榜一：queryContributionRank（page_size=1）
 * - PK任务：GetPkBattleMain（仅 appkey，无 access_key/sign）
 * - 心动盲盒：GetCrazyFridayData
 */
import { getPlatform } from "@/lib/platform";
import { computeFromDanmu, loadGiftRecordsByRange } from "./gift-db";
import type {
  InfoPanelBlindBoxData,
  InfoPanelData,
  InfoPanelPkData,
  InfoPanelRankData,
  InfoPanelRankKey,
} from "./types";

/** 心动盲盒 / 浪漫城堡兜底图标（接口异常时仍能显示） */
const DEFAULT_BLIND_BOX_IMG =
  "https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png";
const DEFAULT_CASTLE_IMG =
  "https://s1.hdslb.com/bfs/live/4ee13c275e13b0a7404bd8af035775db3c721b86.png";

/** B站移动端 appkey（GetPkBattleMain 用） */
const BILI_APPKEY = "1d8b6e7d45233436";

/** 榜单接口参数表 */
const RANK_QUERIES: Record<InfoPanelRankKey, { type: string; switch: string }> = {
  yesterday: { type: "daily_rank", switch: "yesterday_rank" },
  thisWeek: { type: "weekly_rank", switch: "current_week_rank" },
  lastWeek: { type: "weekly_rank", switch: "last_week_rank" },
  thisMonth: { type: "monthly_rank", switch: "current_month_rank" },
  lastMonth: { type: "monthly_rank", switch: "last_month_rank" },
};

/** 清理接口里的图片地址（部分返回会带反引号/空格） */
function cleanUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/`/g, "").trim();
  if (s.startsWith("//")) return `https:${s}`;
  return s;
}

interface RankResponse {
  code?: number;
  data?: {
    item?: Array<{ uid?: number; name?: string; face?: string }>;
  };
}

/** 拉取某个日期的榜一（id/头像/昵称）；无数据返回 null。 */
export async function fetchRankTop1(
  roomId: number,
  ruid: number,
  key: InfoPanelRankKey,
): Promise<InfoPanelRankData | null> {
  const q = RANK_QUERIES[key];
  const url =
    `https://api.live.bilibili.com/xlive/general-interface/v1/rank/queryContributionRank` +
    `?ruid=${ruid}&room_id=${roomId}&page=1&page_size=1` +
    `&type=${q.type}&switch=${q.switch}&platform=web&web_location=444.8`;
  const platform = await getPlatform();
  const res = await platform.fetchBilibiliJson<RankResponse>({ url, live: true });
  const item = res?.data?.item?.[0];
  if (!item) return null;
  return {
    key,
    uid: Number(item.uid) || 0,
    name: (item.name || "神秘人").trim(),
    face: cleanUrl(item.face),
  };
}

/** PK 任务项（task_type：1=每日首胜 2=每日有效场次 3=每日有效胜利） */
export interface PkTaskItem {
  name: string;
  need_num: number;
  current_num: number;
  task_type: number;
}

export interface PkBattleMain {
  tasks?: PkTaskItem[];
}

interface PkBattleResponse {
  code?: number;
  data?: PkBattleMain;
}

/** 拉取某直播间的 PK 每日任务数据（自己或随机PK对手）。 */
export async function fetchPkBattleMain(roomId: number, ruid: number): Promise<PkBattleMain | null> {
  const ts = Math.floor(Date.now() / 1000);
  const url =
    `https://api.live.bilibili.com/xlive/pk-interface/v1/battle/GetPkBattleMain` +
    `?appkey=${BILI_APPKEY}&build=9020300&c_locale=zh-Hans_CN&channel=yingyongbao` +
    `&device=android&disable_rcmd=0&mobi_app=android&platform=android` +
    `&room_id=${roomId}&ruid=${ruid}&s_locale=zh-Hans_CN&ts=${ts}`;
  const platform = await getPlatform();
  const res = await platform.fetchBilibiliJson<PkBattleResponse>({ url, mobile: true });
  if (!res || res.code !== 0 || !res.data) return null;
  return res.data;
}

/** 某组 PK 任务里「每日首胜」是否已完成（task_type=1，need_num 默认按 1 处理）。 */
export function pkFirstWinDone(data: PkBattleMain | null): boolean {
  const task = data?.tasks?.find((t) => Number(t.task_type) === 1);
  if (!task) return false;
  const need = Number(task.need_num) > 0 ? Number(task.need_num) : 1;
  return Number(task.current_num) >= need;
}

/** 把 PK 接口数据组装成画布渲染结构；opponent 存在即为随机PK中。 */
export function buildPkView(
  data: PkBattleMain | null,
  opponent?: InfoPanelPkData["opponent"],
): InfoPanelPkData {
  const tasks = data?.tasks ?? [];
  const first = tasks.find((t) => Number(t.task_type) === 1);
  const valid = tasks.find((t) => Number(t.task_type) === 2);
  const win = tasks.find((t) => Number(t.task_type) === 3);
  const firstNeed = first && Number(first.need_num) > 0 ? Number(first.need_num) : 1;
  return {
    mode: opponent ? "random" : "normal",
    selfFirstWin: !!first && Number(first.current_num) >= firstNeed,
    validNum: Number(valid?.current_num) || 0,
    validNeed: Number(valid?.need_num) || 0,
    winNum: Number(win?.current_num) || 0,
    winNeed: Number(win?.need_num) || 0,
    opponent,
  };
}

export interface FridayCollectTask {
  target: number;
  sp_probability: number;
  limit: number;
  level: number;
}

export interface FridayRateItem {
  show_multiple: string;
  sp_probability: number;
}

export interface FridayData {
  stage?: number;
  blind_gift_id?: number;
  grand_prize_gift_id?: number;
  blind_gift_img?: string;
  blind_gift_name?: string;
  grand_prize_img?: string;
  grand_prize_name?: string;
  rate_list?: FridayRateItem[];
  collect_task_list?: FridayCollectTask[];
  anchor_data?: {
    normal_task_collect_cnt?: number;
    normal_task_level?: number;
    current_sp?: number;
    current_limit?: number;
  };
}

interface FridayResponse {
  code?: number;
  data?: FridayData;
}

/** 拉取心动盲盒活动数据。 */
export async function fetchFridayData(roomId: number, ruid: number): Promise<FridayData | null> {
  const url =
    `https://api.live.bilibili.com/xlive/custom-activity-interface/general/friday/GetCrazyFridayData` +
    `?room_id=${roomId}&ruid=${ruid}&config_id=1&version=1`;
  const platform = await getPlatform();
  const res = await platform.fetchBilibiliJson<FridayResponse>({ url, live: true });
  if (!res || res.code !== 0 || !res.data) return null;
  return res.data;
}

/** sp_probability → 展示倍率（如 "4"）。 */
function rateMultiple(data: FridayData | null, spProbability: number): string {
  const rate = (data?.rate_list ?? []).find(
    (r) => Number(r.sp_probability) === Number(spProbability),
  );
  return rate?.show_multiple || "3";
}

function sortTasks(data: FridayData | null): FridayCollectTask[] {
  return [...(data?.collect_task_list ?? [])].sort((a, b) => a.level - b.level);
}

/**
 * 收集期（周六~周四）：显示距离下一阶梯的进度。
 * normal_task_level=已完成的阶梯数；level=0 时按 1（20 个 / 4倍1个）处理。
 */
export function buildCollectView(data: FridayData | null): InfoPanelBlindBoxData {
  const collected = Math.max(0, Number(data?.anchor_data?.normal_task_collect_cnt) || 0);
  const level = Math.max(0, Number(data?.anchor_data?.normal_task_level) || 0);
  const tasks = sortTasks(data);
  const nextLevel = Math.max(1, level + 1);
  const tier = tasks.find((t) => Number(t.level) === nextLevel) ?? tasks[tasks.length - 1];
  return {
    mode: "collect",
    icon: cleanUrl(data?.blind_gift_img) || DEFAULT_BLIND_BOX_IMG,
    collected,
    target: Number(tier?.target) || Math.max(20, collected),
    multiple: tier ? rateMultiple(data, tier.sp_probability) : "3",
    limit: Number(tier?.limit) || 0,
    opened: 0,
    profit: 0,
    castleCount: 0,
    castleImg: cleanUrl(data?.grand_prize_img) || DEFAULT_CASTLE_IMG,
  };
}

/** 周五：当前阶梯的爆率/限额（未达 20 个时基础 3 倍、限额 0）。 */
export function fridayTier(data: FridayData | null): { multiple: string; limit: number } {
  const level = Math.max(0, Number(data?.anchor_data?.normal_task_level) || 0);
  if (level <= 0) return { multiple: "3", limit: 0 };
  const tier = sortTasks(data).find((t) => Number(t.level) === level);
  const sp = tier ? tier.sp_probability : Number(data?.anchor_data?.current_sp) || 0;
  const limit = tier ? Number(tier.limit) || 0 : Number(data?.anchor_data?.current_limit) || 0;
  return { multiple: rateMultiple(data, sp), limit };
}

/** 周五：组装开盒统计视图（统计数字来自本地弹幕记录）。 */
export function buildFridayView(
  data: FridayData | null,
  stats: { opened: number; profit: number; castleCount: number },
): InfoPanelBlindBoxData {
  const { multiple, limit } = fridayTier(data);
  return {
    mode: "friday",
    icon: cleanUrl(data?.blind_gift_img) || DEFAULT_BLIND_BOX_IMG,
    collected: Math.max(0, Number(data?.anchor_data?.normal_task_collect_cnt) || 0),
    target: 0,
    multiple,
    limit,
    opened: Math.max(0, Math.floor(stats.opened)),
    profit: Math.round(stats.profit),
    castleCount: Math.max(0, Math.floor(stats.castleCount)),
    castleImg: cleanUrl(data?.grand_prize_img) || DEFAULT_CASTLE_IMG,
  };
}

/** 今天是否为周五（本地时区，B站活动按北京时间，桌面端即本地时区）。 */
export function isFridayNow(now = new Date()): boolean {
  return now.getDay() === 5;
}

/** 本地自然日 [00:00, 次日 00:00) 区间。 */
export function todayRange(now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/**
 * 周五本地统计（不依赖接口刷新）：
 * - opened：今日已开盲盒数（复用盲盒盈亏的弹幕统计 drawCount）
 * - profit：今日盈亏（电池）
 * - castleCount：今日已开出城堡数（本地礼物记录里的 grand_prize_gift_id）
 */
export async function getFridayLocalStats(
  mid: number,
  blindGiftId: number,
  castleGiftId: number,
): Promise<{ opened: number; profit: number; castleCount: number }> {
  if (!mid) return { opened: 0, profit: 0, castleCount: 0 };
  const range = todayRange();
  let opened = 0;
  let profit = 0;
  let castleCount = 0;
  try {
    if (blindGiftId > 0) {
      const res = await computeFromDanmu(mid, 0, blindGiftId, range);
      opened = res.drawCount;
      profit = res.profit;
    }
  } catch {
    /* 统计失败保持 0 */
  }
  if (castleGiftId > 0) {
    try {
      const rows = await loadGiftRecordsByRange(mid, range);
      for (const r of rows) {
        if (Number(r.giftId) === castleGiftId) castleCount += Number(r.num) || 0;
      }
    } catch {
      /* 读取失败保持 0 */
    }
  }
  return { opened, profit, castleCount };
}

/** 空数据（服务未启动/未开启时下发给画布，避免残留上一次账号数据）。 */
export const EMPTY_INFO_PANEL_DATA: InfoPanelData = {
  ranks: [],
  pk: null,
  blindBox: null,
  overtime: null,
  pkLive: null,
};
