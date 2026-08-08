"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { serverFetch } from "@/lib/server-api";

type QRGenerateResponse = {
  code: number;
  message: string;
  data?: {
    qrcode_key: string;
    url: string;
    image: string;
  };
};

type QRPollResponse = {
  code: number;
  message: string;
  data?: {
    code: number;
    message: string;
    url: string;
    refresh_token: string;
    timestamp: number;
    sid?: string;
    userToken?: string;
  };
};

export default function LoginPage() {
  const [qrImage, setQrImage] = useState("");
  const [status, setStatus] = useState("正在生成登录二维码...");
  const [error, setError] = useState("");
  const [qrKey, setQrKey] = useState("");
  const [countdown, setCountdown] = useState(0);
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
    const maxPolls = 120;  // 180秒 / 1.5秒 = 120次
    const totalSeconds = 180;  // B站二维码有效期约180秒
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
        const data = await serverFetch<QRPollResponse>(`/api/auth/qr/poll?qrcode_key=${encodeURIComponent(key)}`);

        if (data.code === 0 && data.data?.code === 0) {
          clearPollTimer();
          // 存储 SID 和 userToken 到 localStorage，持久化以便下次打开自动登录
          if (data.data.sid) {
            localStorage.setItem("bili_live_sid", data.data.sid);
          }
          if (data.data.userToken) {
            localStorage.setItem("bili_live_user_token", data.data.userToken);
            // 稳定设备令牌：本机登录账号以它为准，且不会被 admin 模拟切换覆盖
            if (!localStorage.getItem("bili_live_device_token")) {
              localStorage.setItem("bili_live_device_token", data.data.userToken);
            }
          }
          setStatus("登录成功！正在跳转...");
          setTimeout(() => {
            window.location.href = "/";
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

    try {
      const data = await serverFetch<QRGenerateResponse>("/api/auth/qr/generate");

      if (!data.data?.qrcode_key) {
        throw new Error(data.message || "二维码生成失败");
      }

      setQrKey(data.data.qrcode_key);
      setQrImage(data.data.image || `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(data.data.url)}`);
      setStatus("请使用哔哩哔哩 APP 扫码登录");
      pollLogin(data.data.qrcode_key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "二维码生成失败");
      setStatus("二维码生成失败，请重试");
    }
  }, [clearPollTimer, pollLogin]);

  const downloadQRCode = useCallback(async () => {
    if (!qrImage) return;

    try {
      // 方案一：优先使用 Web Share API（iOS Safari、Android Chrome）
      const response = await fetch(qrImage);
      const blob = await response.blob();
      const file = new File([blob], 'bilibili-login-qr.png', { type: blob.type });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: '保存二维码图片',
        });
        return;
      }
    } catch (err) {
      console.log('Web Share API 不可用或失败，降级使用全屏展示');
    }

    // 方案二：全屏弹窗展示，提示长按保存（兼容所有浏览器，包括微信）
    const newWindow = window.open("", "_blank");
    if (newWindow) {
      newWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>登录二维码</title>
          <style>
            body { margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #1a1a1a; }
            img { max-width: 90vw; max-height: 70vh; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
            .hint { margin-bottom: 20px; font-size: 18px; color: #fff; text-align: center; padding: 0 20px; font-weight: 500; }
            .close-btn { position: absolute; top: 20px; right: 20px; color: #fff; font-size: 24px; cursor: pointer; padding: 10px; }
          </style>
        </head>
        <body>
          <button class="close-btn" onclick="window.close()">✕</button>
          <p class="hint">长按图片保存到相册</p>
          <img src="${qrImage}" alt="登录二维码" />
        </body>
        </html>
      `);
      newWindow.document.close();
    }
  }, [qrImage]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void loadQR();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      clearPollTimer();
    };
  }, [loadQR, clearPollTimer]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_#fff0d8_0%,_#f4efe7_36%,_#e9eff8_100%)] px-4 py-10 text-[#1f1c17]">
      <section className="mx-auto w-full max-w-md">
        <article className="rounded-[2rem] border border-black/10 bg-white/82 p-8 shadow-[0_20px_80px_rgba(31,28,23,0.08)] backdrop-blur">
          <h1 className="font-[family-name:var(--font-space-grotesk)] text-3xl font-semibold tracking-tight text-center">
            扫码登录 B 站账号
          </h1>
          <p className="mt-4 text-sm leading-6 text-justify text-black/65">
            使用哔哩哔哩手机APP扫码，在手机上确认登录。登录凭证存在本机，没有安全问题。
          </p>

          <div className="mt-8 flex justify-center">
            <div className="max-w-[280px] w-full rounded-[1.75rem] border border-black/10 bg-[#111111] p-4 flex items-center justify-center">
              <div className="w-full aspect-square rounded-3xl bg-white p-2 overflow-hidden flex items-center justify-center">
                {qrImage ? (
                  <img src={qrImage} alt="Bilibili login QR code" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm text-white/65">二维码加载中...</div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 text-center">
            <div className="text-lg font-medium text-black/80">
              {status}
              {status === "等待扫码中..." && countdown > 0 && (
                <span className="ml-2 text-sm text-black/50">({Math.floor(countdown / 60)}分{countdown % 60}秒)</span>
              )}
            </div>
            {error ? (
              <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            ) : null}
          </div>

          <div className="mt-2 text-center">
            <p className="text-xs text-black/40">长按上面的二维码图片保存或截屏</p>
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={loadQR}
              className="rounded-full bg-[#1f1c17] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
            >
              重新生成二维码
            </button>
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={async () => {
                clearPollTimer();
                // 清除登录会话，避免主页检测到过期session后跳回登录页
                try {
                  await serverFetch("/api/auth/logout", { method: "POST" });
                } catch {
                  // 离线或网络错误时忽略，仍可返回上一页
                }
                // 返回到打开登录页面前的页面（取消登录模态框）
                if (window.history.length > 1) {
                  window.history.back();
                } else {
                  window.location.href = "/";
                }
              }}
              className="flex items-center gap-1 rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-black/50 transition hover:bg-black/5"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              取消登录
            </button>
          </div>
        </article>
      </section>
    </main>
  );
}