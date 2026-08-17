"use client";

import { useState, useEffect, useCallback } from "react";
import { dataFetch } from "@/lib/client-fetch";
import { serverPost } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";
import { showToast } from "@/lib/toast";

type AnchorItem = {
  uid: number;
  uname: string;
  face?: string;
  room_id: number;
  click_count?: number;
};

function fixImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

/**
 * 打开B站直播间：
 * - 优先用 bilibili://live/{roomId} 协议唤起B站APP
 * - 失败则 fallback 到 WebView / 浏览器打开 https://live.bilibili.com/{roomId}
 */
async function openBiliLiveRoom(roomId: number) {
  if (!roomId) {
    showToast("房间号无效");
    return;
  }
  const platform = await getPlatform();
  const appScheme = `bilibili://live/${roomId}`;
  const webUrl = `https://live.bilibili.com/${roomId}`;

  if (platform.isNative) {
    // Tauri 2.x 用 @tauri-apps/plugin-opener 的 open 函数打开外部链接/协议
    let opened = false;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      try {
        // 先尝试 APP 协议唤起 B站 APP
        await openUrl(appScheme);
        opened = true;
      } catch {
        try {
          // 协议唤起失败：用浏览器打开网页版
          await openUrl(webUrl);
          opened = true;
        } catch { /* ignore */ }
      }
    } catch { /* plugin-opener 不可用，降级到 window.open */ }
    if (opened) return;
  }

  // Web / 降级方案：尝试新建窗口打开协议链接（大部分移动端浏览器会自动唤起APP）
  try {
    const schemeWin = window.open(appScheme, "_blank");
    // 如果协议打不开，1秒后 fallback 到网页版
    setTimeout(() => {
      try {
        if (schemeWin) {
          schemeWin.location.href = webUrl;
        }
      } catch { /* ignore cross-origin */ }
    }, 1200);
  } catch {
    window.open(webUrl, "_blank");
  }
}

export default function RecommendedAnchors() {
  const [anchors, setAnchors] = useState<AnchorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showTipModal, setShowTipModal] = useState(false);

  const loadAnchors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await dataFetch("/api/recommended-anchors", { cache: "no-store" });
      const data = await res.json();
      if (data.code === 0 && Array.isArray(data.data)) {
        setAnchors(data.data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAnchors();
  }, [loadAnchors]);

  return (
    <>
      <div className="rounded-xl border border-black/10 bg-white/80 p-5 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
        {/* 标题栏 */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-3xl">✨</span>
          <h3 className="text-base font-bold">主播推荐</h3>
          {/* 提示图标 */}
          <button
            onClick={() => setShowTipModal(true)}
            onMouseEnter={(e) => {
              // 桌面端 hover 不弹模态，避免频繁弹出；统一用点击触发
            }}
            className="relative w-5 h-5 rounded-full bg-black/5 flex items-center justify-center text-[12px] text-black/40 hover:bg-black/10 hover:text-black/60 transition shrink-0"
            title="点击查看说明"
          >
            ?
          </button>
        </div>

        {/* 主播列表 */}
        {loading ? (
          <div className="py-8 text-center text-xs text-black/35">加载中...</div>
        ) : anchors.length === 0 ? (
          <div className="py-8 text-center text-xs text-black/30">
            暂无推荐主播
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2.5">
            {anchors.map((anchor) => (
              <button
                key={anchor.uid}
                onClick={() => {
                  // 乐观更新角标
                  setAnchors((prev) =>
                    prev.map((a) =>
                      a.uid === anchor.uid
                        ? { ...a, click_count: (a.click_count || 0) + 1 }
                        : a,
                    ),
                  );
                  // 后台静默上报点击
                  serverPost("/api/recommended-anchors/click", { uid: anchor.uid }).catch(
                    () => {},
                  );
                  openBiliLiveRoom(anchor.room_id);
                }}
                className="group flex flex-col items-center gap-1.5 p-2 rounded-xl border border-black/5 bg-black/[0.02] hover:bg-[#fafafa] hover:border-black/10 transition active:scale-95"
              >
                {/* 头像 */}
                <div className="relative">
                  {anchor.face ? (
                    <img
                      src={fixImageUrl(anchor.face)}
                      alt=""
                      className="w-12 h-12 rounded-full object-cover ring-2 ring-white shadow-sm group-hover:ring-black/5 transition"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-black/5 flex items-center justify-center text-xl ring-2 ring-white shadow-sm">
                      👤
                    </div>
                  )}
                  {/* 点击次数角标 */}
                  {typeof anchor.click_count === "number" && anchor.click_count > 0 && (
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 min-w-[16px] h-[16px] px-1 rounded-full bg-[#ff5b6e] text-white text-[9px] font-bold flex items-center justify-center leading-none shadow-sm">
                      {anchor.click_count}
                    </span>
                  )}
                </div>
                {/* 昵称 */}
                <div className="w-full text-center">
                  <span className="text-[11px] font-medium text-black/75 truncate max-w-full block leading-tight group-hover:text-black/90 transition">
                    {anchor.uname}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 说明模态框 */}
      {showTipModal && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={() => setShowTipModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题 */}
            <div className="bg-gradient-to-r from-[#ff9a9e] via-[#fecfef] to-[#a18cd1] px-5 py-3 flex items-center justify-center gap-2">
              <span className="text-white font-bold text-sm">主播推荐</span>
            </div>

            <div className="p-5">
              <p className="text-sm text-black/75 leading-loose">
                本软件开发过程中，使用了下面一部分主播的账号进行了测试，也有一些是常看的优秀主播，推荐给大家。
              </p>
              <p className="text-sm text-black/75 leading-loose mt-3">
                萝卜白菜各有所爱，但可以保证人品性格都很好，绝对不捞。
              </p>
              <p className="text-sm text-black/75 leading-loose mt-3">
                软件是免费的，但也希望能够得到认可和打赏。正好大家都是B站直播用户，打赏主播就是打赏本软件。有米的可以去刷点，没米的可以去加个灯牌点个关注。
              </p>
              <p className="text-sm text-black/75 leading-loose mt-3">
                需要说明：这些主播对软件开发一窍不通，没有参与，甚至不知道这回事儿。所以有问题和意见不要去打扰她们，通过下面的反馈渠道进行有效反馈，谢谢💗
              </p>

              <button
                onClick={() => setShowTipModal(false)}
                className="w-full mt-5 py-2.5 rounded-lg bg-[#1f1c17] text-white text-sm font-medium hover:opacity-90 active:scale-95 transition"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
