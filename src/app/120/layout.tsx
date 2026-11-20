import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "B瓜医药费",
  description: "B瓜 收发医药费与备用药统计工具。",
};

export default function MedicalFeeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
