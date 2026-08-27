"use client";

import { useEffect, useState } from "react";
import { checkForUpdates } from "@/lib/updater";
import { isTauriProduction } from "@/lib/server-api";

/**
 * 临时诊断徽标：在屏幕角落常驻显示当前内置前端资源的序列号，以及热更新链路诊断结果。
 * 用途：验证热更新链路——生产 Tauri 包打不开 DevTools，用屏上文字确认
 *   1. 代码确实在运行（徽标常驻 = 已加载）
 *   2. 内置 sequence（NEXT_PUBLIC_BUILD_SEQ）
 *   3. 热更新插件检测到的服务器 sequence / 是否可用 / 错误 / Tauri 生产判定
 * 验证完毕可移除本组件。
 */
interface Diag {
  builtin: number;
  tauriProd: boolean;
  available: boolean | null;
  sequence: number | null;
  error: string | null;
  running: boolean;
}

export default function BuildStampBadge() {
  const [diag, setDiag] = useState<Diag>({
    builtin: Number(process.env.NEXT_PUBLIC_BUILD_SEQ) || 0,
    tauriProd: false,
    available: null,
    sequence: null,
    error: null,
    running: false,
  });

  useEffect(() => {
    let cancelled = false;
    // 挂载后异步执行热更新检查并把结果渲染到屏上
    (async () => {
      try {
        setDiag((d) => ({ ...d, tauriProd: isTauriProduction(), running: true }));
        const res = await checkForUpdates();
        if (cancelled) return;
        setDiag((d) => ({
          ...d,
          available: res.hot?.available ?? false,
          sequence: res.hot?.sequence ?? null,
          error: res.hot?.error ?? null,
          running: false,
        }));
      } catch (e) {
        if (cancelled) return;
        setDiag((d) => ({
          ...d,
          available: false,
          error: e instanceof Error ? e.message : String(e),
          running: false,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        right: 8,
        bottom: 8,
        zIndex: 99999,
        background: "rgba(0,0,0,0.7)",
        color: "#7CFC00",
        fontSize: 11,
        padding: "4px 8px",
        borderRadius: 4,
        fontFamily: "monospace",
        pointerEvents: "none",
        textAlign: "left",
        whiteSpace: "pre",
        lineHeight: 1.4,
        maxWidth: "60vw",
        overflow: "hidden",
      }}
    >
      {`HOT-BUILD:${diag.builtin}
TAURI-PROD:${diag.tauriProd ? "YES" : "no"}
${diag.running ? "checking..." : diag.available === null ? "idle" : `HOT-AVAIL:${diag.available ? "YES" : "no"}`}
${diag.sequence !== null ? `HOT-SEQ:${diag.sequence}` : ""}
${diag.error ? `HOT-ERR:${diag.error}` : ""}`}
    </div>
  );
}