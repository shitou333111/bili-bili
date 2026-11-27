/**
 * 统一的黄色灯泡提示图标（点歌说明等提示气泡同款）。
 * 仅负责图标本身，交互与浮层由使用方决定。
 */
export default function BulbIcon({
  className = "h-4 w-4",
  fill = "#f0b429",
}: {
  className?: string;
  fill?: string;
}) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill={fill} aria-hidden>
      <path d="M9 21h6v-1.5H9V21zm3-19a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2z" />
    </svg>
  );
}
