"use client";

import { useEffect, useState } from "react";
import LeaderboardViewer, { type LeaderboardBoardMode } from "@/components/LeaderboardViewer";

export type LeaderboardUploadResult = { ok: boolean; at?: number };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 上传时间提示：小时:分钟 */
function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 「全站黑白榜」入口：粉丝页与主播页共用的同一样式链接。
 * 点击后在软件内以全屏 iframe 打开 /hbb，并按入口定位到对应榜单。
 *
 * 上传：
 * - 提供 upload 时，右侧显示「上传」按钮与最近一次上传时间（HH:MM）；
 * - 点击进入榜单时先自动上传一次，期间全屏提示「正在上传自己的数据···」，
 *   上传完成后再挂载榜单页面，确保看到的是自己最新的排名数据；
 * - 不提供 upload（如主播页在手机/Web 端）时按钮置灰并显示 uploadDisabledHint，
 *   且进入榜单不触发上传。
 */
export default function LeaderboardLink({
  mode,
  className = "",
  upload,
  uploadDisabledHint,
  uploadKey,
}: {
  mode: LeaderboardBoardMode;
  className?: string;
  /** 执行一次上传；未提供表示该端不支持上传 */
  upload?: () => Promise<LeaderboardUploadResult>;
  /** 不支持上传时的置灰提示文案（如「仅限电脑端」） */
  uploadDisabledHint?: string;
  /** 上传时间持久化的键（区分账号/入口） */
  uploadKey?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "uploading" | "viewer">("idle");
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const storageKey = `bili_live_lb_upload:${uploadKey ?? mode}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const n = Number(raw);
      // 挂载后从本地读取上次上传时间，避免 SSR/客户端首帧不一致
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (Number.isFinite(n) && n > 0) setLastAt(n);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [storageKey]);

  const rememberTime = (at: number) => {
    setLastAt(at);
    try {
      localStorage.setItem(storageKey, String(at));
    } catch {
      /* 忽略 */
    }
  };

  const runUpload = async (): Promise<boolean> => {
    if (!upload || busy) return false;
    setBusy(true);
    try {
      const r = await upload();
      if (r?.ok && r.at) {
        rememberTime(r.at);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openViewer = async () => {
    if (!upload) {
      setPhase("viewer");
      return;
    }
    setPhase("uploading");
    await runUpload();
    setPhase("viewer");
  };

  const disabled = !upload || busy;
  const hint = uploadDisabledHint
    ? uploadDisabledHint
    : busy
      ? "正在上传…"
      : lastAt
        ? `上传于 ${hhmm(lastAt)}`
        : "未上传";

  return (
    <>
      <div
        className={`mt-3 rounded-2xl border border-black/10 bg-white/70 px-3 py-2.5 shadow-[0_8px_24px_rgba(31,28,23,0.06)] backdrop-blur ${className}`}
      >
        <div className="grid w-full grid-cols-2 items-center gap-2">
          <div className="flex justify-center">
            <button
              type="button"
              onClick={openViewer}
              className="flex items-center justify-center rounded-full border border-[#dcc084] bg-gradient-to-r from-[#f3e1b2] to-[#ead08f] px-4 py-1.5 text-[13px] font-semibold text-[#4b3a16] transition hover:from-[#efd9a3] hover:to-[#e3c47c] hover:text-[#33270d] active:scale-[0.99]"
            >
              👑全站黑白榜👻
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              onClick={() => void runUpload()}
              disabled={disabled}
              title={uploadDisabledHint || undefined}
              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition ${
                disabled
                  ? "cursor-not-allowed bg-gray-200 text-gray-400"
                  : "bg-[#5b3fa8] text-white hover:bg-[#4a2f92] active:scale-95"
              }`}
            >
              上传
            </button>
            <span
              className={`whitespace-nowrap text-[11px] ${
                uploadDisabledHint ? "text-black/30" : busy ? "text-[#5b3fa8]" : "text-black/40"
              }`}
            >
              {hint}
            </span>
          </div>
        </div>
      </div>

      {phase === "uploading" && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="rounded-2xl border border-black/10 bg-white px-8 py-6 text-center shadow-2xl">
            <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-[#5b3fa8]/25 border-t-[#5b3fa8]" />
            <div className="text-[14px] font-semibold text-[#221d24]">正在上传自己的数据···</div>
            <div className="mt-1 text-[11px] text-black/40">上传完成后将自动打开最新黑白榜</div>
          </div>
        </div>
      )}

      {phase === "viewer" && <LeaderboardViewer mode={mode} onBack={() => setPhase("idle")} />}
    </>
  );
}
