"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { serverFetch, serverPost } from "@/lib/server-api";

/** 抽奖记录（与服务器 /lib/lottery.ts 保持一致） */
type LotteryRecord = {
  mid: number;
  uname: string;
  drawnAt: string;
  won: boolean;
  prize: string;
  odds: string;
  rewardGranted: boolean;
};

/**
 * 抽奖页面：允许登录账号抽奖（中奖率以服务器当前配置为准，奖品为一个月舰长）。
 * - 概率由服务器下发（admin 可调整，所有平台读取同一份），未抽奖时展示当前概率。
 * - 每个用户只能抽取一次，服务器按 mid 持久化；已抽奖的用户可长期查看自己的抽奖结果。
 * - 中奖用户可看到奖品发放状态（未发放/已发放，admin 标记，避免重复发放）。
 * - 服务器账号（source=server）不可抽奖，入口已在帮助页置灰；此处兜底展示禁用提示。
 */
export default function LotteryPage({
  mid,
  uname,
  isServerAccount = false,
  onBack,
}: {
  mid: number;
  uname: string;
  isServerAccount?: boolean;
  onBack: () => void;
}) {
  const [record, setRecord] = useState<LotteryRecord | null>(null);
  const [oddsDenom, setOddsDenom] = useState(20);
  // 活动开关：false 时抽奖暂停（可打开页面查看，但不可抽奖）
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState("");
  // 抽奖进行中的短暂延迟，让"开奖"有仪式感
  const [revealing, setRevealing] = useState(false);

  const loadedRef = useRef(false);

  const loadRecord = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    try {
      const data = await serverFetch<{
        code: number;
        data?: { drawn: boolean; record: LotteryRecord | null; config?: { oddsDenom: number; enabled: boolean } };
      }>(`/api/lottery/records?mid=${encodeURIComponent(String(mid))}`);
      if (data.code === 0 && data.data) {
        if (data.data.config?.oddsDenom) setOddsDenom(data.data.config.oddsDenom);
        if (typeof data.data.config?.enabled === "boolean") setEnabled(data.data.config.enabled);
        if (data.data.record) setRecord(data.data.record);
      }
    } catch {
      // 网络失败时静默进入"未抽奖"状态，抽奖时会再报错
    } finally {
      setLoading(false);
    }
  }, [mid]);

  useEffect(() => {
    loadRecord();
  }, [loadRecord]);

  const handleDraw = async () => {
    if (drawing || record || isServerAccount) return;
    // 活动暂停：禁止抽奖（防御：即使前端状态未同步到，服务器也会拒绝）
    if (!enabled) {
      setError("不好意思，抽奖活动当前已暂停");
      return;
    }
    setDrawing(true);
    setError("");
    // 先展示约 800ms 的"开奖中"动画，再请求结果
    setRevealing(true);
    try {
      const [result] = await Promise.all([
        serverPost<{ code: number; data?: { record: LotteryRecord; alreadyDrawn: boolean }; message?: string }>(
          "/api/lottery/draw",
          { mid, uname },
        ),
        new Promise((r) => setTimeout(r, 800)),
      ]);
      if (result.code === 0 && result.data?.record) {
        setRecord(result.data.record);
      } else {
        setError(result?.message || "抽奖失败，请稍后重试");
      }
    } catch {
      setError("网络异常，请检查网络后重试");
    } finally {
      setDrawing(false);
      setRevealing(false);
    }
  };

  const drawn = !!record;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#faf9f6]">
      {/* 顶栏 */}
      <div
        className="flex items-center gap-3 px-3 pb-2 border-b border-black/5 bg-white/90 backdrop-blur"
        style={{ paddingTop: "calc(var(--safe-top, 0px) + 8px)" }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 -ml-1 text-sm text-black/60 hover:bg-black/5 hover:text-black/90 transition active:scale-95"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>
        <span className="text-sm font-semibold">抽奖</span>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-5 pb-8">
        {isServerAccount ? (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4">
            <div className="text-5xl opacity-30">🎟️</div>
            <div className="text-sm text-black/40 text-center leading-relaxed">
              服务器账号无登录凭证，无法参与抽奖
            </div>
          </div>
        ) : loading ? (
          <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-black/10 border-t-black/50" />
            <div className="text-xs text-black/40">正在加载抽奖状态…</div>
          </div>
        ) : (
          <div className="max-w-sm mx-auto mt-6 flex flex-col items-center">
            {/* 当前用户 */}
            <div className="text-xs text-black/40">当前账号：{uname}</div>

            {/* 已抽奖：长期查看自己的结果 */}
            {drawn && record ? (
              <div className="mt-8 w-full">
                <div
                  className={`rounded-2xl border p-6 text-center shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur ${
                    record.won
                      ? "border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50"
                      : "border-black/10 bg-white/80"
                  }`}
                >
                  <div className={`text-5xl ${record.won ? "" : "opacity-70"}`}>{record.won ? "🎉" : "😢"}</div>
                  <div className={`mt-3 text-base font-bold ${record.won ? "text-amber-700" : "text-black/70"}`}>
                    {record.won ? "恭喜中奖！" : "很遗憾，未中奖"}
                  </div>
                  {record.won ? (
                    <>
                      <p className="mt-1.5 text-sm text-amber-600/90">
                        获得 {record.prize}（{new Date(record.drawnAt).toLocaleString("zh-CN")}）
                      </p>
                      {/* 发放状态：仅中奖用户可见（admin 标记发放，避免重复发放） */}
                      <span
                        className={`mt-3 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                          record.rewardGranted
                            ? "border-green-200 bg-green-50 text-green-600"
                            : "border-amber-200 bg-amber-50 text-amber-600"
                        }`}
                      >
                        {record.rewardGranted ? "✅ 奖品已发放" : "⏳ 奖品待发放"}
                      </span>
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-black/45">
                      未中奖（{new Date(record.drawnAt).toLocaleString("zh-CN")}），再接再厉
                    </p>
                  )}
                  <p className="mt-3 text-[10px] text-black/30">本次抽奖概率 {record.odds}</p>
                </div>
                <p className="mt-4 text-center text-xs text-black/30">每个用户只能抽取一次，以上为你的抽奖结果</p>
              </div>
            ) : enabled ? (
              /* 未抽奖且活动开启：展示规则与抽奖按钮 */
              <>
                <div className="mt-8 w-full rounded-2xl border border-black/10 bg-white/80 p-5 text-center shadow-[0_20px_80px_rgba(31,28,23,0.06)] backdrop-blur">
                  <div className="text-xs text-black/50 leading-relaxed">
                    中奖率 <b className="text-black/80">1/{oddsDenom}</b>，奖品为 <b className="text-black/80">一个月舰长</b>
                    <br />
                    每个用户只能抽取一次
                  </div>
                </div>

                <button
                  onClick={handleDraw}
                  disabled={drawing || revealing}
                  className={`mt-10 w-36 h-36 rounded-full flex flex-col items-center justify-center text-white shadow-lg transition active:scale-95 disabled:opacity-80 ${
                    drawing || revealing
                      ? "bg-gradient-to-br from-slate-400 to-slate-500"
                      : "bg-gradient-to-br from-[#f6b93b] to-[#e58e26] hover:shadow-xl hover:brightness-105"
                  }`}
                >
                  {drawing || revealing ? (
                    <>
                      <span className="animate-spin text-3xl leading-none">↻</span>
                      <span className="mt-1 text-xs font-medium">开奖中…</span>
                    </>
                  ) : (
                    <>
                      <span className="text-3xl leading-none">🎟️</span>
                      <span className="mt-1 text-base font-semibold">立即抽奖</span>
                    </>
                  )}
                </button>
                <p className="mt-4 text-xs text-black/35">点击抽奖，即开即中</p>
              </>
            ) : (
              /* 未抽奖且活动暂停：可打开查看，但不可抽奖 */
              <div className="mt-8 w-full rounded-2xl border border-black/10 bg-white/80 p-6 text-center shadow-[0_20px_80px_rgba(31,28,23,0.06)] backdrop-blur">
                <div className="text-4xl opacity-60">⏸️</div>
                <div className="mt-3 text-sm font-bold text-black/60">抽奖活动当前已暂停</div>
                <p className="mt-1.5 text-xs text-black/40 leading-relaxed">
                  不好意思，抽奖活动当前已暂停<br />
                  请耐心等待活动重新开启
                </p>
              </div>
            )}

            {/* 错误提示 */}
            {error && (
              <div className="mt-5 w-full rounded-lg border border-red-200 bg-red-50 p-3 text-center text-xs text-red-600">
                {error}
              </div>
            )}

            {/* 提醒文案 */}
            <div className="mt-8 w-full rounded-xl border border-black/5 bg-white/50 p-4 text-[11px] leading-relaxed text-black/45">
              <p>
                本软件是免费软件，开发者也是贫困户😭，抽奖只是给使用者一点娱乐，所以奖品价值和中奖率并不会很高。
                如果有人通过批量账号抽奖来作弊，那么无法兑换奖品，甚至还会导致其他正常中奖用户无法兑奖（因为很难分辨哪些是作弊）。
                中奖概率会根据情况调整，比如后期如果使用人数很多，那么概率肯定要调低。不过当前显示的概率就是真实的概率。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
