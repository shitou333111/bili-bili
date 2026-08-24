"use client";

import { Swiper, SwiperSlide } from "swiper/react";
import { Autoplay } from "swiper/modules";
import type { Swiper as SwiperType } from "swiper";
import "swiper/css";

// ==================== 宣传语轮播（Swiper·文字在上·图片在下·仅文字霓虹光晕） ====================
// 一句宣传语配一张配图（public/landing_slides/N.jpg，编号即句子顺序，严格 1,2,3…）。
// 每张图片与其文字是一个独立 slide（slide 内文字在上、图片在下），仅文字带霓虹光晕，图片无光晕。
// 采用 Swiper slides-per-view 自适应：手机 1 张，平板 2 张，宽屏 3 张；
// 整页翻动（slidesPerGroup = 每屏张数），每批停留 = 单张 5s × 每屏张数，循环自动播放。
const SLOGANS = [
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
  "大礼物忘了录屏，想补礼物截图？",
  "陪伴很重要，常来的粉丝是哪些？",
  "想解锁所有礼物，体验神豪视角？",
  "新出的合成活动，想上手玩一玩？",
  "大哥大姐们想批量清理无关粉丝？",
  "清理粉丝牌，被迫单个强制等待？",
  "守医药费，想知道有没有掉地上？",
  "发医药费，不想再统计在哪个群？",
  "爱播没开播，新活动找不到入口？",
];


// 霓虹色板：每张独立取色循环（无绿色，绿色在浅色背景上易看不清）
const NEON = [
  "#ff2d78", // 霓虹粉
  "#00d9ff", // 霓虹青
  "#b967ff", // 霓虹紫
  "#ff5722", // 橙红
  "#ff9800", // 橙
  "#ff3d81", // 荧光红
  "#7c4dff", // 蓝紫
];

const PER_SLIDE_MS = 8000; // 单张基础停留时长
const SPEED_MS = 900; // 划动动画时长（更长更顺滑）

/** 按当前每屏张数设置自动播放停留：单张 × 每屏张数 */
function applyAutoplayDelay(swiper: SwiperType) {
  const perView = Number(swiper.params.slidesPerView) || 1;
  if (swiper.params.autoplay) swiper.params.autoplay.delay = PER_SLIDE_MS * perView;
}

export default function SloganRotator() {
  return (
    <div className="mt-8 w-full sm:mt-12">
      <Swiper
        modules={[Autoplay]}
        speed={SPEED_MS}
        slidesPerView={1}
        slidesPerGroup={1}
        spaceBetween={16}
        loop
        autoplay={{ delay: PER_SLIDE_MS, disableOnInteraction: false }}
        onInit={applyAutoplayDelay}
        onBreakpoint={(s) => {
          applyAutoplayDelay(s);
          s.autoplay.stop();
          s.autoplay.start();
        }}
        breakpoints={{
          // 平板 2 张（整页翻动 2 张）
          768: { slidesPerView: 2, slidesPerGroup: 2, spaceBetween: 32 },
          // 宽屏 3 张（整页翻动 3 张）
          1280: { slidesPerView: 3, slidesPerGroup: 3, spaceBetween: 40 },
        }}
        className="w-full [&_.swiper-wrapper]:items-stretch"
      >
        {SLOGANS.map((text, i) => {
          const color = NEON[i % NEON.length]; // 每张独立取色
          return (
            <SwiperSlide key={i} className="!h-auto">
              <div className="relative flex h-full w-full flex-col items-center px-2 pt-6 pb-4">
                {/* 文字在上 */}
                <span
                  className="flex min-h-10 w-full items-start justify-center px-1 text-center text-[17px] font-semibold leading-snug sm:text-[17px]"
                  style={{ color }}
                >
                  {text}
                </span>
                {/* 图片在下：宽度占满 slide、高度按纵横比自然延伸 */}
                <img
                  src={`/landing_slides/${i + 1}.jpg`}
                  alt=""
                  loading="lazy"
                  className="w-full object-contain"
                />
              </div>
            </SwiperSlide>
          );
        })}
      </Swiper>
    </div>
  );
}
