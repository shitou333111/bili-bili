import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "B瓜 · Bilibili 直播消费数据分析工具",
  description:
    "B瓜 是专为 Bilibili 直播打造的个人消费数据分析工具。扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏，支持 Web / Windows / Android / iOS 跨平台使用。",
};

// ==================== 站点配置（单一来源） ====================
// App 主站（子域名）
const APP_URL = "https://app.bili-bili.icu";
// 安装包下载根路径：nginx 将 /artifacts/ 映射到服务器 ${SSH_TARGET_DIR}/artifacts/ 目录。
// 三个 current_* 符号链接由 CI 自动指向各平台最新安装包。
const DOWNLOAD_BASE = "https://bili-bili.icu/artifacts";

// ==================== 下载平台配置 ====================
const platforms = [
  {
    id: "windows",
    name: "Windows",
    fileType: "EXE",
    desc: "Windows 10 / 11 桌面应用，无需安装浏览器",
    href: `${DOWNLOAD_BASE}/current_exe`,
    icon: (
      <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
        <path d="M3 5.5 10.2 4.4v7.1H3V5.5Zm7.2 7.7v7.4L3 19.5v-6.3h7.2ZM11.2 4.2 21 3v8.7h-9.8V4.2Zm9.8 9.3V21l-9.8-1.4v-6.1h9.8Z" />
      </svg>
    ),
  },
  {
    id: "android",
    name: "Android",
    fileType: "APK",
    desc: "Android 8.0+ 手机应用，扫码登录即可使用",
    href: `${DOWNLOAD_BASE}/current_apk`,
    icon: (
      <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
        <path d="M6.2 8.4c-1.1 0-2 .9-2 2v5.4c0 1.1.9 2 2 2h.5v2.9c0 .7.6 1.3 1.3 1.3s1.3-.6 1.3-1.3v-2.9h4.9v2.9c0 .7.6 1.3 1.3 1.3s1.3-.6 1.3-1.3v-2.9h.5c1.1 0 2-.9 2-2v-5.4c0-1.1-.9-2-2-2H6.2Zm-1.3-2.6 1.3 2.6h11.6l1.3-2.6c.3-.6.1-1.4-.5-1.7-.6-.3-1.4-.1-1.7.5l-1 2h-8l-1-2c-.3-.6-1.1-.8-1.7-.5-.6.3-.8 1.1-.5 1.7h.2ZM8 12.3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm8 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z" />
      </svg>
    ),
  },
  {
    id: "ios",
    name: "iOS",
    fileType: "IPA",
    desc: "iPhone / iPad，需自行签名或使用侧载工具安装",
    href: `${DOWNLOAD_BASE}/current_ipa`,
    icon: (
      <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
        <path d="M16.7 12.9c0-2.5 2-3.7 2.1-3.8-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.9-1.6 0-3.1 1-4 2.4-1.7 2.9-.4 7.2 1.2 9.5.8 1.2 1.8 2.5 3 2.4 1.2-.1 1.7-.8 3.1-.8s1.9.8 3.1.8c1.3 0 2.1-1.1 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7-.1 0-2.4-.9-2.3-3.6Zm-2.2-6.4c.7-.8 1.1-1.9 1-3-1 .1-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1.1.1 2.1-.5 2.8-1.3Z" />
      </svg>
    ),
  },
];

// ==================== 项目介绍特性 ====================
const features = [
  {
    title: "消费记录长期统计",
    desc: "自动抓取送给每位主播的每一笔礼物，按电池数、次数、礼物种类等维度长期汇总。",
  },
  {
    title: "盲盒盈亏分析",
    desc: "心动盲盒、幸运盲盒、活动盲盒的投入 / 产出 / 盈亏统计，支持按主播与日期钻取。",
  },
  {
    title: "合成活动分析",
    desc: "合成包、星石抽奖、翻牌等活动的盈亏与记录明细，一目了然。",
  },
  {
    title: "主播数据看板",
    desc: "查看主播维度的收入统计，以及消费主播分布气泡图，看清钱花在了哪。",
  },
  {
    title: "B站 小工具",
    desc: "粉丝清理、粉丝牌清理、用户信息查询等实用工具，一键导出数据。",
  },
  {
    title: "跨平台 · 数据不丢失",
    desc: "Web / Windows / Android / iOS 一套代码，消费记录自动增量保存，换设备也不丢。",
  },
];

// ==================== 使用教程步骤 ====================
const steps = [
  {
    title: "登录你的 B站 账号",
    desc: "打开应用或网页，使用手机 B站 App 扫码登录（或粘贴 Cookie）。登录凭证仅保存在本机，自动校验并续期。",
  },
  {
    title: "自动抓取消费数据",
    desc: "登录后自动拉取你的送礼记录、盲盒记录与合成活动记录，并增量保存到本地与你的服务器，长期不丢失。",
  },
  {
    title: "多维度查看统计",
    desc: "粉丝 / 主播 / 模拟 / 帮助 四个模块切换，按月份、主播、日期筛选，查看盈亏与消费分布。",
  },
  {
    title: "导出与分享",
    desc: "一键生成分享图片（海报）、导出 JSON 数据，方便复盘或与他人核对。",
  },
];

export default function LandingPage() {
  return (
    <main
      className="min-h-screen text-[#1f1c17]"
      style={{ background: "#f5f5f5", WebkitUserSelect: "auto", userSelect: "auto" }}
    >
      <div className="content-wrapper px-5 pb-20 pt-10 sm:px-8">
        {/* ============ Hero ============ */}
        <section className="flex flex-col items-center pt-8 text-center sm:pt-16">
          <div
            className="flex h-20 w-20 items-center justify-center rounded-[24px] text-4xl font-bold text-white shadow-lg"
            style={{
              background: "linear-gradient(135deg, #ff6ec4, #7873f5)",
              boxShadow: "0 12px 32px rgba(120,115,245,0.35)",
            }}
          >
            瓜
          </div>
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">B瓜</h1>
          <p className="mt-3 text-base text-[#6b6b6b] sm:text-lg">
            Bilibili 直播消费数据分析工具
          </p>
          <p className="mt-4 max-w-xl text-[15px] leading-7 text-[#4a4a4a] sm:text-base">
            看透你在 B站直播的每一笔消费。扫码登录后自动抓取送礼、盲盒、合成活动记录，
            多维度统计盈亏，一键生成分享图。支持 Web / Windows / Android / iOS 跨平台使用。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={APP_URL}
              className="inline-flex items-center gap-2 rounded-full px-7 py-3 text-[15px] font-medium text-white transition-transform active:scale-95"
              style={{
                background: "linear-gradient(135deg, #ff6ec4, #7873f5)",
                boxShadow: "0 8px 24px rgba(120,115,245,0.35)",
              }}
            >
              进入应用
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
            <a
              href="#download"
              className="inline-flex items-center gap-2 rounded-full border border-[#e3e3e3] bg-white px-7 py-3 text-[15px] font-medium text-[#1f1c17] transition-transform active:scale-95"
            >
              下载安装包
            </a>
          </div>
        </section>

        {/* ============ 项目介绍 ============ */}
        <section className="mx-auto mt-16 max-w-4xl sm:mt-24">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">项目介绍</h2>
          <p className="mt-3 text-center text-sm leading-6 text-[#6b6b6b]">
            B瓜 让你清楚每一笔礼物钱花在了哪里、投了什么盲盒、合成活动赚不赚。
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-sm transition-transform hover:-translate-y-1"
              >
                <h3 className="text-[15px] font-semibold">{f.title}</h3>
                <p className="mt-2 text-[13px] leading-6 text-[#6b6b6b]">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ============ 使用教程 ============ */}
        <section className="mx-auto mt-16 max-w-3xl sm:mt-24">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">使用教程</h2>
          <ol className="mt-8 space-y-4">
            {steps.map((s, i) => (
              <li key={s.title} className="flex gap-4 rounded-3xl border border-[#ececec] bg-white p-5 shadow-sm">
                <span
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white"
                  style={{ background: "linear-gradient(135deg, #ff6ec4, #7873f5)" }}
                >
                  {i + 1}
                </span>
                <div>
                  <h3 className="text-[15px] font-semibold">{s.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-6 text-[#6b6b6b]">{s.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ============ 下载 ============ */}
        <section id="download" className="mx-auto mt-16 max-w-4xl scroll-mt-8 sm:mt-24">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">下载安装包</h2>
          <p className="mt-3 text-center text-sm leading-6 text-[#6b6b6b]">
            以下为各平台最新版本安装包，由 CI 自动发布，随构建更新。
          </p>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {platforms.map((p) => (
              <div
                key={p.id}
                className="flex flex-col items-center rounded-3xl border border-[#ececec] bg-white p-6 text-center shadow-sm"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f4f1ff] text-[#7873f5]">
                  {p.icon}
                </div>
                <h3 className="mt-4 text-base font-semibold">{p.name}</h3>
                <p className="mt-1.5 min-h-[2.5rem] text-[12px] leading-5 text-[#8a8a8a]">{p.desc}</p>
                <a
                  href={p.href}
                  download
                  className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#1f1c17] px-5 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-90 active:scale-95"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" />
                  </svg>
                  下载 {p.fileType}
                </a>
              </div>
            ))}
          </div>
        </section>

        {/* ============ Footer ============ */}
        <footer className="mx-auto mt-16 max-w-3xl border-t border-[#e7e7e7] pt-8 text-center sm:mt-24">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[13px] text-[#8a8a8a]">
            <a href={APP_URL} className="hover:text-[#7873f5]">进入应用 app.bili-bili.icu</a>
            <span>·</span>
            <span>消费数据仅保存在你自己的设备与服务器</span>
          </div>
          <p className="mt-4 text-xs text-[#b0b0b0]">B瓜 · 非官方工具，与哔哩哔哩官方无关</p>
        </footer>
      </div>
    </main>
  );
}
