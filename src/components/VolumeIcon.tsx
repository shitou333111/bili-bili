/**
 * 音量图标（内联 SVG，替换原来的 🔊 / 🔇 emoji）：
 * - **不静音**：喇叭 + 两道音量波形（主流样式，如 lucide volume-2）；
 * - **静音**：同一个图标 **+ 一道短红斜线** —— 波形保留，斜线只压住喇叭到第一道波形，
 *   不像 emoji 🔇 那样横穿整个图标（太长），也不像它那样把波形去掉（看不出是同一个音量钮）。
 *
 * 颜色：喇叭 / 波形走 `currentColor`（跟随按钮文字色），斜线固定红色；
 * 斜线下垫一层白色描边，保证压在直播画面上（黑底）或浅色按钮上都看得清。
 */
export default function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* 喇叭 */}
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {/* 音量波形：静音时也保留 —— 就是「不静音的图标 + 斜线」 */}
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
      {muted && (
        <>
          {/* 白色衬底（比红斜线粗一圈） */}
          <path d="M6 18 15 9" stroke="#fff" strokeWidth={4.5} />
          {/* 短红斜线：45°，只盖住喇叭到第一道波形，不横穿整个图标 */}
          <path d="M6 18 15 9" stroke="#ef4444" strokeWidth={2.4} />
        </>
      )}
    </svg>
  );
}
