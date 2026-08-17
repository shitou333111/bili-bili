import WindowTitleBar from "@/components/WindowTitleBar";
import SafeAreaStyler from "@/components/SafeAreaStyler";

/**
 * 自定义 404 页面。
 *
 * Tauri 桌面（decorations:false）下，若使用 Next.js 默认 404 页会全屏铺满窗口并覆盖自绘标题栏，
 * 导致无法拖动 / 最小化 / 关闭窗口。这里显式渲染 WindowTitleBar，并让内容避开标题栏高度。
 */
export default function NotFound() {
  return (
    <div
      className="min-h-screen flex flex-col bg-[#faf9f6] text-[#1f1c17]"
      style={{ paddingTop: "var(--safe-top, 0px)" }}
    >
      <SafeAreaStyler />
      <WindowTitleBar />
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="text-6xl font-bold mb-3">404</div>
        <p className="text-sm text-black/55 mb-6">页面不存在或已被移除</p>
        <a
          href="/"
          className="rounded-full bg-[#1f1c17] px-5 py-2 text-sm text-white transition hover:opacity-90"
        >
          返回首页
        </a>
      </div>
    </div>
  );
}
