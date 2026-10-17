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
export type LayoutElementId =
  | "gift"
  | "giftSeparate"
  | "giftEffect"
  | "entry"
  | "anime"
  | "banner"
  | "giftFlip";

/** 画布元素布局：每个元素按朝向各存一套位置（横屏/竖屏独立） */
export interface DisplayLayout {
  gift: Record<ScreenOrientation, MovableRect>;
  /** 单独条（突出显示专用礼物条，与常规礼物条并存；仅"单独条"开关开启时使用） */
  giftSeparate: Record<ScreenOrientation, MovableRect>;
  giftEffect: Record<ScreenOrientation, MovableRect>;
  entry: Record<ScreenOrientation, MovableRect>;
  anime: Record<ScreenOrientation, MovableRect>;
  banner: Record<ScreenOrientation, MovableRect>;
  /** 礼物翻卡/礼物抽奖：3D 轮转卡片面板 */
  giftFlip: Record<ScreenOrientation, MovableRect>;
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
  giftSeparate: {
    // 单独条（突出显示专用礼物条）：默认放在常规礼物条正下方（上边距隔开一个条厚 100px + 16px），
    // 避免与常规条重叠；拖动/缩放后按保存坐标自由摆放（横竖屏各一套，与常规条同样记住位置）。
    landscape: { x: 60, y: 176, scale: 1 },
    portrait: { x: 70, y: 186, scale: 1 },
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
    // 默认：画布正上方、距上边界 30px。默认布局（x=0/y=30/scale=1 哨兵）下渲染时按按钮
    // 实测宽度动态居中（x=(画布宽-按钮宽×scale)/2），文字多少都自动调整；用户一旦拖动/缩放
    // 即保存绝对坐标，此后按保存的 x/y/scale 自由摆放（不再强制居中）。
    landscape: { x: 0, y: 30, scale: 1 },
    portrait: { x: 0, y: 30, scale: 1 },
  },
  giftFlip: {
    // 礼物翻卡/抽奖：默认置于画布中部偏上、水平居中；舞台基准尺寸 900×560，加粗横幅的外边距
    landscape: { x: Math.round((1920 - 900) / 2), y: 210, scale: 1 },
    portrait: { x: Math.round((1080 - 900) / 2), y: 520, scale: 1 },
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

/** 礼物翻卡/抽奖 · 单个选项：文字 + 可选图片（data URL） */
export interface GiftFlipOption {
  /** 选项文字（最多 10 个字） */
  text: string;
  /** 该选项的图片（data URL；空 = 该卡片使用纯色底） */
  image: string;
}

/** 选项数量上下限（面板据此限制增删） */
export const GIFT_FLIP_MIN_OPTIONS = 4;
export const GIFT_FLIP_MAX_OPTIONS = 20;
/** 选项文字最大字数 */
export const GIFT_FLIP_MAX_TEXT_LEN = 10;

/** 礼物翻卡动画分镜阶段（画布/面板预览共用；idle = 待机 3D 轮转）。
 *  spin：旋转到目标卡 → flash：目标卡闪烁 → pop：卡牌放大飘到画布中心（露卡背）
 *  → flip：翻面揭晓 → hold：停留展示 → restore：收起复位。 */
export type GiftFlipPhase = "idle" | "spin" | "flash" | "pop" | "flip" | "hold" | "restore";

/** 默认选项模板（6 项，含 3 奖励 3 惩罚，主播可在面板中自由改写/增删） */
export const DEFAULT_GIFT_FLIP_OPTIONS: GiftFlipOption[] = [
  { text: "奖励一", image: "" },
  { text: "奖励二", image: "" },
  { text: "奖励三", image: "" },
  { text: "惩罚一", image: "" },
  { text: "惩罚二", image: "" },
  { text: "惩罚三", image: "" },
];

/** 礼物翻卡/礼物抽奖模块配置 */
export interface GiftFlipConfig {
  /** 模块总开关：关闭后画布不显示轮盘，收到触发礼物也不翻卡 */
  enabled: boolean;
  /** 触发礼物 gift_id（0 = 未设置） */
  giftId: number;
  /** 触发礼物名称 */
  giftName: string;
  /** 触发礼物图标 URL（选中后替换轮盘中心的图片） */
  giftImg: string;
  /** 触发所需礼物数量（每位粉丝独立累计，累计满一次即为其触发一张翻卡） */
  giftCount: number;
  /** 选项列表（GIFT_FLIP_MIN_OPTIONS ~ GIFT_FLIP_MAX_OPTIONS 项） */
  options: GiftFlipOption[];
  /** 待机（未触发）时是否在卡片上显示选项文字：开启=文字叠加在图片/纯色卡片上；
   *  关闭=待机只显示图片/纯色卡片（翻牌揭晓时无论开关都会显示文字）。默认关闭。 */
  showText: boolean;
  /** 图片与选项固定：开启=图片/纯色卡与文字选项一一对应且每局不变；
   *  关闭=每局随机洗牌打乱图片与选项的对应关系。默认开启。 */
  lockMapping: boolean;
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

/** 入场提示配色：badge 底色渐变（起点→终点）与粒子取色共用同一组色（粒子颜色即 badge 像素色），
 *  昵称为单一颜色（默认纯白）。三色均为 #rrggbb。 */
export interface EntryColors {
  /** badge / 粒子渐变起始色（左端） */
  start: string;
  /** badge / 粒子渐变结束色（右端） */
  end: string;
  /** 昵称字体颜色（单一颜色） */
  name: string;
}

/** 默认入场配色：与改造前的红橙黄渐变完全一致（hsl(0,90%,60%)→hsl(60,90%,60%)，
 *  两端等亮度、中点在 sRGB 线性混合下恰为 hsl(30,90%,60%)），昵称默认纯白。 */
export const DEFAULT_ENTRY_COLORS: EntryColors = {
  start: "#f53d3d",
  end: "#f5f53d",
  name: "#ffffff",
};

/** 合法 #rrggbb / #rgb 色值判定（配置容错与拾色板共用） */
export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());
}

/** 入场动画 · 整体透明度档位：「不透明」= 视频完全不透明；轻 / 中 / 重逐级更透明（重 = 透出下层直播画面最多）。
 *  除「不透明」外透明度按椭圆区域径向分布：中心最实、越往周边越透明，替代旧的「视频边缘羽化」。 */
export type AnimeOpacity = "opaque" | "light" | "medium" | "heavy";

/** 各透明度档位对应的 alpha：center = 中心（椭圆圆心）不透明度，edge = 周边（四角）不透明度。
 *  中间按椭圆径向线性插值，故越往周边 alpha 越小、越透明；「不透明」两值均为 1（整幅不做透明）。 */
export const ANIME_OPACITY_ALPHA: Record<AnimeOpacity, { center: number; edge: number }> = {
  opaque: { center: 1, edge: 1 },
  light: { center: 1, edge: 0.95 },
  medium: { center: 0.95, edge: 0.9 },
  heavy: { center: 0.9, edge: 0.85 },
};

/** 合法透明度档位判定（配置容错与画布消息共用；档位集合只在 ANIME_OPACITY_ALPHA 定义一处） */
export function isAnimeOpacity(v: unknown): v is AnimeOpacity {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(ANIME_OPACITY_ALPHA, v);
}

/** 礼物展示条宽度档位：短 = 3 个礼物位（默认）/ 中 = 4 / 长 = 5。仅改变条长（沿滚动轴），
 *  条厚（垂直方向）不变，整体缩放仍在画布中调整。 */
export type GiftBarWidth = "short" | "medium" | "long";

/** 各宽度档位对应的礼物位数（沿滚动轴可容纳的图标数） */
export const GIFT_BAR_SLOTS: Record<GiftBarWidth, number> = {
  short: 3,
  medium: 4,
  long: 5,
};

/** 合法宽度档位判定 */
export function isGiftBarWidth(v: unknown): v is GiftBarWidth {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(GIFT_BAR_SLOTS, v);
}

/** 醒目留言（SC）按价位对应的圆形纯色背景色。阈值单位 = 电池。
 *  低于 500 / 500-999 / 1000-4999 / 5000-9999 / 10000-19999 / >=20000。 */
export function scBackgroundColor(battery: number): string {
  if (battery >= 20000) return "#AC1933";
  if (battery >= 10000) return "#E54D4C";
  if (battery >= 5000) return "#E09345";
  if (battery >= 1000) return "#E3B52B";
  if (battery >= 500) return "#447C9D";
  return "#2960B2";
}

/** 展示模块整体配置（持久化到 <dataDir>/uid_<mid>/display-config.json，按账号分开） */
export interface DisplayConfig {
  /** 画布朝向（横屏 1920x1080 / 竖屏 1080x1920） */
  screenOrientation: ScreenOrientation;
  /** 模块1 · 入场提示 开关 */
  entry: boolean;
  /** 模块1 · 入场提示粒子聚散方式（面板开关，默认"center"=中心聚散） */
  entryParticleMode: EntryParticleMode;
  /** 模块1 · 入场提示配色（badge 底色渐变 + 粒子取色同源 + 昵称单色；面板「设置颜色」模态框编辑） */
  entryColors: EntryColors;
  /** 模块2 · 收到的礼物展示 开关 */
  gift: boolean;
  /** 模块3 · 高级用户自定义入场动画 开关 */
  anime: boolean;
  /** 模块4 · 礼物特效（收到带特效的礼物时在画布播放） */
  giftEffect: GiftEffectConfig;
  /** 模块5 · 横幅（画布顶部横幅按钮 + 撒花庆祝，放在入场动画模块下面） */
  banner: BannerConfig;
  /** 模块6 · 礼物翻卡/礼物抽奖（3D 轮转卡片，送礼达标触发翻卡） */
  giftFlip: GiftFlipConfig;
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
  /** 入场动画整体透明度档位（持久化的是档位字符串而非 alpha 数值，重开后按档位还原；
   *  除「不透明」外按椭圆区域径向分布，中心最实、越往周边越透明，可透出下层直播画面；
   *  闭幕黑幕形状不变、整体均匀套用该档位的中心不透明度） */
  animeOpacity: AnimeOpacity;
  /** 礼物单价阈值（元），单价 > 该值的礼物才显示 */
  giftPriceThreshold: number;
  /** 礼物展示条方向：横条（礼物从右到左滚动）/ 竖条（礼物从下到上滚动） */
  giftBarOrientation: "horizontal" | "vertical";
  /** 礼物展示条宽度档位（短 3 位 / 中 4 位 / 长 5 位；条厚不变，整体缩放仍在画布中调整） */
  giftBarWidth: GiftBarWidth;
  /** 单独条开关：开启后突出显示的礼物在画布上单独占一条（与常规礼物条并存），
   *  关闭时突出显示仍替换常规礼物条内容。 */
  giftSeparateBar: boolean;
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
  /** 礼物翻卡/抽奖模块开关（从 DisplayConfig.giftFlip.enabled 派生） */
  giftFlip: boolean;
};

/** 默认展示配置 */
export const DEFAULT_DISPLAY_CONFIG: DisplayConfig = {
  screenOrientation: "landscape",
  // 各模块开关默认状态：入场提示 / 收到的礼物展示 / 入场动画 / 礼物特效 默认关闭，
  // 盲盒盈亏弹幕查询默认开启，弹幕互动默认关闭
  entry: false,
  entryParticleMode: "center", // 默认「中心聚散」（自研四面八方聚散）
  entryColors: DEFAULT_ENTRY_COLORS, // 默认红橙黄渐变 + 白色昵称（与改造前一致）
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
  giftFlip: {
    enabled: false,
    giftId: 0,
    giftName: "",
    giftImg: "",
    giftCount: 1,
    options: DEFAULT_GIFT_FLIP_OPTIONS,
    showText: false,
    lockMapping: true,
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
  animeOpacity: "light", // 整体透明度默认「轻」
  giftPriceThreshold: 100, // 电池（默认 100 电池）
  giftBarOrientation: "horizontal", // 默认横条（礼物从右到左滚动）
  giftBarWidth: "medium", // 默认中（4 个礼物位）
  giftSeparateBar: false, // 默认关闭：突出显示替换常规礼物条内容
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

/** 礼物展示项中的送礼粉丝 */
export interface DisplayGiftFan {
  uid: number;
  uname: string;
  /** 头像 URL（可能为空） */
  face: string;
  /** 该粉丝近一周送该礼物的数量 */
  count: number;
}

/** 礼物展示项 */
export interface DisplayGiftItem {
  giftId: number;
  giftName: string;
  /** 单价（电池） */
  price: number;
  /** 近一周累计数量 */
  count: number;
  /** 礼物图标 URL */
  img: string;
  /** 醒目留言（SC）：存在时表示该项为 SC（无图标），值为该条 SC 的电池数，
   *  礼物位以圆形纯色背景 + "SC"/电池数 两行文字呈现（背景色按价位取 scBackgroundColor）。 */
  scBattery?: number;
  /** 送礼粉丝列表（按数量降序；可能为空/缺失 = 旧数据） */
  fans?: DisplayGiftFan[];
}

/** 新到礼物标记：真实收到一个达标礼物时随 gift 事件附带（配置变更重发清单不带此字段，
 *  不触发动画）。画布据此播放"礼物图标从画布中心飘入礼物条并被吸收"的动画。 */
export interface DisplayGiftArrival {
  giftId: number;
  giftName: string;
  /** 礼物图标 URL（空则不触发飘入动画） */
  img: string;
  /** 本次送礼的礼物单价（电池） */
  priceBattery: number;
}

/** 礼物突出显示选择：giftId → 选中展示的 uid 列表（顺序 = 循环顺序） */
export type GiftHighlight = Record<number, number[]>;

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
  | { type: "gift"; gifts: DisplayGiftItem[]; arrived?: DisplayGiftArrival }
  | {
      /** 礼物翻卡：触发一次翻卡动画，选中 optionIndex（选项配置由 init/配置消息下发） */
      type: "giftFlip";
      /** 本次翻卡的序号（画布回执 giftFlipDone 时回传，避免多端重复回执被重复记账） */
      seq: number;
      /** 本次翻卡归属的粉丝（送礼达标的观众） */
      fan: { uid: number; uname: string; face: string };
      /** 命中的选项下标（0 起） */
      optionIndex: number;
    };