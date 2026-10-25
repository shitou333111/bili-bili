"use client";

import { usePwaInstall } from "@/lib/use-pwa-install";

/** iOS 分享图标（方框 + 向上箭头），用于图文指引里指示 Safari 的分享按钮 */
function ShareIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="inline-block align-[-2px] mx-0.5"
      aria-hidden="true"
    >
      <path d="M12 3v11" />
      <path d="M8.5 6.5 12 3l3.5 3.5" />
      <path d="M5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12" />
    </svg>
  );
}

/**
 * PWA 安装引导卡片（仅移动端网页显示，见 use-pwa-install 的显示条件）。
 * 悬浮在底部托盘栏上方，iOS 风格白色毛玻璃卡片 + 黑色文字，可关闭。
 */
export default function PwaInstallPrompt() {
  const { visible, mode, install, dismiss } = usePwaInstall();
  if (!visible || !mode) return null;

  const canPrompt = mode === "prompt";

  return (
    <div
      className="fixed left-0 right-0 z-[9990] flex justify-center px-3 pointer-events-none"
      style={{ bottom: "calc(var(--dock-bottom, 16px) + var(--dock-safe, 0px) + 76px)" }}
    >
      <div className="pointer-events-auto relative w-full max-w-[420px] rounded-[20px] border border-black/[0.06] bg-white/95 px-4 py-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.22)] backdrop-blur-xl">
        <button
          onClick={dismiss}
          aria-label="关闭安装引导"
          className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/[0.06] hover:text-black/60"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>

        <div className="min-w-0 pr-5">
          {/* 标题行：缩小后的头像与标题同行 */}
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icon-192.png"
              alt="B瓜"
              width={24}
              height={24}
              className="h-6 w-6 shrink-0 rounded-[7px] shadow-[0_2px_8px_rgba(0,0,0,0.16)]"
            />
            <p className="truncate text-[15px] font-semibold leading-5 text-[#1f1c17]">强烈建议把B瓜添加到主屏幕</p>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-[18px] text-black/55">
              {mode === "ios" ? (
                <>
                  使用苹果系统浏览器Safari，点击浏览器工具栏的共享按钮
                  <ShareIcon />
                  ，点击「查看更多」，再选择「添加到主屏幕」。这样可以不用安装APP，又能像App一样在桌面直接打开，数据长期保存在本机，无需每次输入网址。
                </>
              ) : mode === "prompt" ? (
                "添加到桌面：轻量安装后像App一样使用，数据长期保存在本机，无需每次输入网址。"
              ) : (
                "点击浏览器 ⋮ 菜单，选择「添加到主屏幕」或「安装应用」。轻量安装后像App一样使用，数据长期保存在本机，无需每次输入网址。"
              )}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              {canPrompt ? (
                <>
                  <button
                    onClick={install}
                    className="rounded-full bg-[#1f1c17] px-4 py-1.5 text-[13px] font-medium text-white transition-transform active:scale-[0.97]"
                  >
                    立即安装
                  </button>
                  <button
                    onClick={dismiss}
                    className="rounded-full px-3 py-1.5 text-[13px] font-medium text-black/45 transition-colors hover:bg-black/[0.05]"
                  >
                    以后再说
                  </button>
                </>
              ) : (
                <button
                  onClick={dismiss}
                  className="rounded-full bg-[#1f1c17] px-4 py-1.5 text-[13px] font-medium text-white transition-transform active:scale-[0.97]"
                >
                  知道了
                </button>
              )}
            </div>
        </div>
      </div>
    </div>
  );
}
