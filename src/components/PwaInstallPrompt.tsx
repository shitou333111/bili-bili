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
 * PWA 安装引导弹窗（仅移动端网页显示，见 use-pwa-install 的显示条件）。
 *
 * 挂在登录页：必须在扫码登录之前弹出。因为"添加到主屏幕"后的独立 PWA 有自己
 * 独立的本地存储，先扫码登录再安装，用户还得在 PWA 里重新扫一次；先安装、
 * 再从桌面图标打开登录，才能一次扫码长期有效。
 *
 * 安装成功后弹窗保留一条"请从桌面图标打开"的确认提示，避免用户停留在
 * 当前浏览器标签页里继续登录。
 */
export default function PwaInstallPrompt({ delayMs }: { delayMs?: number }) {
  const { visible, mode, installed, install, dismiss } = usePwaInstall({ delayMs });
  if (!visible || !mode) return null;

  const canPrompt = mode === "prompt" && !installed;

  return (
    <div
      className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="安装到主屏幕"
    >
      <div className="relative w-full max-w-[360px] rounded-[26px] border border-black/[0.06] bg-white px-5 pb-5 pt-6 text-[#1f1c17] shadow-[0_26px_80px_rgba(0,0,0,0.4)]">
        <button
          type="button"
          onClick={dismiss}
          aria-label="关闭安装引导"
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-black/35 transition-colors hover:bg-black/[0.06] hover:text-black/60"
        >
          <svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>

        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon-192.png"
            alt="B瓜"
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-[9px] shadow-[0_2px_8px_rgba(0,0,0,0.16)]"
          />
          <p className="text-[16px] font-semibold leading-6">
            {installed ? "已添加到主屏幕" : "先安装 B瓜，再扫码登录"}
          </p>
        </div>

        <p className="mt-2.5 text-[12.5px] leading-[19px] text-black/60">
          {installed ? (
            "请关闭本页面，从桌面图标打开「B瓜」后再扫码登录。这样登录一次就能长期使用，数据也保存在这个 App 里，不用重复扫码。"
          ) : mode === "ios" ? (
            <>
              使用苹果系统浏览器 Safari，点击工具栏的共享按钮
              <ShareIcon />
              ，选择「添加到主屏幕」。安装后请从桌面图标打开 B瓜 再扫码登录，避免安装后又要重新扫码。
            </>
          ) : mode === "prompt" ? (
            "添加到主屏幕后像 App 一样使用，数据长期保存在本机。建议先安装，再从桌面图标打开 B瓜 并扫码登录，避免安装后需要重新扫码。"
          ) : (
            "点击浏览器 ⋮ 菜单，选择「添加到主屏幕」或「安装应用」。安装后请从桌面图标打开 B瓜 再扫码登录，避免安装后又要重新扫码。"
          )}
        </p>

        <div className="mt-5 flex items-center gap-2">
          {canPrompt ? (
            <>
              <button
                type="button"
                onClick={install}
                className="rounded-full bg-[#1f1c17] px-5 py-2 text-[13px] font-medium text-white transition-transform active:scale-[0.97]"
              >
                立即安装
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full px-3 py-2 text-[13px] font-medium text-black/45 transition-colors hover:bg-black/[0.05]"
              >
                以后再说
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="rounded-full bg-[#1f1c17] px-5 py-2 text-[13px] font-medium text-white transition-transform active:scale-[0.97]"
            >
              知道了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
