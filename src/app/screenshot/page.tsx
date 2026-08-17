"use client";

/**
 * 复活曲截图工具页 —— 托管在网站服务器上，由 ScreenshotViewer 以 iframe 加载。
 * 内容会变动（下载链接、教程视频等），不打包进 APP。
 */
export default function ScreenshotPage() {
  return (
    <main className="page-main">
      <div className="content-wrapper px-4 min-w-0 py-4">
        {/* 返回由 APP 内的 ScreenshotViewer 顶栏提供（避免 iframe 内整页跳转不丝滑） */}

        <div className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur space-y-5">
          <div className="text-center">
            <div className="text-5xl mb-3">📸</div>
            <h3 className="text-xl font-bold">复活曲截图工具</h3>
            <p className="text-base text-black/50 mt-1">直播多人局必备，解决复活曲倒计时投屏和医药费争议</p>
          </div>

          <hr className="border-black/5" />

          <div className="space-y-3">
            <h4 className="text-base font-semibold">你是否遇到过这些问题？</h4>
            <div className="space-y-2">
              <div className="flex gap-2">
                <span className="text-[#e74c3c] leading-relaxed shrink-0">●</span>
                <span className="text-base text-black/70 leading-relaxed">多人局时，不知道怎么把复活曲倒计时清晰方便地投屏出来给观众看</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[#e74c3c] leading-relaxed shrink-0">●</span>
                <span className="text-base text-black/70 leading-relaxed">最后偷塔守塔不确定有没有掉地上，而主持人没有截图，医药费有争议。而又不好意思争论，只能选择默默吃亏</span>
              </div>
            </div>
          </div>

          <hr className="border-black/5" />

          <div className="space-y-3">
            <h4 className="text-base font-semibold">软件功能</h4>
            <div className="space-y-2">
              <div className="flex gap-2">
                <span className="text-[#2ecc71] leading-relaxed shrink-0">✓</span>
                <span className="text-base text-black/70 leading-relaxed">方便地将复活曲倒计时投屏出来，一次操作长久有效，不用重复设置</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[#2ecc71] leading-relaxed shrink-0">✓</span>
                <span className="text-base text-black/70 leading-relaxed">复活曲结束时自动精确地截屏直播画面，确定各位的分数，进而确定医药费</span>
              </div>
            </div>
          </div>

          <hr className="border-black/5" />

          <div className="text-center">
            <a
              href="https://pan.baidu.com/s/1B8IbxCR9g6bZvE3zZp75-Q?pwd=0000"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg bg-[#1f1c17] px-6 py-3 text-base font-medium hover:opacity-90 transition"
              style={{ color: "#fff" }}
            >
              百度网盘下载（提取码: 0000）
            </a>
          </div>

          <hr className="border-black/5" />

          <div className="space-y-3">
            <h4 className="text-base font-semibold">软件界面预览</h4>
            <div className="flex justify-center">
              <img
                src="/screenshot-software.png"
                alt="复活曲截图软件界面"
                className="rounded-lg border border-black/10 max-w-full"
              />
            </div>
          </div>

          <hr className="border-black/5" />

          <div className="space-y-3">
            <h4 className="text-base font-semibold">使用教程</h4>
            <div className="aspect-video w-full rounded-lg overflow-hidden border border-black/10">
              <iframe
                src="//player.bilibili.com/player.html?bvid=BV1P8K66qE7Y&autoplay=0"
                allowFullScreen
                className="w-full h-full"
                scrolling="no"
                frameBorder="0"
              />
            </div>
            <p className="text-sm text-black/40 text-center">详细使用方法请观看视频</p>
          </div>
        </div>
      </div>
    </main>
  );
}
