import type { MetadataRoute } from "next";

/**
 * PWA 清单（Web 端专用）。
 *
 * 该文件是 .ts 路由，Tauri 构建时被 next.config 的 pageExtensions 排除，
 * 因此客户端静态导出不会生成多余文件。
 *
 * 图标说明：
 *  - 192/512 any：桌面/Android 安装图标
 *  - 512 maskable：Android 自适应图标（内容已缩到 80% 安全区内，避免被系统裁切）
 *  - apple-touch-icon：iOS 添加到主屏图标（见 layout.tsx 的 metadata.icons.apple）
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "B瓜 · B站直播消费数据分析工具",
    short_name: "B瓜",
    description:
      "专为 Bilibili 直播打造的个人消费数据分析工具：扫码登录即可自动抓取并长期保存你的送礼、盲盒、合成活动等消费记录，多维度统计盈亏。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "zh-CN",
    background_color: "#f5f5f5",
    theme_color: "#f5f5f5",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
