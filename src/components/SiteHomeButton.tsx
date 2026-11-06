/** 两个页面共用的「返回网站首页」页脚按钮 */
export default function SiteHomeButton() {
  return (
    <footer className="mt-10 flex justify-center">
      <a
        href="https://bili-bili.icu"
        target="_blank"
        rel="noreferrer"
        className="group inline-flex items-center gap-2.5 rounded-full bg-[#221d24] px-6 py-3 text-[13px] font-medium text-white shadow-[0_14px_30px_-14px_rgba(34,29,36,0.75)] transition hover:-translate-y-0.5 hover:bg-[#2f2831] hover:shadow-[0_18px_36px_-14px_rgba(34,29,36,0.8)] active:translate-y-0 active:scale-95"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-[#9df0cf]">
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 10.5 12 3.5l8.5 7" />
            <path d="M5.5 9.5V20h13V9.5" />
            <path d="M9.5 20v-5.5h5V20" />
          </svg>
        </span>
        返回网站首页
        <span className="text-[12px] text-white/60">bili-bili.icu</span>
        <span className="text-[14px] text-white/70 transition-transform group-hover:translate-x-0.5">→</span>
      </a>
    </footer>
  );
}
