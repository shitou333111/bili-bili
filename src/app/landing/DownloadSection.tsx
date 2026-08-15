"use client";

import { useState } from "react";

// ==================== 站点配置（单一来源） ====================
// 安装包下载根路径：nginx 将 /artifacts/ 映射到服务器 ${SSH_TARGET_DIR}/artifacts/ 目录。
// 三个 current_* 符号链接由 CI 自动指向各平台最新安装包。
// 下载文件名由 <a download="B瓜.xxx"> 指定，与 URL 上的 current_* 符号链接名无关。
const DOWNLOAD_BASE = "https://bili-bili.icu/artifacts";

// ==================== 下载平台配置 ====================
const platforms = [
  {
    id: "windows",
    name: "Windows",
    fileType: "EXE",
    fileName: "B瓜.exe",
    href: `${DOWNLOAD_BASE}/current_exe`,
    color: "#2563eb",
    softBg: "#eef4ff",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-14 w-14 sm:h-20 sm:w-20" aria-hidden="true">
        <path d="M3 5.5 10.2 4.4v7.1H3V5.5Zm7.2 7.7v7.4L3 19.5v-6.3h7.2ZM11.2 4.2 21 3v8.7h-9.8V4.2Zm9.8 9.3V21l-9.8-1.4v-6.1h9.8Z" />
      </svg>
    ),
  },
  {
    id: "android",
    name: "Android",
    fileType: "APK",
    fileName: "B瓜.apk",
    href: `${DOWNLOAD_BASE}/current_apk`,
    color: "#16a34a",
    softBg: "#ecfdf3",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-14 w-14 sm:h-20 sm:w-20" aria-hidden="true">
        <path d="M6.2 8.4c-1.1 0-2 .9-2 2v5.4c0 1.1.9 2 2 2h.5v2.9c0 .7.6 1.3 1.3 1.3s1.3-.6 1.3-1.3v-2.9h4.9v2.9c0 .7.6 1.3 1.3 1.3s1.3-.6 1.3-1.3v-2.9h.5c1.1 0 2-.9 2-2v-5.4c0-1.1-.9-2-2-2H6.2Zm-1.3-2.6 1.3 2.6h11.6l1.3-2.6c.3-.6.1-1.4-.5-1.7-.6-.3-1.4-.1-1.7.5l-1 2h-8l-1-2c-.3-.6-1.1-.8-1.7-.5-.6.3-.8 1.1-.5 1.7h.2ZM8 12.3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm8 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
      </svg>
    ),
  },
  {
    id: "ios",
    name: "iOS",
    fileType: "IPA",
    fileName: "B瓜.ipa",
    href: `${DOWNLOAD_BASE}/current_ipa`,
    color: "#7873f5",
    softBg: "#f4f1ff",
    icon: (
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-14 w-14 sm:h-20 sm:w-20" aria-hidden="true">
        <path d="M16.7 12.9c0-2.5 2-3.7 2.1-3.8-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.9-1.6 0-3.1 1-4 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.8 2.5 3 2.4 1.2-.1 1.7-.8 3.1-.8s1.9.8 3.1.8c1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.4-.9-2.3-3.6Zm-2.2-6.4c.7-.8 1.1-1.9 1-3-1 .1-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3Z" />
      </svg>
    ),
  },
];

export default function DownloadSection({
  dates,
  counts: initialCounts,
}: {
  dates: Record<string, string>;
  counts: Record<string, number> | null;
}) {
  const [showIosGuide, setShowIosGuide] = useState(false);
  // 下载次数用本地 state 承载：点击下载时乐观自增，无需刷新即可看到变化
  const [counts, setCounts] = useState<Record<string, number> | null>(initialCounts);

  return (
    <>
      {/* 三个下载卡片：flex 自适应换行，窄屏自动折行 */}
      <div className="mt-8 flex flex-wrap justify-center gap-3 sm:gap-5">
        {platforms.map((p) => (
          <div
            key={p.id}
            className="group relative flex w-full max-w-[280px] flex-col items-center overflow-hidden rounded-3xl border border-[#ececec] bg-white px-2 pb-4 pt-6 text-center shadow-sm transition-all hover:-translate-y-1.5 hover:shadow-lg sm:w-[calc(50%-10px)] sm:max-w-none sm:flex-1 sm:px-5 sm:pb-6 sm:pt-7"
          >
            {/* 构建日期角标：卡片右上角；无日期信息则不显示 */}
            {dates[p.id] && (
              <span
                className="absolute right-3 top-3 rounded-full px-2 py-0.5 text-[9px] font-medium text-white sm:right-4 sm:top-4 sm:px-2.5 sm:py-1 sm:text-[10px]"
                style={{ background: p.color }}
              >
                {dates[p.id].replace(/-/g, ".")}
              </span>
            )}
            {/* 平台图标 */}
            <div
              className="flex h-16 w-16 items-center justify-center rounded-2xl transition-transform group-hover:scale-105 sm:h-24 sm:w-24"
              style={{ background: p.softBg, color: p.color }}
            >
              {p.icon}
            </div>
            {/* 平台名 + iOS 安装指南按钮（iOS 卡片上紧跟平台名） */}
            <div className="mt-2 flex items-center gap-1.5 sm:mt-3">
              <h3 className="text-sm font-semibold sm:text-base">{p.name}</h3>
              {p.id === "ios" && (
                <button
                  type="button"
                  onClick={() => setShowIosGuide(true)}
                  className="rounded-full border border-[#e3e3e3] bg-white px-1.5 py-0.5 text-[9px] font-medium text-[#6b6b6b] hover:bg-[#f5f5f5] sm:px-2 sm:text-[10px]"
                >
                  安装指南
                </button>
              )}
            </div>
            {/* 下载按钮：统一灰色、尺寸较小；点击时乐观自增计数并上报一次下载 */}
            <a
              href={p.href}
              download={p.fileName}
              onClick={() => {
                setCounts((prev) =>
                  prev === null
                    ? prev
                    : { ...prev, [p.id]: (prev[p.id] || 0) + 1 },
                );
                fetch("/api/downloads", {
                  method: "POST",
                  keepalive: true,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ platform: p.id }),
                }).catch(() => {});
              }}
              className="mt-3 inline-flex items-center justify-center gap-1 rounded-full bg-[#ececec] px-3 py-1.5 text-[11px] font-medium text-[#444] transition-colors hover:bg-[#e0e0e0] active:scale-95 sm:mt-4 sm:gap-1.5 sm:px-4 sm:py-2 sm:text-[12px]"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
              </svg>
              下载 {p.fileType}
            </a>
            {/* 累计下载次数 */}
            {counts !== null && (
              <p className="mt-2 text-[10px] text-[#b0b0b0] sm:text-[11px]">
                共下载 {counts[p.id] || 0} 次
              </p>
            )}
          </div>
        ))}
      </div>

      {/* ============ iOS 安装指南弹窗 ============ */}
      {showIosGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowIosGuide(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold">iOS 安装指南</h3>
            <div className="mt-4 space-y-3 text-sm leading-6 text-[#4a4a4a]">
              <p>
                苹果手机安装比较麻烦，因为系统限制，很难安装官方商店之外的APP。最简单的方法是，先购买一个签名证书，安装好签名软件，再安装 ipa 包。
                某宝搜索“ipa签名”，随便花几块钱买一个，店家有详细的使用教程。
              </p>
              <p>
                需要花钱花时间折腾，但这是我调研测试过最合适的方法。
                免费方法也有，搜索“苹果侧载”，不过不建议开发者之外的用户折腾。
              </p>
              <img
                src="/buy-ipa.png"
                alt="购买 ipa 签名示意图"
                className="w-full rounded-xl border border-[#ececec]"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowIosGuide(false)}
              className="mt-6 w-full rounded-full bg-[#1f1c17] px-5 py-2.5 text-sm font-medium text-white"
            >
              我知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}
