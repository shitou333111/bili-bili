"use client";

/**
 * 合成活动"黑抽"模态框
 *
 * 用户输入主播 UID → 查询主播昵称 → 风险确认 → 打开真实 B站 活动页面。
 *
 * 与模拟器完全独立：
 * - 不注入 mock-shim，不拦截任何请求
 * - 使用当前登录账号的 Cookie（WebView 共享 Cookie）
 * - 真实消费、真实交易
 * - 标题栏带返回按钮（点击通过 Tauri IPC 调用 close_real_activity_panel 关闭）
 */

import { useState, useEffect, useCallback } from "react";
import { getStreamerInfoByUid, type StreamerInfo } from "./bili-simulator/liveStream";
import { getPlatform } from "@/lib/platform";
import { ensureValidCredentialClient } from "@/lib/bilibili/cookie-refresh-client";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 活动页 URL 模板，使用 {room_id} 和 {uid} 占位符；由 admin 页面配置 */
  activityUrlTemplate?: string;
}

export default function RealActivityModal({ isOpen, onClose, activityUrlTemplate }: Props) {
  const [uidInput, setUidInput] = useState("");
  const [streamer, setStreamer] = useState<StreamerInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"input" | "confirm">("input");

  // 打开时重置状态
  useEffect(() => {
    if (isOpen) {
      setUidInput("");
      setStreamer(null);
      setError("");
      setPhase("input");
    }
  }, [isOpen]);

  const handleQuery = useCallback(async () => {
    if (!uidInput.trim()) return;
    setLoading(true);
    setError("");
    try {
      const info = await getStreamerInfoByUid(Number(uidInput.trim()));
      setStreamer(info);
      setPhase("confirm");
    } catch (e: any) {
      setError(e?.message || "查询失败");
    } finally {
      setLoading(false);
    }
  }, [uidInput]);

  const handleConfirm = useCallback(async () => {
    if (!streamer) return;
    if (!activityUrlTemplate) {
      setError("管理员暂未配置黑抽活动地址");
      return;
    }
    const url = activityUrlTemplate
      .replace("{room_id}", String(streamer.roomId))
      .replace("{uid}", String(streamer.uid));
    try {
      // 取出当前登录账号的 B站 Cookie 注入真实活动 WebView，实现自动登录
      const platform = await getPlatform();
      const state = await platform.getSessionState();
      let currentSession = state.sessions.find((s: any) => s.sid === state.currentSid);
      if (!currentSession) {
        setError("未找到当前登录账号，请先登录后再打开");
        return;
      }
      // 复用项目统一的凭证校验/刷新：黑抽页面的 csrf 直接取自 bili_jct，
      // 登录久了服务端会轮换 bili_jct，用旧 token 必然报 csrf 校验失败。
      const cred = await ensureValidCredentialClient(platform, currentSession);
      if (!cred.valid) {
        setError(cred.reason ? `登录凭证已失效（${cred.reason}），请重新登录` : "登录凭证已失效，请重新登录");
        return;
      }
      currentSession = cred.session;
      // 按 Cookie 名去重：biliCookies 里可能残留旧值，SESSDATA 以会话字段为准
      const cookieMap = new Map<string, string>();
      for (const raw of currentSession.biliCookies ?? []) {
        const idx = raw.indexOf("=");
        if (idx <= 0) continue;
        cookieMap.set(raw.slice(0, idx), raw.slice(idx + 1));
      }
      if (currentSession.biliSessdata) {
        cookieMap.set("SESSDATA", currentSession.biliSessdata);
      }
      const cookies = Array.from(cookieMap, ([name, value]) => `${name}=${value}`);
      // 黑抽的抽取/付款请求都在 payload 里带 csrf，必须与服务端登录态中的 bili_jct 一致
      if (!cookieMap.get("bili_jct")) {
        setError("当前登录状态缺少 CSRF 凭证（bili_jct），请退出账号后重新扫码登录");
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_real_activity_panel", {
        config: { url, title: "真实合成活动", cookies },
      });
      onClose();
    } catch (e: any) {
      setError(e?.message || "打开活动页面失败");
    }
  }, [streamer, onClose, activityUrlTemplate]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部警示条 */}
        <div className="bg-gradient-to-r from-red-500 to-orange-500 px-5 py-3 flex items-center justify-center gap-2">
          <span className="text-white text-lg">⚠️</span>
          <span className="text-white font-bold text-sm">风险警告 · 真实消费</span>
        </div>

        <div className="p-5">
          {phase === "input" && (
            <>
              <p className="text-sm text-black/70 mb-4">
                输入主播 UID，查询主播信息后确认风险即可进入真实活动页面。
              </p>
              <div className="flex gap-2 mb-3">
                <input
                  type="number"
                  value={uidInput}
                  onChange={(e) => setUidInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && uidInput.trim() && !loading) handleQuery();
                  }}
                  placeholder="输入主播 UID"
                  className="flex-1 px-3 py-2.5 rounded-lg border border-black/10 bg-gray-50 text-sm text-black/80 focus:outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 transition-all"
                  autoFocus
                />
                <button
                  onClick={handleQuery}
                  disabled={!uidInput.trim() || loading}
                  className="px-4 py-2.5 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 active:scale-95 transition disabled:opacity-50"
                >
                  {loading ? "查询中..." : "查询"}
                </button>
              </div>
              {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
              <button
                onClick={onClose}
                className="w-full py-2.5 rounded-lg bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition"
              >
                取消
              </button>
            </>
          )}

          {phase === "confirm" && streamer && (
            <>
              {/* 主播信息 */}
              <div className="flex items-center gap-3 mb-4 p-3 bg-gray-50 rounded-lg">
                {streamer.face ? (
                  <img src={streamer.face} alt="" className="w-10 h-10 rounded-full object-cover" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-lg">👤</div>
                )}
                <div>
                  <div className="text-sm font-bold text-black/80">{streamer.uname}</div>
                  <div className="text-xs text-black/40 leading-relaxed">UID: {streamer.uid}<br />房间号: {streamer.roomId}</div>
                </div>
              </div>

              {/* 风险提示 */}
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                <p className="text-xs text-red-700 leading-relaxed">
                  你确定要为<span className="font-bold">{streamer.uname}</span>玩合成活动吗？
                  <br />
                  <span className="text-red-600">这不是模拟！</span>
                  本页面完全就是 B站 活动页面的直接引用，你花费的电池都是真实的。
                  这个页面唯一的作用就是，当主播没开播、直播间不显示活动入口时，你要为主播"黑抽"的情况。
                </p>
              </div>

              {/* 按钮组 */}
              <div className="flex gap-3">
                <button
                  onClick={onClose}
                  className="flex-1 py-2.5 rounded-lg bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition"
                >
                  取消
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-1 py-2.5 rounded-lg bg-red-500 text-white text-sm font-bold hover:bg-red-600 active:scale-95 transition"
                >
                  已确认风险
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
