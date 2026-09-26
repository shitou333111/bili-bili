"use client";

import { useRouter } from "next/navigation";

/**
 * 页面内统一返回条（与"帮助"各子页的返回实现一致，如"复活曲自动截图"）。
 * 点击走 history.back() SPA 后退、不刷新页面，自动回到来路页（"主播"页提示卡片跳入时即回"主播"页）；
 * 无历史（直接打开本站）时兜底 push 回首页。
 * 放在文档流内，sticky 避开自绘标题栏（--safe-top 由根布局 SafeAreaStyler 注入）。
 */
export default function BackBar() {
  const router = useRouter();

  const handleBack = () => {
    if (window.history.length > 1) window.history.back();
    else router.push("/");
  };

  return (
    <div
      className="sticky z-40 flex items-center border-b border-black/5 bg-white/90 px-3 backdrop-blur"
      style={{ top: "var(--safe-top, 0px)", paddingTop: 8, paddingBottom: 8 }}
    >
      <button
        type="button"
        onClick={handleBack}
        className="-ml-1 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-black/60 transition hover:bg-black/5 hover:text-black/90 active:scale-95"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        返回
      </button>
    </div>
  );
}
