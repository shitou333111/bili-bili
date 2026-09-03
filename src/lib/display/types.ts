/**
 * 展示模块 —— 共享类型定义。
 *
 * 展示模块 = 主窗口（弹幕监听 + 配置持久化） + 独立展示窗口（1080x720 画布，直播姬窗口捕捉）。
 * 主窗口监听自己直播间弹幕 → 过滤 → 组装 payload → emitTo("display", ...)；
 * 展示窗口 listen 事件并渲染。
 */

/** 大航海类型（B站 guardType：1=总督 2=提督 3=舰长 0=无） */
export type GuardType = 0 | 1 | 2 | 3;

/** 入场筛选条件 */
export interface EntryFilter {
  /** 是否放行"总督" */
  zongdu: boolean;
  /** 是否放行"提督" */
  tidu: boolean;
  /** 是否放行"舰长" */
  jianzhang: boolean;
  /** 粉丝灯牌等级阈值（>= 该值放行；0 = 不限制） */
  medalLevelThreshold: number;
}

/** 展示画布朝向 */
export type ScreenOrientation = "landscape" | "portrait";

/** 高级用户自定义入场动画配置（逐用户一份） */
export interface EntryAnimeConfig {
  /** 用户 UID */
  uid: number;
  /** 用户昵称 */
  uname: string;
  /** 用户头像 */
  face: string;
  /** 横屏入场视频文件绝对路径（空 = 未选，回退用竖屏） */
  videoLandscape: string;
  /** 竖屏入场视频文件绝对路径（空 = 未选，回退用横屏） */
  videoPortrait: string;
  /** 是否启用该用户的入场动画 */
  enabled: boolean;
  /** 横屏播放片段：开始秒数（0=从头；与 design 均为 0 时播放整段） */
  landscapeStartSec: number;
  /** 横屏播放片段：结束秒数（0=播到末尾） */
  landscapeEndSec: number;
  /** 竖屏播放片段：开始秒数 */
  portraitStartSec: number;
  /** 竖屏播放片段：结束秒数 */
  portraitEndSec: number;
}

/** 弹幕互动配置 */
export interface DanmakuInteractionConfig {
  /** 模块总开关：关闭后不执行弹幕发送 */
  enabled: boolean;
  /** 弹幕间发送间隔（秒） */
  intervalSec: number;
  /** 多行弹幕文本：每行（或连续多个换行）算作一条弹幕 */
  text: string;
}

/** 盲盒盈亏 · 弹幕查询配置 */
export interface BlindBoxQueryConfig {
  /** 总开关：关闭后不识别查询弹幕、不自动回复 */
  enabled: boolean;
}

/** 展示模块整体配置（持久化到 .data/display-config.json） */
export interface DisplayConfig {
  /** 总开关：开启才创建展示窗口并启动监听 */
  master: boolean;
  /** 画布朝向（横屏 960x540 / 竖屏 540x960） */
  screenOrientation: ScreenOrientation;
  /** 模块1 · 入场提示 开关 */
  entry: boolean;
  /** 模块2 · 礼物展示 开关 */
  gift: boolean;
  /** 模块3 · 高级用户自定义入场动画 开关 */
  anime: boolean;
  /** 入场筛选 */
  entryFilter: EntryFilter;
  /** 礼物单价阈值（元），单价 > 该值的礼物才显示 */
  giftPriceThreshold: number;
  /** 高级用户入场动画名单 */
  animeList: EntryAnimeConfig[];
  /** 弹幕互动 */
  danmaku: DanmakuInteractionConfig;
  /** 盲盒盈亏 · 弹幕查询 */
  blindBoxQuery: BlindBoxQueryConfig;
}

/** 默认展示配置 */
export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  master: false,
  screenOrientation: "landscape",
  entry: true,
  gift: true,
  anime: false,
  entryFilter: {
    zongdu: false,
    tidu: false,
    jianzhang: false,
    medalLevelThreshold: 0,
  },
  giftPriceThreshold: 10, // 电池（默认约 1 元）
  animeList: [],
  danmaku: {
    enabled: false,
    intervalSec: 300, // 默认 5 分钟
    text: "",
  },
  blindBoxQuery: {
    enabled: true, // 默认开启：开播即识别查询弹幕并自动回复
  },
};

/** 入场事件（达标用户进入直播间） */
export interface DisplayEntryPayload {
  uid: number;
  uname: string;
  face: string;
  guardType: GuardType;
  /** 当前佩戴的粉丝灯牌等级（无灯牌为 0） */
  medalLevel: number;
}

/** 礼物展示项 */
export interface DisplayGiftItem {
  giftId: number;
  giftName: string;
  /** 单价（电池） */
  price: number;
  /** 今日累计数量 */
  count: number;
  /** 礼物图标 URL */
  img: string;
}

/** 主窗口 → 展示窗口 事件 payload（channel: "display-event"） */
export type DisplayEvent =
  | { type: "entry"; user: DisplayEntryPayload }
  | {
      type: "anime";
      user: { uid: number; uname: string; face: string };
      videoSrc: string;
      /** 播放起始秒数（用于媒体片段；0=从头） */
      startSec: number;
      /** 播放结束秒数（0=播到末尾；配合 startSec 实现选段播放） */
      endSec: number;
    }
  | { type: "gift"; gifts: DisplayGiftItem[] }
  /** 测试模式开关：开启后三个模块元素常驻并循环播放（供布局调整） */
  | { type: "test"; active: boolean };

/** 展示窗口事件频道名 */
export const DISPLAY_EVENT_CHANNEL = "display-event";