"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityPageProps } from "../types";
import { buildActivityUrl } from "../types";
import { STONE_GONGFANG } from "./config";
import { mockDraw, mockReplace, mockCompose, slotTotal } from "./mockApi";
import type { SlotState } from "./mockApi";
import type { ActivityGiftInfo } from "../mock/types";

/** 强制设置安全区 CSS 变量（业务组件先于 SafeAreaStyler 挂载时兜底） */
function ensureSafeVars() {
  if (typeof document === "undefined") return;
  const doc = document.documentElement;
  if (!doc.style.getPropertyValue("--safe-top")) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isTauri = "__TAURI_INTERNALS__" in window;
    if (isTauri && isIOS) {
      doc.style.setProperty("--safe-top", "calc(env(safe-area-inset-top, 47px) - 3px)");
      doc.style.setProperty("--safe-bottom", "env(safe-area-inset-bottom, 34px)");
    } else if (isTauri) {
      doc.style.setProperty("--safe-top", "env(safe-area-inset-top, 24px)");
      doc.style.setProperty("--safe-bottom", "env(safe-area-inset-bottom, 16px)");
    } else if (isIOS) {
      doc.style.setProperty("--safe-top", "env(safe-area-inset-top, 24px)");
      doc.style.setProperty("--safe-bottom", "env(safe-area-inset-bottom, 16px)");
    }
  }
}

/** 解析接口返回的 slot_info 字符串 -> 槽位状态 */
function parseSlotInfo(str: string): SlotState {
  try {
    return JSON.parse(str) as SlotState;
  } catch {
    return {};
  }
}

/** 材料数值 -> 图标配色（越高越珍贵） */
function slotColor(v: number): string {
  if (v >= 7) return "from-amber-400 to-yellow-600";
  if (v >= 6) return "from-pink-400 to-rose-600";
  if (v >= 5) return "from-purple-400 to-violet-600";
  if (v >= 4) return "from-blue-400 to-indigo-600";
  if (v >= 3) return "from-cyan-400 to-teal-600";
  return "from-slate-400 to-slate-600";
}

const INIT_BALANCE = 100000; // 模拟电池余额

function StoneGongfangPage({ config, onBack, userName = "我" }: ActivityPageProps) {
  // 组件挂载时提前确保安全区变量已设置（比 SafeAreaStyler 的 useEffect 更早）
  ensureSafeVars();
  const [slots, setSlots] = useState<SlotState>(() => {
    const s: SlotState = {};
    for (let i = 1; i <= STONE_GONGFANG.slotCount; i++) {
      s[String(i)] = 1 + Math.floor(Math.random() * 4); // 初始 1~4
    }
    return s;
  });
  const [balance, setBalance] = useState(INIT_BALANCE);
  const [carousel, setCarousel] = useState<string[]>(STONE_GONGFANG.carousel_pool.slice(0, 5));
  const [changedSlot, setChangedSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // draw/replace/compose
  const [composeResult, setComposeResult] = useState<ActivityGiftInfo | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // 对比新槽位，找出发生变化的槽位用于高亮
  const diffSlot = (prev: SlotState, next: SlotState): number | null => {
    for (let i = 1; i <= STONE_GONGFANG.slotCount; i++) {
      if ((prev[String(i)] ?? 0) !== (next[String(i)] ?? 0)) return i;
    }
    return null;
  };

  const handleDraw = useCallback(async () => {
    if (busy) return;
    if (balance < STONE_GONGFANG.draw_price) {
      showToast("电池不足，无法抽取");
      return;
    }
    setBusy("draw");
    // 模拟网络请求耗时
    await new Promise((r) => setTimeout(r, 500));
    const prev = { ...slots };
    const res = mockDraw(prev);
    setSlots(parseSlotInfo(res.data.slot_info));
    setChangedSlot(diffSlot(slots, parseSlotInfo(res.data.slot_info)));
    setCarousel(res.data.carousel_list);
    setBalance((b) => b - STONE_GONGFANG.draw_price);
    setBusy(null);
  }, [busy, balance, slots, showToast]);

  const handleReplace = useCallback(async () => {
    if (busy) return;
    if (balance < STONE_GONGFANG.replace_price) {
      showToast("电池不足，无法替换");
      return;
    }
    setBusy("replace");
    await new Promise((r) => setTimeout(r, 500));
    const prev = { ...slots };
    const res = mockReplace(prev);
    setSlots(parseSlotInfo(res.data.slot_info));
    setChangedSlot(diffSlot(slots, parseSlotInfo(res.data.slot_info)));
    setCarousel(res.data.carousel_list);
    setBalance((b) => b - STONE_GONGFANG.replace_price);
    setBusy(null);
  }, [busy, balance, slots, showToast]);

  const handleCompose = useCallback(async () => {
    if (busy) return;
    setBusy("compose");
    await new Promise((r) => setTimeout(r, 600));
    const res = mockCompose({ ...slots });
    setComposeResult(res.data.gift_info);
    setBusy(null);
  }, [busy, slots]);

  // ==================== iframe 模式（原生客户端：原生层拦截 mock） ====================
  if (config.mode === "iframe") {
    return (
      <div className="fixed inset-0 z-[70] bg-black flex flex-col" style={{ maxWidth: "var(--page-max-width)", margin: "0 auto", paddingTop: "var(--safe-top, 0px)", paddingBottom: "var(--safe-bottom, 0px)" }}>
        <div className="relative flex items-center px-3 h-11 bg-black/80 z-10">
          <button onClick={onBack} className="text-white/90 text-xl leading-none p-1">
            ‹
          </button>
          <span className="ml-2 text-white text-sm font-medium">{config.title}</span>
          <span className="ml-auto text-white/40 text-[10px]">
            room_id:{config.params.roomId} uid:{config.params.uid}
          </span>
        </div>
        <iframe
          src={buildActivityUrl(config)}
          className="flex-1 w-full border-0"
          allow="autoplay; fullscreen"
          title={config.title}
        />
      </div>
    );
  }

  // ==================== 复刻模式（浏览器 demo，走本地 mock） ====================
  const total = slotTotal(slots);

  return (
    <div className="fixed inset-0 z-[70] bg-[#1c1530] flex flex-col overflow-hidden" style={{ maxWidth: "var(--page-max-width)", margin: "0 auto", paddingTop: "var(--safe-top, 0px)", paddingBottom: "var(--safe-bottom, 0px)" }}>
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
        .animate-marquee { animation: marquee 18s linear infinite; }
      `}</style>
      {/* 顶部栏 */}
      <div className="relative flex items-center px-3 h-11 shrink-0 bg-gradient-to-b from-black/60 to-transparent">
        <button onClick={onBack} className="text-white/90 text-xl leading-none p-1">‹</button>
        <span className="ml-2 text-white text-sm font-bold">{config.title}</span>
        <span className="ml-2 text-white/40 text-[10px]">（模拟·不扣费）</span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-amber-300 text-xs font-bold">{balance.toLocaleString()}</span>
          <span className="text-white/50 text-[10px]">电池</span>
        </div>
      </div>

      {/* 参数信息条 */}
      <div className="shrink-0 px-3 py-1 flex items-center gap-3 text-white/40 text-[10px]">
        <span>房间 {config.params.roomId}</span>
        <span>主播 uid {config.params.uid}</span>
        <span className="ml-auto">
          {new Date(STONE_GONGFANG.start_time * 1000).toLocaleDateString()} -{" "}
          {new Date(STONE_GONGFANG.end_time * 1000).toLocaleDateString()}
        </span>
      </div>

      {/* 滚动中奖消息 */}
      <div className="shrink-0 mx-3 mt-1 h-6 rounded-full bg-white/5 flex items-center px-3 overflow-hidden">
        <span className="text-amber-300 text-[10px] mr-2 shrink-0">🎉</span>
        <div className="flex-1 overflow-hidden">
          <div className="whitespace-nowrap animate-marquee text-white/60 text-[10px] leading-6">
            {carousel.join("　·　")}
          </div>
        </div>
      </div>

      {/* 6 槽位 */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: STONE_GONGFANG.slotCount }, (_, i) => {
            const n = i + 1;
            const v = slots[String(n)] ?? 0;
            const isChanged = changedSlot === n;
            return (
              <div
                key={n}
                className={`relative rounded-xl overflow-hidden transition-all duration-300 ${
                  isChanged ? "ring-2 ring-amber-300 scale-105" : ""
                }`}
              >
                <div className={`bg-gradient-to-br ${slotColor(v)} aspect-square flex flex-col items-center justify-center`}>
                  <span className="text-white text-2xl font-bold drop-shadow">{v}</span>
                  <span className="text-white/70 text-[10px]">材料</span>
                </div>
                <div className="bg-black/40 text-white/60 text-[10px] text-center py-0.5">
                  槽位 {n}
                </div>
              </div>
            );
          })}
        </div>

        {/* 总值提示 */}
        <div className="mt-3 rounded-lg bg-white/5 px-3 py-2 flex items-center justify-between">
          <span className="text-white/60 text-xs">材料总值</span>
          <span className="text-amber-300 text-sm font-bold">{total}</span>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="shrink-0 px-3 pb-4 pt-2 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex gap-2">
          <button
            onClick={handleDraw}
            disabled={!!busy}
            className="flex-1 h-11 rounded-lg bg-gradient-to-r from-pink-500 to-rose-600 text-white text-sm font-bold active:opacity-80 disabled:opacity-50"
          >
            {busy === "draw" ? "抽取中…" : `抽取 ${STONE_GONGFANG.draw_price}`}
          </button>
          <button
            onClick={handleReplace}
            disabled={!!busy}
            className="flex-1 h-11 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-bold active:opacity-80 disabled:opacity-50"
          >
            {busy === "replace" ? "替换中…" : `替换 ${STONE_GONGFANG.replace_price}`}
          </button>
          <button
            onClick={handleCompose}
            disabled={!!busy}
            className="flex-1 h-11 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 text-white text-sm font-bold active:opacity-80 disabled:opacity-50"
          >
            {busy === "compose" ? "合成中…" : "合成"}
          </button>
        </div>
        <p className="text-center text-white/30 text-[10px] mt-1.5">
          抽取/替换消耗电池，合成按槽位总值出礼物（本地模拟，不产生任何真实交易）
        </p>
      </div>

      {/* toast */}
      {toast && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-white/90 text-black text-xs px-3 py-1.5 rounded-full shadow z-10">
          {toast}
        </div>
      )}

      {/* 合成结果弹窗 */}
      {composeResult && (
        <div className="absolute inset-0 z-20 bg-black/60 flex items-center justify-center p-6" onClick={() => setComposeResult(null)}>
          <div className="w-full max-w-xs bg-[#2b2140] rounded-2xl p-5 text-center shadow-2xl">
            <div className="text-amber-300 text-sm font-bold mb-1">恭喜合成成功</div>
            <img
              src={composeResult.gift_img}
              alt={composeResult.gift_name}
              className="w-20 h-20 mx-auto my-3 rounded-xl object-contain bg-black/30"
            />
            <div className="text-white text-base font-bold">{composeResult.gift_name}</div>
            <div className="text-amber-300 text-sm mt-1">
              {(composeResult.gift_price / 100).toLocaleString()} 电池
            </div>
            <button
              onClick={() => setComposeResult(null)}
              className="mt-4 w-full h-10 rounded-lg bg-gradient-to-r from-pink-500 to-rose-600 text-white text-sm font-bold"
            >
              收下礼物
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default StoneGongfangPage;
