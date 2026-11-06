"use client";

import { useEffect, useState } from "react";
import MedicalFeeDashboard from "@/components/medical-fee/MedicalFeeDashboard";
import MicroLightDashboard from "@/components/micro-light/MicroLightDashboard";

type Tab = "fee" | "backup";

const TAB_STORAGE_KEY = "bili_live_120_tab";

const TAB_STYLE: Record<Tab, { label: string; gradient: string }> = {
  fee: {
    label: "收发医药费",
    gradient: "from-[#8ef0cd] via-[#39b992] to-[#127f5f]",
  },
  backup: {
    label: "备用药",
    gradient: "from-[#ffc477] via-[#ff9c3f] to-[#ef6f1f]",
  },
};

/** 备用药活动状态图标：进行中 = 黄绿圈中点，已暂停 = 红圈套红方块 */
function BackupStatusIcon({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) {
    return (
      <span
        title="备用药活动状态加载中"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-black/15"
      />
    );
  }
  if (enabled) {
    return (
      <span
        title="备用药进行中"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-lime-500"
      >
        <span className="h-2 w-2 rounded-full bg-lime-500" />
      </span>
    );
  }
  return (
    <span
      title="备用药已暂停"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-red-500"
    >
      <span className="h-2.5 w-2.5 rounded-[2px] bg-red-500" />
    </span>
  );
}

export default function Page120() {
  // 首屏固定为 fee，与服务端渲染一致；挂载后再恢复上次选择的 tab（避免水合不一致）
  const [tab, setTab] = useState<Tab>("fee");
  const [mlEnabled, setMlEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (localStorage.getItem(TAB_STORAGE_KEY) === "backup") setTab("backup");
      } catch {
        /* 隐私模式等场景忽略 */
      }
      fetch("/api/micro-light/config", { cache: "no-store" })
        .then((res) => res.json())
        .then((json) => {
          if (json?.code === 0) setMlEnabled(Boolean(json.data?.enabled));
        })
        .catch(() => {
          /* 状态图标失败不影响页面 */
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const switchTab = (next: Tab) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      /* 隐私模式等场景忽略 */
    }
  };

  return (
    <main
      className="min-h-screen text-[#221d24]"
      style={{
        background:
          "radial-gradient(1100px 600px at 10% -10%, rgba(255,170,150,0.34), transparent 60%), radial-gradient(900px 600px at 100% 0%, rgba(150,190,255,0.3), transparent 55%), #ece4e8",
      }}
    >
      <div className="mx-auto w-full max-w-3xl px-3 pb-20 pt-8 sm:px-6 sm:pt-10">
        {/* ===== 功能切换按钮组：标题文字样式 + 胶囊底色 ===== */}
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-1 rounded-full border border-black/[0.06] bg-white/65 p-1 shadow-[0_12px_32px_-26px_rgba(40,20,50,0.7)] backdrop-blur">
            {(["fee", "backup"] as const).map((key) => {
              const active = tab === key;
              const style = TAB_STYLE[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchTab(key)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-full px-4 py-1.5 transition sm:px-5 ${
                    active
                      ? "bg-white shadow-[0_6px_18px_-14px_rgba(40,20,50,0.6)]"
                      : "hover:bg-white/60"
                  }`}
                >
                  <span
                    className={`bg-gradient-to-br bg-clip-text text-[24px] font-semibold leading-tight tracking-tight text-transparent sm:text-[28px] ${style.gradient} ${
                      active ? "opacity-100" : "opacity-40"
                    }`}
                  >
                    {style.label}
                  </span>
                  {key === "backup" && <BackupStatusIcon enabled={mlEnabled} />}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-7">
          {tab === "fee" ? <MedicalFeeDashboard /> : <MicroLightDashboard />}
        </div>
      </div>
    </main>
  );
}
