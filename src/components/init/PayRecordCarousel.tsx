"use client";

import InitCarousel from "./InitCarousel";
import { PAY_RECORD_SLIDES } from "@/lib/init-carousel-content";

/**
 * 「消费记录」加载阶段的专属轮播。
 * 替换文案/图片：修改 src/lib/init-carousel-content.ts 的 PAY_RECORD_SLIDES，
 * 图片替换 public/init_slides/pay-*.jpg 即可。
 */
export default function PayRecordCarousel() {
  return <InitCarousel slides={PAY_RECORD_SLIDES} />;
}
