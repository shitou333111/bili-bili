"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Swiper, SwiperSlide } from "swiper/react";
import { Autoplay, EffectFade } from "swiper/modules";
import "swiper/css";
import "swiper/css/effect-fade";
import { authApi } from "@/lib/api";
import { pageUrl } from "@/lib/server-api";
import { APP_NAME, LANDING_SLIDES } from "@/lib/landing-content";
import WindowTitleBar from "@/components/WindowTitleBar";
import SafeAreaStyler from "@/components/SafeAreaStyler";
import PwaInstallPrompt from "@/components/PwaInstallPrompt";
import SloganRotator from "@/app/landing/SloganRotator";

const AUTOPLAY_MS = 6500;
const SLIDE_COUNT = LANDING_SLIDES.length;

export default function LoginPage() {
  const [qrImage, setQrImage] = useState("");
  const [status, setStatus] = useState("正在生成登录二维码...");
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  // 是否已有登录用户：首次使用（无任何登录凭证）时不显示“取消登录”；
  // 有登录用户时显示，点击返回“帮助”页面。
  // 初始值固定 false（保证服务端 HTML 与首帧一致，避免水合不一致），挂载后再读本机凭证。
  const [hasLoginUser, setHasLoginUser] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const autoQrRef = useRef(false);
  const [active, setActive] = useState(0);
  const pollTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const pollLogin = useCallback((key: string) => {
    clearPollTimer();
    let pollCount = 0;
    const maxPolls = 120; // 180秒 / 1.5秒 = 120次
    const totalSeconds = 180; // B站二维码有效期约180秒
    setCountdown(totalSeconds);

    countdownTimerRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownTimerRef.current) {
            window.clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    pollTimerRef.current = window.setInterval(async () => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearPollTimer();
        setStatus("二维码已过期，请重新生成");
        setError("轮询超时");
        return;
      }

      try {
        const data = await authApi.pollQR(key);

        if (data.code === 0 && data.data?.code === 0) {
          clearPollTimer();
          // 存储 SID 到 localStorage，持久化以便下次打开自动登录
          if (data.data.sid) {
            localStorage.setItem("bili_live_sid", data.data.sid);
            // 标记本次跳转由"扫码登录"触发：主页据此对该账号的主播收益做一次
            // 有容错的全量探测（仅此一次，消费后即清除），无收益则置位 noRevenue；
            // 冷启动/绿色刷新不再重复全量探测。
            localStorage.setItem("bili_live_anchor_probe", "1");
            // 标记本次是在新会话下首次拉取数据：主页进入后直接显示初始化全屏遮罩，
            // 不再先闪一下中间态的"加载中..."（初始化完成后自动清除）
            try {
              sessionStorage.setItem("bili_live_init_overlay", "1");
            } catch {
              /* 隐私模式不可写时忽略 */
            }
          }
          setStatus("登录成功！正在跳转...");
          setTimeout(() => {
            window.location.href = pageUrl("/");
          }, 800);
          return;
        }

        if (data.code === 1) {
          clearPollTimer();
          setStatus("登录失败");
          setError(data.message || "无法获取登录凭证，请重试");
          return;
        }

        if (data.data?.code === 86038) {
          clearPollTimer();
          setStatus("二维码已过期，请重新生成");
          return;
        }

        if (data.data?.code === 86090) {
          setStatus("已扫码，请在手机上确认登录...");
          return;
        }

        if (data.data?.code === 86101) {
          setStatus("等待扫码中...");
          return;
        }

        if (data.data?.message) {
          setStatus(data.data.message);
        }
      } catch (err) {
        clearPollTimer();
        setError(err instanceof Error ? err.message : "轮询失败");
        setStatus("网络错误，请重新生成二维码");
      }
    }, 1500);
  }, [clearPollTimer]);

  const loadQR = useCallback(async () => {
    clearPollTimer();
    setError("");
    setStatus("正在生成登录二维码...");

    // iOS 首次打开 APP 时，系统网络权限弹窗尚未授予，首个请求必然失败。
    // 标准解法：自动重试，间隔递增（1s → 2s → 3s），给用户时间授予权限。
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await authApi.generateQR();

        if (!data.data?.qrcode_key) {
          throw new Error(data.message || "二维码生成失败");
        }

        setQrImage(
          data.data.image ||
            `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(data.data.url)}`,
        );
        setStatus("请使用哔哩哔哩 APP 扫码登录");
        pollLogin(data.data.qrcode_key);
        return;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          setStatus(`正在等待网络就绪...(${attempt + 1}/${MAX_RETRIES})`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
          continue;
        }
        setError(err instanceof Error ? err.message : "二维码生成失败");
        setStatus("二维码生成失败，请重试");
      }
    }
  }, [clearPollTimer, pollLogin]);

  const openLogin = useCallback(() => {
    setLoginOpen(true);
    void loadQR();
  }, [loadQR]);

  const closeLogin = useCallback(() => {
    clearPollTimer();
    setLoginOpen(false);
    setQrImage("");
    setCountdown(0);
    setError("");
    setStatus("正在生成登录二维码...");
  }, [clearPollTimer]);

  useEffect(() => {
    return () => clearPollTimer();
  }, [clearPollTimer]);

  // 挂载后读取本机登录凭证，决定顶部是否显示“取消登录”
  useEffect(() => {
    setHasLoginUser(!!localStorage.getItem("bili_live_sid"));
  }, []);

  // Esc 关闭登录弹窗
  useEffect(() => {
    if (!loginOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLogin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loginOpen, closeLogin]);

  // 主页「添加新账号」跳转而来（/login?qr=1）：直接打开扫码面板，用户可立即扫码。
  // ref 守卫避免开发模式 StrictMode 下 effect 重复执行造成二维码重复生成。
  useEffect(() => {
    if (autoQrRef.current) return;
    autoQrRef.current = true;
    if (new URLSearchParams(window.location.search).get("qr") === "1") openLogin();
  }, [openLogin]);

  // 背景大图按"当前 ±1"懒加载：6MB 宣传图不会在首屏一次性全部下载
  const shouldLoad = (i: number) => {
    const diff = Math.abs(i - active);
    return Math.min(diff, SLIDE_COUNT - diff) <= 1;
  };

  return (
    <main
      className="login-screen relative mx-auto flex h-[100svh] w-full flex-col overflow-hidden bg-[#f2f2f4] text-[#1f1c17]"
      style={{ paddingTop: "var(--safe-top, 0px)", maxWidth: "var(--page-max-width, 500px)" }}
    >
      <SafeAreaStyler />
      <WindowTitleBar />

      {/* ============ 背景：官网宣传图轮播 + 深色遮罩 ============ */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <Swiper
          className="h-full w-full !z-0"
          modules={[Autoplay, EffectFade]}
          effect="fade"
          fadeEffect={{ crossFade: true }}
          speed={1200}
          slidesPerView={1}
          loop
          autoplay={{ delay: AUTOPLAY_MS, disableOnInteraction: false }}
          onSlideChange={(s) => setActive(s.realIndex)}
        >
          {LANDING_SLIDES.map((slide, i) => (
            <SwiperSlide key={slide.image} className="!h-full overflow-hidden">
              {shouldLoad(i) ? (
                <img
                  src={slide.image}
                  alt=""
                  className="h-full w-full scale-110 object-cover object-top opacity-40 blur-[18px]"
                />
              ) : null}
            </SwiperSlide>
          ))}
        </Swiper>
        {/* 浅色遮罩：把背景图压成灰白色氛围，保证上方深色文字与轮播内容清晰 */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#f7f7f8]/88 via-[#f3f3f5]/82 to-[#f2f2f4]/96" />
        {/* 强调光晕跟随当前功能取色，让每一屏都有自己的氛围色 */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(120% 80% at 18% 0%, ${LANDING_SLIDES[active].color}22, transparent 62%)`,
          }}
        />
      </div>

      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col">
        {/* ============ 顶部：图标 + 标题 + 扫码登录 ============ */}
        {/* 标题栏只用少量下内边距，让下方轮播尽量贴近顶部，避免首屏出现大块空白 */}
        <header className="mx-auto flex w-full max-w-6xl shrink-0 items-center gap-3 px-5 pb-1 pt-3 sm:px-8 sm:pb-1.5 sm:pt-4">
          <img
            src="/orig_icon.png"
            alt={APP_NAME}
            width={40}
            height={40}
            className="h-9 w-9 rounded-[11px] shadow-lg sm:h-10 sm:w-10"
          />
          <div className="text-[17px] font-semibold leading-tight">{APP_NAME}</div>
          <div className="ml-auto flex items-center gap-2">
            {hasLoginUser && (
              <button
                type="button"
                onClick={() => {
                  closeLogin();
                  // 与弹窗里的"取消登录"一致：返回主页并恢复"帮助"模块
                  sessionStorage.setItem("bili_live_return", "help");
                  window.location.href = pageUrl("/");
                }}
                className="inline-flex items-center rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-[12px] font-semibold text-black/55 backdrop-blur transition hover:bg-white active:scale-[0.98] sm:px-4 sm:py-2 sm:text-[13px]"
              >
                取消登录
              </button>
            )}
            <button
              type="button"
              onClick={openLogin}
              className="inline-flex items-center rounded-full bg-[#1b1b1f] px-4 py-1.5 text-[12px] font-semibold text-white shadow-[0_6px_20px_rgba(0,0,0,0.18)] transition hover:bg-[#2b2b32] active:scale-[0.98] sm:px-5 sm:py-2 sm:text-[13px]"
            >
              扫码登录
            </button>
          </div>
        </header>

        {/* ============ 官网首页同款功能轮播，占据页面主体 ============ */}
        <div className="relative flex min-h-0 w-full flex-1 flex-col pb-2 sm:pb-3">
          <SloganRotator fitViewport />
        </div>
      </div>

      {/* ============ 扫码登录弹窗 ============ */}
      {loginOpen && (
        <div
          className="fixed inset-0 z-[9998] mx-auto flex w-full items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
          style={{ maxWidth: "var(--page-max-width, 500px)" }}
          role="dialog"
          aria-modal="true"
          aria-label="扫码登录"
          onClick={closeLogin}
        >
          <div
            className="relative w-full max-w-[360px] rounded-[26px] bg-white p-6 text-[#1f1c17] shadow-[0_30px_90px_rgba(0,0,0,0.5)]"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeLogin}
              aria-label="关闭登录"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-black/35 transition hover:bg-black/[0.06] hover:text-black/60"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>

            <h2 className="text-center text-xl font-semibold">扫码登录 B 站账号</h2>
            <p className="mt-2 text-center text-[12px] leading-5 text-black/55">
              使用哔哩哔哩手机 APP 扫码，登录凭证只保存在本机
            </p>

            <div className="mt-5 flex justify-center">
              <div className="w-full max-w-[248px] rounded-[22px] border border-black/10 bg-[#111111] p-3">
                <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl bg-white p-2">
                  {qrImage ? (
                    <img src={qrImage} alt="Bilibili login QR code" className="h-full w-full object-contain" />
                  ) : (
                    <span className="text-xs text-black/40">二维码生成中...</span>
                  )}
                </div>
              </div>
            </div>

            <p className="mt-4 text-center text-[13px] font-medium leading-5 text-black/80">
              {status}
              {status === "等待扫码中..." && countdown > 0 && (
                <span className="ml-1 text-[11px] font-normal text-black/45">
                  ({Math.floor(countdown / 60)}分{countdown % 60}秒)
                </span>
              )}
            </p>

            {error ? (
              <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-center text-[12px] text-red-600">{error}</p>
            ) : null}

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void loadQR()}
                className="rounded-full bg-[#1f1c17] px-4 py-2.5 text-[13px] font-medium text-white transition hover:opacity-90"
              >
                重新生成二维码
              </button>
              {hasLoginUser && (
                <button
                  type="button"
                  onClick={() => {
                    closeLogin();
                    // 记录返回目标，跳回主页后由主页恢复"帮助"模块
                    sessionStorage.setItem("bili_live_return", "help");
                    window.location.href = pageUrl("/");
                  }}
                  className="flex items-center justify-center gap-1 rounded-full border border-black/10 px-4 py-2 text-[13px] font-medium text-black/50 transition hover:bg-black/5"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  取消登录
                </button>
              )}
            </div>

            <p className="mt-3 text-center text-[10px] text-black/35">二维码约 3 分钟有效，可长按图片保存或截屏</p>
          </div>
        </div>
      )}

      {/* PWA 安装引导：在扫码登录之前提示，避免装到桌面后还要在 PWA 里重新扫码。
          仅移动端浏览器网页显示（判断在 hook 内部），客户端/桌面已安装环境自动隐藏。 */}
      {!loginOpen && <PwaInstallPrompt delayMs={1200} />}
    </main>
  );
}
