import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "B瓜黑白榜",
  description: "B瓜 全站盲盒与合成活动盈亏排行，实时查看用户与主播的黑白榜。",
};

export default function HeiBaiLayout({ children }: { children: React.ReactNode }) {
  return children;
}
