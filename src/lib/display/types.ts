/**
 * 展示模块 —— 共享类型定义。
 *
 * 展示模块 = 主窗口（弹幕监听 + 配置持久化） + 展示画布页（/display，直播姬「浏览器源」透明叠加）。
 * 主窗口监听自己直播间弹幕 → 过滤 → 组装 payload → WS 广播；画布页 listen 事件并渲染。
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

/** 画布元素可移动矩形（左上角坐标 + 等比缩放系数） */
export interface MovableRect {
  /** 元素左上角 X（画布坐标） */
  x: number;
  /** 元素左上角 Y（画布坐标） */
  y: number;
  /** 缩放系数（1=原始大小） */
  scale: number;
}

/** 可编辑布局的元素 ID */
export type LayoutElementId = "gift" | "giftEffect" | "entry" | "anime" | "banner";

/** 画布元素布局：每个元素按朝向各存一套位置（横屏/竖屏独立） */
export interface DisplayLayout {
  gift: Record<ScreenOrientation, MovableRect>;
  giftEffect: Record<ScreenOrientation, MovableRect>;
  entry: Record<ScreenOrientation, MovableRect>;
  anime: Record<ScreenOrientation, MovableRect>;
  banner: Record<ScreenOrientation, MovableRect>;
}

/** 各元素默认位置（横竖屏各一套；首次切入并尚未保存布局时使用）。
 *  anime 默认 {0,0,1} 表示"尚未自定义"：渲染时元素尺寸贴合视频画面（按宽高比在画布内
 *  等比缩放）并在画布中居中；一旦拖动/缩放即保存为绝对坐标（左上角 + 缩放系数）。 */
export const DEFAULT_DISPLAY_LAYOUT: DisplayLayout = {
  gift: {
    // 恢复迁移前（960 坐标系）的默认位置：左上角，不水平居中（较此前默认右移、下移各 10px）
    landscape: { x: 60, y: 60, scale: 1 },
    portrait: { x: 70, y: 70, scale: 1 },
  },
  giftEffect: {
    // {0,0,1} 表示"尚未自定义"：渲染时按特效实际尺寸动态摆放（横屏宽 1/4、距下边界 10%，
    // 竖屏占满宽、距下边界 1/5，均水平居中）；一旦拖动/缩放即保存为绝对坐标。
    landscape: { x: 0, y: 0, scale: 1 },
    portrait: { x: 0, y: 0, scale: 1 },
  },
  entry: {
    // 水平居中（入场提示实际宽度 ≈ 头像56 + gap24 + 昵称28px×字数 + padding64，4字昵称约262px，
    // 按 scale 后的视觉宽度居中；旧基准 320px 偏大导致默认位置偏左），距上边界：横屏 300px、竖屏 440px；
    // 默认大小：横屏 1.8 倍、竖屏 1.6 倍
    landscape: { x: Math.round((1920 - 262 * 1.8) / 2), y: 300, scale: 1.8 },
    portrait: { x: Math.round((1080 - 262 * 1.6) / 2), y: 440, scale: 1.6 },
  },
  anime: {
    landscape: { x: 0, y: 0, scale: 1 },
    portrait: { x: 0, y: 0, scale: 1 },
  },
  banner: {
    // 默认：画布正上方、距上边界 30px。水平方向不持久化：渲染时永远按按钮实测宽度
    // 动态居中（x=(画布宽-按钮宽×scale)/2），文字多少都自动调整；仅 y / scale 可拖动保存。
    landscape: { x: 0, y: 30, scale: 1 },
    portrait: { x: 0, y: 30, scale: 1 },
  },
};

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

/** 礼物特效模块配置 */
export interface GiftEffectConfig {
  /** 模块总开关：关闭后不播放任何礼物特效 */
  enabled: boolean;
  /** 礼物关键字特效开关：开启后弹幕精确匹配礼物名称也播放对应特效 */
  keyword: boolean;
}

/** 横幅模块配置（画布顶部彩虹胶囊按钮 + 面板触发撒花庆祝） */
export interface BannerConfig {
  /** 模块总开关：关闭后画布不显示横幅按钮、撒花特效也不播放 */
  enabled: boolean;
  /** 横幅按钮文字（最多 30 个字；输入中不实时同步，失焦才更新到画布） */
  text: string;
}

/** 入场冷却时长选项（B 站对同一用户的重复入场本身有去重/冷却，"bilibili" = 本地不额外冷却） */
export type EntryCooldownOption = "bilibili" | "30min" | "1h" | "10h";

/** 各冷却选项对应的毫秒数（bilibili = 0：不设本地冷却，完全跟随 B 站自身的入场去重） */
export const ENTRY_COOLDOWN_MS: Record<EntryCooldownOption, number> = {
  bilibili: 0,
  "30min": 30 * 60_000,
  "1h": 60 * 60_000,
  "10h": 10 * 60 * 60_000,
};

/** 入场提示 · 粒子聚散方式："center" = 自研「四面八方（中心）聚散」；"lr" = 原库实现（左右聚散） */
export type EntryParticleMode = "center" | "lr";

/** 展示模块整体配置（持久化到 <dataDir>/uid_<mid>/display-config.json，按账号分开） */
export interface DisplayConfig {
  /** 画布朝向（横屏 1920x1080 / 竖屏 1080x1920） */
  screenOrientation: ScreenOrientation;
  /** 模块1 · 入场提示 开关 */
  entry: boolean;
  /** 模块1 · 入场提示粒子聚散方式（面板开关，默认"center"=中心聚散） */
  entryParticleMode: EntryParticleMode;
  /** 模块2 · 收到的礼物展示 开关 */
  gift: boolean;
  /** 模块3 · 高级用户自定义入场动画 开关 */
  anime: boolean;
  /** 模块4 · 礼物特效（收到带特效的礼物时在画布播放） */
  giftEffect: GiftEffectConfig;
  /** 模块5 · 横幅（画布顶部横幅按钮 + 撒花庆祝，放在入场动画模块下面） */
  banner: BannerConfig;
  /** 入场筛选 */
  entryFilter: EntryFilter;
  /** 入场冷却时长（同一用户距上次触发不足该间隔时不再触发入场特效） */
  entryCooldown: EntryCooldownOption;
  /** 各用户上次触发入场特效的时间戳（uid → ms，本地记录，随本配置文件持久化） */
  entryLastSeen: Record<string, number>;
  /** 入场动画冷却时长（与入场提示同款选项，但独立判定、独立记录） */
  animeCooldown: EntryCooldownOption;
  /** 各用户上次触发动画的时间戳（uid → ms，本地记录，随本配置文件持久化） */
  animeLastSeen: Record<string, number>;
  /** 入场动画视频左右边缘羽化强度（0=关闭，1-40 = 每侧透明渐变宽度百分比） */
  animeFeatherH: number;
  /** 入场动画视频上下边缘羽化强度（0=关闭，1-40 = 每侧透明渐变宽度百分比） */
  animeFeatherV: number;
  /** 礼物单价阈值（元），单价 > 该值的礼物才显示 */
  giftPriceThreshold: number;
  /** 礼物展示条方向：横条（礼物从右到左滚动）/ 竖条（礼物从下到上滚动） */
  giftBarOrientation: "horizontal" | "vertical";
  /** 高级用户入场动画名单 */
  animeList: EntryAnimeConfig[];
  /** 弹幕互动 */
  danmaku: DanmakuInteractionConfig;
  /** 画布元素布局（gift/entry 各按朝向一套，主进程持久化 + WS 下发） */
  layout: DisplayLayout;
  /** 盲盒盈亏 · 弹幕查询 */
  blindBoxQuery: BlindBoxQueryConfig;
}

/** 画布各模块显示开关（主进程随配置变化实时广播，浏览器源据此即时显隐元素）。
 *  已无独立"总开关"：master 由各画布显示子模块派生（见 config.ts displayMaster），
 *  master=false 时浏览器源整体不渲染任何内容（显示空白）。 */
export type DisplayFlags = {
  /** 派生总开关：任一画布显示子模块（礼物展示/礼物特效/入场提示/入场动画/横幅）开启即为 true */
  master: boolean;
  entry: boolean;
  gift: boolean;
  anime: boolean;
  /** 礼物特效模块开关（从 DisplayConfig.giftEffect.enabled 派生） */
  giftEffect: boolean;
  /** 横幅模块开关（从 DisplayConfig.banner.enabled 派生） */
  banner: boolean;
};

/** 默认展示配置 */
export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  screenOrientation: "landscape",
  // 各模块开关默认状态：入场提示 / 收到的礼物展示 / 入场动画 / 礼物特效 默认关闭，
  // 盲盒盈亏弹幕查询默认开启，弹幕互动默认关闭
  entry: false,
  entryParticleMode: "center", // 默认「中心聚散」（自研四面八方聚散）
  gift: false,
  anime: false,
  giftEffect: {
    enabled: false,
    keyword: false,
  },
  banner: {
    enabled: false,
    text: "欢迎来到直播间",
  },
  entryFilter: {
    zongdu: false,
    tidu: false,
    jianzhang: false,
    medalLevelThreshold: 31,
  },
  entryCooldown: "bilibili",
  entryLastSeen: {},
  animeCooldown: "bilibili",
  animeLastSeen: {},
  animeFeatherH: 0, // 左右边缘羽化默认关闭
  animeFeatherV: 5, // 上下边缘羽化默认强度（0=关闭）
  giftPriceThreshold: 100, // 电池（默认 100 电池）
  giftBarOrientation: "horizontal", // 默认横条（礼物从右到左滚动）
  animeList: [],
  layout: DEFAULT_DISPLAY_LAYOUT,
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

/** 礼物特效配套 JSON 配置（B站特效视频内含 rgbFrame 画面区 + aFrame 灰度透明区，
 *  由画布侧按 AlphaVideoPlayer 的处理方式合成 alpha 通道）。字段与模拟器 EffectConfig 一致。 */
export interface GiftEffectFrameConfig {
  info: {
    /** 透明区矩形 [x, y, w, h]（取 R 通道作为 alpha） */
    aFrame: [number, number, number, number];
    /** 画面区矩形 [x, y, w, h] */
    rgbFrame: [number, number, number, number];
    f: number;
    fps: number;
    videoW: number;
    videoH: number;
    w: number;
    h: number;
    scale: number;
    align: number;
    custom: number;
    v: number;
  };
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
  | {
      type: "giftEffect";
      giftId: number;
      giftName: string;
      /** 特效视频地址（B站 web_mp4 直链） */
      videoSrc: string;
      /** 配套 JSON 配置（缺失时退化为整段绘制） */
      config: GiftEffectFrameConfig | null;
    }
  | { type: "gift"; gifts: DisplayGiftItem[] };