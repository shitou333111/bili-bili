import type { Metadata } from "next";
import RedLotteryList from "@/components/RedLotteryList";

export const metadata: Metadata = {
  title: "B瓜 · 天选红包列表",
  description: "展示正在发放天选和红包的直播间，点击进入直播间手动参与。",
};

/** 公开的天选/红包直播间列表（只展示，不提供自动参与） */
export default function RedPage() {
  return <RedLotteryList />;
}
