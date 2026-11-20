"use client";

import InitCarousel from "./InitCarousel";
import { STREAM_RECORD_SLIDES } from "@/lib/init-carousel-content";

/**
 * 「流水记录」加载阶段的专属轮播。
 * 替换文案/图片：修改 src/lib/init-carousel-content.ts 的 STREAM_RECORD_SLIDES，
 * 图片替换 public/init_slides/stream-*.jpg 即可。
 */
export default function StreamRecordCarousel() {
  return <InitCarousel slides={STREAM_RECORD_SLIDES} />;
}
