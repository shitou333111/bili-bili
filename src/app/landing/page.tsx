import type { Metadata } from "next";
import DownloadSection from "./DownloadSection";
import SloganRotator from "./SloganRotator";

export const metadata: Metadata = {
  title: "B瓜 · Bilibili 直播消费数据分析工具",
  description:
    "B瓜 是专为 Bilibili 直播打造的个人消费数据分析工具。扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏，支持 Windows / Android / iOS 客户端使用。",
};

// 页面为纯静态：版本日期与下载计数由客户端组件（DownloadSection）在浏览器中实时拉取，
// 保证 Tauri 构建（output: export）与 Web 部署（standalone）均能正常构建。
const features = [
  {
    title: "消费记录统计",
    desc: "自动抓取送给每位主播的每一笔礼物，按日期、主播等维度长期汇总",
  },
  {
    title: "盲盒、合成活动的盈亏分析",
    desc: "心动盲盒、幸运盲盒、活动盲盒的盈亏统计；合成活动的盈亏与记录明细，一目了然",
  },
  {
    title: "主播数据看板",
    desc: "主播查看收入统计，按日期、粉丝等维度长期汇总",
  },
  {
    title: "直播模拟器",
    desc: "模拟神豪视角，解锁全部礼物，合成活动畅玩",
  },

  {
    title: "B站 小工具",
    desc: "粉丝清理、粉丝牌清理、多人接力医药费、合成活动“黑抽”",
  },
  {
    title: "多平台",
    desc: "Windows / Android / iOS 三平台客户端随意使用",
  },
  {
    title: "免费",
    desc: "免费使用！不过还是希望大哥大姐们能赞助点服务器开销🧎‍♀️",
  },
  {
    title: "账户安全",
    desc: "用户的登录凭证仅在本地存储（包括开发者也拿不到），不会有账号被盗被登录的风险。就为了这个功能，从网站重构成了现在的APP方式😭",
  },
  {
    title: "对比其他工具",
    desc: "这个软件和其他直播辅助软件并不冲突，此软件没有直播间交互查询功能，没有和直播姬配合的功能，并且也不准备开发。而且只是个人娱乐项目，如果主播们有工作需要，建议还是购买专业软件。实际上作为开发者，我看过几个软件的售价，挺良心的。",
  },
  {
    title: "意见反馈",
    desc: "个人娱乐项目，起初只是为了给自己常看的几位主播实现几个功能，后来完善后分享给大家娱乐，BUG满页飞。用户可以在软件内反馈使用中的问题，重要的我尽量修复（但也有可能没时间修复...），而且也无法保证这个项目会持续维护😭",
  },
  {
    title: "APP名字由来",
    desc: "最开始是想做一个匿名发言社区，供B站用户在上面发帖讨论，俗称“吃瓜”。因为大家好像都很热心各种瓜，主播薅大哥，大哥骚扰主播等等。但最后作罢了，谁还没点腌臜事儿，私下吃吃瓜就够了，没必要拿别人的难堪事公开讨论。最后就变成帮大家看到一些在官方看不到或者不方便看的数据，无论是能帮助主播营业，还是能让用户娱乐一下，就够了。",
  },

];

export default function LandingPage() {
  return (
    <main
      className="min-h-screen text-[#1f1c17]"
      style={{ background: "#f5f5f5", WebkitUserSelect: "auto", userSelect: "auto" }}
    >
      <div className="content-wrapper px-5 pb-16 pt-6 sm:px-8 sm:pt-10">
        {/* ============ Hero ============ */}
        <section className="flex flex-col items-center pt-4 text-center sm:pt-6">
          {/* 图标 + 标题同一行 */}
          <div className="flex items-center justify-center gap-3 sm:gap-4">
            {/* 图标透明区域保持透明，不添加背景色 */}
            <img
              src="/orig_icon.png"
              alt="B瓜"
              width={72}
              height={72}
              className="h-16 w-16 rounded-[18px] sm:h-20 sm:w-20"
            />
            <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">B瓜</h1>
          </div>
          <p className="mt-3 text-base text-[#6b6b6b] sm:text-lg">
            Bilibili 直播数据分析工具
          </p>
          {/* 宣传语：七句在同一位置循环打字机效果，只占一行 */}
          <SloganRotator />
        </section>

        {/* ============ 下载安装包（在使用指南上方） ============ */}
        <section id="download" className="mx-auto mt-12 max-w-4xl scroll-mt-8 sm:mt-16">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">下载安装包</h2>
          <DownloadSection />
        </section>

        {/* ============ 使用指南（与上方下载区保持较大间隔） ============ */}
        <section id="guide" className="mx-auto mt-16 max-w-4xl scroll-mt-8 sm:mt-24">
          <h2 className="text-center text-2xl font-semibold sm:text-3xl">使用指南</h2>
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div
                key={f.title}
                className="rounded-3xl border border-[#ececec] bg-white p-5 shadow-sm transition-transform hover:-translate-y-1"
              >
                <h4 className="text-[15px] font-semibold">{f.title}</h4>
                <p className="mt-2 text-[13px] leading-6 text-[#6b6b6b]">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ============ Footer ============ */}
        <footer className="mx-auto mt-16 max-w-3xl border-t border-[#e7e7e7] pt-8 text-center sm:mt-20">
          <p className="mt-4 text-xs text-[#b0b0b0]">B瓜 · 非官方工具，与哔哩哔哩官方无关</p>
        </footer>
      </div>
    </main>
  );
}
