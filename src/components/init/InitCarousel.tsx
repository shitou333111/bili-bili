"use client";

import { Swiper, SwiperSlide } from "swiper/react";
import { Autoplay } from "swiper/modules";
import type { Swiper as SwiperType } from "swiper";
import "swiper/css";
import type { InitCarouselSlide } from "@/lib/init-carousel-content";

// ==================== 数据初始化遮罩的轮播（整屏自适应版） ====================
// 与官网 Swiper 同款交互，但高度铺满遮罩可用区域：文字在上、图片在下的剩余空间内等比缩放。
// 内容由调用方传入（消费记录 / 流水记录各有独立内容与组件）。

const PER_SLIDE_MS = 8000;
const SPEED_MS = 900;

/** 按当前每屏张数设置自动播放停留：单张 × 每屏张数 */
function applyAutoplayDelay(swiper: SwiperType) {
  const perView = Number(swiper.params.slidesPerView) || 1;
  if (swiper.params.autoplay) swiper.params.autoplay.delay = PER_SLIDE_MS * perView;
}

export default function InitCarousel({ slides }: { slides: InitCarouselSlide[] }) {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-3 sm:px-4">
      <Swiper
        modules={[Autoplay]}
        speed={SPEED_MS}
        slidesPerView={1}
        slidesPerGroup={1}
        spaceBetween={16}
        loop
        // 以轮播自身容器宽度计算断点：遮罩被 --page-max-width 限制在 500px
        breakpointsBase="container"
        loopAddBlankSlides={false}
        autoplay={{ delay: PER_SLIDE_MS, disableOnInteraction: false }}
        onInit={applyAutoplayDelay}
        onBreakpoint={(s) => {
          applyAutoplayDelay(s);
          s.autoplay.stop();
          s.autoplay.start();
        }}
        breakpoints={{
          768: { slidesPerView: 2, slidesPerGroup: 2, spaceBetween: 32 },
          1280: { slidesPerView: 3, slidesPerGroup: 3, spaceBetween: 40 },
        }}
        className="h-full min-h-0 w-full [&_.swiper-wrapper]:items-stretch"
      >
        {slides.map((slide, i) => (
          <SwiperSlide key={i} className="!h-full">
            <div className="flex h-full w-full items-center justify-center">
              <div className="flex h-[90%] w-full max-w-[90%] flex-col items-center gap-2">
                <span
                  className="flex min-h-10 w-full shrink-0 items-start justify-center px-1 text-center text-[17px] font-semibold leading-snug"
                  style={{ color: slide.color }}
                >
                  {slide.text}
                </span>
                <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={slide.image} alt="" loading="lazy" className="landing-slide-img-fit" />
                </div>
              </div>
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
}
