"use client";

import { useEffect, useState } from "react";
import { subscribeToast } from "@/lib/toast";

/**
 * 全局轻提示宿主
 * 在布局中挂载一次，任何地方调用 showToast() 都会在此弹出
 * 会自动消失的简短提示（黑底白字胶囊）。
 */
export default function ToastHost() {
  const [msg, setMsg] = useState("");
  const [visible, setVisible] = useState(false);
  const timerRef: { current: number | null } = { current: null };

  useEffect(() => {
    const unsub = subscribeToast((message) => {
      setMsg(message);
      setVisible(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setVisible(false), 1800);
    });
    return () => {
      unsub();
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      className="fixed left-1/2 top-16 -translate-x-1/2 z-[99999] pointer-events-none transition-opacity duration-200"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {msg && (
        <div className="rounded-full bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
          {msg}
        </div>
      )}
    </div>
  );
}