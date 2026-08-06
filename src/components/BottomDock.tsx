"use client";

export type DockTabKey = "fans" | "anchor" | "pending" | "help";

interface BottomDockProps {
  tabs: { key: DockTabKey; label: string }[];
  activeKey: DockTabKey;
  onChange: (key: DockTabKey) => void;
}

/**
 * iOS 苹果风格悬浮底部托盘导航栏（Dock Bar）
 * 毛玻璃胶囊 + 选中渐变高亮 + 果冻按压动画
 */
export default function BottomDock({ tabs, activeKey, onChange }: BottomDockProps) {
  return (
    <div className="bottom-dock-container">
      <nav className="bottom-dock">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={`dock-item ${activeKey === t.key ? "active" : ""}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}