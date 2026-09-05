"use client";

import { useState, useEffect } from "react";
import { getPlatform, isWindowsDisplaySupported } from "@/lib/platform";
import { showToast } from "@/lib/toast";

/**
 * 开机自启动卡片（帮助页 · 主播推荐卡片下方）。
 * 仅 Windows 桌面 Tauri 客户端展示（tauri-plugin-autostart 写注册表 HKCU\...\Run，
 * 指向当前 exe 绝对路径，单文件免安装同样生效）。
 */
export default function AutostartCard() {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);

  // 初始化：判平台 + 读取当前自启动状态
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const platform = await getPlatform();
        if (!alive) return;
        if (!isWindowsDisplaySupported(platform)) {
          setSupported(false);
          return;
        }
        const { isEnabled } = await import("@tauri-apps/plugin-autostart");
        const on = await isEnabled();
        if (alive) {
          setSupported(true);
          setEnabled(on);
        }
      } catch {
        if (alive) setSupported(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 切换自启动
  const toggle = async () => {
    if (loading) return;
    setLoading(true);
    const next = !enabled;
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (next) {
        await enable();
      } else {
        await disable();
      }
      setEnabled(next);
      showToast(next ? "已开启开机自启动" : "已关闭开机自启动");
    } catch {
      showToast(next ? "开启失败，请稍后重试" : "关闭失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  if (!supported) return null;

  return (
    <div className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="text-3xl">🚀</span>
        <h3 className="text-base font-bold">开机自启动</h3>
        {/* 开关 */}
        <button
          onClick={() => void toggle()}
          disabled={loading}
          className={`relative ml-auto h-[26px] w-[46px] shrink-0 rounded-full transition-colors duration-300 ${
            enabled ? "bg-[#34c759]" : "bg-black/15"
          } ${loading ? "opacity-50" : ""}`}
          role="switch"
          aria-checked={enabled}
        >
          <span
            className={`absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all duration-300 ${
              enabled ? "left-[22px]" : "left-[2px]"
            }`}
          />
        </button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-black/45">
        如果是主播，建议保持开机自启动，因为需要实时接收直播间数据
      </p>
    </div>
  );
}