/**
 * 设备检测工具函数
 */

/** 判断是否为移动设备 */
export function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent.toLowerCase();
  return /android|iphone|ipad|ipod|blackberry|windows phone/i.test(ua);
}

/** 判断是否为电脑 */
export function isDesktop(): boolean {
  return !isMobileDevice();
}