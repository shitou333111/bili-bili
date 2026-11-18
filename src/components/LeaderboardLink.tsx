/**
 * 「全站黑白榜」入口：粉丝页与主播页共用的同一样式链接。
 * 使用主域名绝对地址 + 新窗口；Tauri 内由 ExternalLinkHandler 交给系统浏览器打开。
 */
export default function LeaderboardLink({ className = "" }: { className?: string }) {
  return (
    <a
      href="https://bili-bili.icu/hbb"
      target="_blank"
      rel="noopener noreferrer"
      className={`-my-2 flex items-center justify-center gap-6 rounded-xl border border-black/10 bg-white/75 px-4 py-2.5 text-sm font-semibold text-black/75 shadow-[0_8px_24px_rgba(31,28,23,0.06)] backdrop-blur transition hover:bg-white hover:text-black active:scale-[0.99] ${className}`}
    >
      <span>全站黑白榜</span>
      <span className="text-[#5b3fa8] underline decoration-[#c9b8ee] underline-offset-2">
        bili-bili.icu/hbb
      </span>
    </a>
  );
}
