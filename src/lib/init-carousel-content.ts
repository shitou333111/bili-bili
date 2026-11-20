/**
 * 数据初始化遮罩（消费记录 / 流水记录）的专属轮播内容。
 *
 * 每个加载阶段有独立的图片与文案，可直接在本文件里替换：
 *  - 图片放在 public/init_slides/，按文件名替换即可（pay-1.jpg / stream-1.jpg …）；
 *  - 文案、强调色、顺序都改下方对应的数组，无需改动组件代码。
 */

export interface InitCarouselSlide {
  text: string;
  image: string;
  color: string;
}

/** 霓虹色板（与官网/登录页一致，无绿色：浅色背景上易看不清） */
const NEON = [
  "#ff2d78", // 霓虹粉
  "#00d9ff", // 霓虹青
  "#b967ff", // 霓虹紫
  "#ff5722", // 橙红
  "#ff9800", // 橙
  "#ff3d81", // 荧光红
  "#7c4dff", // 蓝紫
];

/** 阶段一「消费记录」：抓取送礼/消费记录时展示 */
export const PAY_RECORD_SLIDES: InitCarouselSlide[] = [
  {
    text: "检查数据是否完整，消费记录最长1年",
    image: "/init_slides/pay-1.jpg",
    color: NEON[0],
  },
  {
    text: "盲盒最久2月，更久找爱播用本软件查",
    image: "/init_slides/pay-2.jpg",
    color: NEON[1],
  },
  {
    text: "若数据不全，点击帮助页面的重建数据",
    image: "/init_slides/pay-3.jpg",
    color: NEON[2],
  },
];

/** 阶段二「流水记录」：抓取直播间礼物流水时展示 */
export const STREAM_RECORD_SLIDES: InitCarouselSlide[] = [
  {
    text: "主播流水很耗时，保持前台，耐心等待",
    image: "/init_slides/stream-1.jpg",
    color: NEON[0],
  },
  {
    text: "检查数据是否完整，流水记录最长3年",
    image: "/init_slides/stream-2.jpg",
    color: NEON[1],
  },
  {
    text: "记录下载只到昨天，今天要开软件记录",
    image: "/init_slides/stream-3.jpg",
    color: NEON[2],
  },
  {
    text: "打开盲盒查询按钮，弹幕查询盲盒盈亏",
    image: "/init_slides/stream-4.jpg",
    color: NEON[3],
  },
  {
    text: "直播间展示功能，需电脑版配合直播姬",
    image: "/init_slides/stream-5.jpg",
    color: NEON[4],
  },
  {
    text: "若数据不全，点击帮助页面的重建数据",
    image: "/init_slides/stream-6.jpg",
    color: NEON[5],
  },
];
