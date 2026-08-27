"use client";

/**
 * 临时诊断徽标：在屏幕角落常驻显示当前内置前端资源的热更序列号（NEXT_PUBLIC_BUILD_SEQ）。
 * 用途：验证热更新链路——冷启动后如看到该数字变为最新序列（如 116），
 * 说明热更包已被检测并应用成功。验证完毕可移除本组件。
 */
export default function BuildStampBadge() {
  const seq = Number(process.env.NEXT_PUBLIC_BUILD_SEQ) || 0;
  return (
    <div
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 99999,
        background: "rgba(0,0,0,0.6)",
        color: "#7CFC00",
        fontSize: 11,
        padding: "2px 6px",
        borderRadius: 4,
        fontFamily: "monospace",
        pointerEvents: "none",
      }}
    >
      HOT-BUILD:{seq}
    </div>
  );
}