"use client";

import { Swiper, SwiperSlide } from "swiper/react";
import { Autoplay } from "swiper/modules";
import type { Swiper as SwiperType } from "swiper";
import "swiper/css";
import { LANDING_SLIDES } from "@/lib/landing-content";

// ==================== 宣传语轮播（Swiper·文字在上·图片在下·仅文字霓虹光晕） ====================
// 文案/配图/配色统一来自 @/lib/landing-content（登录页也复用同一份内容）。
// 每张图片与其文字是一个独立 slide（slide 内文字在上、图片在下），仅文字带霓虹光晕，图片无光晕。
// 采用 Swiper slides-per-view 自适应：手机 1 张，平板 2 张，宽屏 3 张；
// 整页翻动（slidesPerGroup = 每屏张数），每批停留 = 单张 5s × 每屏张数，循环自动播放。

const PER_SLIDE_MS = 8000; // 单张基础停留时长
const SPEED_MS = 900; // 划动动画时长（更长更顺滑）

/** 按当前每屏张数设置自动播放停留：单张 × 每屏张数 */
function applyAutoplayDelay(swiper: SwiperType) {
  const perView = Number(swiper.params.slidesPerView) || 1;
  if (swiper.params.autoplay) swiper.params.autoplay.delay = PER_SLIDE_MS * perView;
}

export default function SloganRotator({
  fitViewport = false,
  count,
}: {
  fitViewport?: boolean;
  /** 只展示前 count 张（数据初始化遮罩用来占位；不传则展示全部） */
  count?: number;
}) {
  const slides = count ? LANDING_SLIDES.slice(0, count) : LANDING_SLIDES;
  return (
    <div
      className={
        fitViewport
          ? "mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-3 sm:px-4"
          : "mx-auto mt-8 w-full max-w-5xl sm:mt-12"
      }
    >
      <Swiper
        modules={[Autoplay]}
        speed={SPEED_MS}
        slidesPerView={1}
        slidesPerGroup={1}
        spaceBetween={16}
        loop
        // 断点以「轮播自身容器宽度」计算：登录页等内容被 --page-max-width 限制在 500px，
        // 若仍按窗口宽度（桌面 ≥768/1280）取 2/3 张，会被挤成一张张小图。
        // 官网首页不传 fitViewport，保持按窗口宽度自适应（宽屏 3 张）。
        breakpointsBase={fitViewport ? "container" : "window"}
        // 19 张图片不能被 2/3 整除时，Swiper 默认会补「空白 slide」凑满最后一组，
        // 表现为最后 1~2 个位置只有空白背景。关闭该补位（循环会用两端预留的 slide 填满）。
        loopAddBlankSlides={false}
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
        className={
          fitViewport
            ? "h-full min-h-0 w-full [&_.swiper-wrapper]:items-stretch"
            : "w-full [&_.swiper-wrapper]:items-stretch"
        }
      >
        {slides.map((slide, i) => {
          const color = slide.color;
          return (
            <SwiperSlide key={i} className={fitViewport ? "!h-full" : "!h-auto"}>
              <div
                className={
                  fitViewport
                    ? "flex h-full w-full items-center justify-center"
                    : "flex h-full w-full flex-col items-center"
                }
              >
                <div
                  className={
                    fitViewport
                      ? // 首屏模式：文字 + 图片作为一个整体，最多占可用空间（标题栏以下）的 90%，
                        // 由外层 flex 水平/竖直居中；文字与图片之间保持固定的紧凑间距。
                        "flex h-[90%] w-full max-w-[90%] flex-col items-center gap-2"
                      : "relative flex h-full w-full flex-col items-center px-2 pt-6 pb-4"
                  }
                >
                  {/* 文字在上 */}
                  <span
                    className="flex min-h-10 w-full shrink-0 items-start justify-center px-1 text-center text-[17px] font-semibold leading-snug sm:text-[17px]"
                    style={{ color }}
                  >
                    {slide.text}
                  </span>
                  {fitViewport ? (
                    // 图片在文字下方的剩余空间内等比自适应，撑满这 90% 的区域
                    <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                      <img
                        src={slide.image}
                        alt=""
                        loading="lazy"
                        className="landing-slide-img-fit"
                      />
                    </div>
                  ) : (
                    // 官网首页：等比缩放，宽或高最多占窗口的 90%，并直接带圆角
                    <img
                      src={slide.image}
                      alt=""
                      loading="lazy"
                      className="landing-slide-img mx-auto"
                    />
                  )}
                </div>
              </div>
            </SwiperSlide>
          );
        })}
      </Swiper>
    </div>
  );
}
