"use client";

/** 音乐平台图标：优先使用 public 下的官方 logo，缺失时退回品牌色音符圆点 */
import { platformLabel, type SingPlatform } from "@/lib/sing/types";

const FILES: Record<string, string> = {
  netease: "/网易云音乐.png",
  qq: "/QQ音乐.png",
  kugou: "/酷狗音乐.png",
  soda: "/汽水音乐.png",
  // 软件内播放 = 本软件（B瓜）自己的图标
  inapp: "/orig_icon.png",
};

const STYLE: Record<string, { bg: string; glyph: string; circle?: boolean }> = {
  inapp: { bg: "#b26a6a", glyph: "▶" },
  kuwo: { bg: "#ff8a00", glyph: "♪" },
  migu: { bg: "#e60026", glyph: "♪" },
  qianqian: { bg: "#2aa8e0", glyph: "♪" },
  fivesing: { bg: "#f5a623", glyph: "5" },
  jamendo: { bg: "#00a0df", glyph: "J" },
  joox: { bg: "#00c853", glyph: "J" },
  apple: { bg: "#fa243c", glyph: "♪" },
  spotify: { bg: "#1db954", glyph: "♪" },
  bilibili: { bg: "#fb7299", glyph: "B" },
};

export default function PlatformIcon({
  platform,
  size = 16,
  className = "",
}: {
  platform?: SingPlatform | string;
  size?: number;
  className?: string;
}) {
  if (!platform) return null;
  const label = platform === "inapp" ? "软件内播放" : platformLabel(platform) || platform;
  const file = FILES[platform];
  if (file) {
    return (
      <img
        src={encodeURI(file)}
        alt={label}
        title={label}
        draggable={false}
        className={`inline-block shrink-0 select-none object-contain ${
          platform === "inapp" ? "rounded-[4px]" : ""
        } ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  const meta = STYLE[platform] || { bg: "#8a7373", glyph: "♪" };
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center font-bold leading-none text-white ${
        meta.circle ? "rounded-full" : "rounded-[4px]"
      } ${className}`}
      style={{ width: size, height: size, background: meta.bg, fontSize: Math.round(size * 0.62) }}
    >
      {meta.glyph}
    </span>
  );
}
