/**
 * 官网（/landing）与登录页共用的宣传内容（单一来源）。
 *
 * 图片放在 public/landing_slides/，按 1.jpg、2.jpg… 与 LANDING_SLOGANS 的顺序一一对应。
 * 每次执行 npm run build / build:tauri 时：Next 会把 public 下的图片整体复制进产物
 * （Web 部署上传静态资源；Tauri 打包进客户端安装包），同时本文件被重新编译成 JS，
 * 因此新增/替换图片、修改文案后重新构建即可同步更新，登录页无需再写一份。
 */

export const APP_NAME = "B瓜";
export const APP_TAGLINE = "B站直播数据分析工具";
export const APP_DESCRIPTION =
  "B瓜 是专为 Bilibili 直播打造的个人消费数据分析工具。扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏，支持 Windows / Android / iOS 客户端使用。";

/** 一句宣传语配一张配图（编号即句子顺序，严格 1,2,3…） */
export const LANDING_SLOGANS = [
  "想回顾你和爱播的甜蜜送礼瞬间？",
  "与爱播闹崩，看花了多少冤枉钱？",
  "想看给哪些主播，分别刷了多少？",
  "想看看盲盒盈亏，出了多少个堡？",
  "想看合成活动亏了多少赚了多少？",
  "抢到的最香，想看中了多少天选？",
  "爱播到底是哪位？时间会给出答案",
  "主播想看每个月都收了什么礼物？",
  "被粉丝骚扰？列清单不惯他臭毛病",
  "自己直播间白不白？城堡说了才算",
  "大礼物忘了录屏，想补截图录屏？",
  "陪伴很重要，常来的粉丝是哪些？",
  "想解锁所有礼物，体验神豪视角？",
  "新出的合成活动，想上手玩一玩？",
  "大哥大姐们想批量清理无关粉丝？",
  "清理粉丝牌，被迫单个强制等待？",
  "守医药费，想知道有没有掉地上？",
  "发医药费，不想再统计在哪个群？",
  "爱播没开播，新活动找不到入口？",
  "礼物展示/入场动画，直播姬使用",
  "新活动盲盒/合成素材，主播拉票"
];

/** 霓虹色板：每张独立取色循环（无绿色，绿色在浅色背景上易看不清） */
export const LANDING_NEON = [
  "#ff2d78", // 霓虹粉
  "#00d9ff", // 霓虹青
  "#b967ff", // 霓虹紫
  "#ff5722", // 橙红
  "#ff9800", // 橙
  "#ff3d81", // 荧光红
  "#7c4dff", // 蓝紫
];

export interface LandingSlide {
  text: string;
  image: string;
  color: string;
}

/** 轮播数据：文案 + 配图 + 强调色（官网、登录页共用） */
export const LANDING_SLIDES: LandingSlide[] = LANDING_SLOGANS.map((text, i) => ({
  text,
  image: `/landing_slides/${i + 1}.jpg`,
  color: LANDING_NEON[i % LANDING_NEON.length],
}));
