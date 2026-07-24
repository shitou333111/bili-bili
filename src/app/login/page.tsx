"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  };
};

export default function LoginPage() {
  const [qrImage, setQrImage] = useState("");
  const [status, setStatus] = useState("正在生成登录二维码...");
  const [error, setError] = useState("");
  const [qrKey, setQrKey] = useState("");
  const pollTimerRef = useRef<number | null>(null);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollLogin = useCallback((key: string) => {
    clearPollTimer();
    let pollCount = 0;
    const maxPolls = 200;

    pollTimerRef.current = window.setInterval(async () => {
      pollCount++;
      if (pollCount > maxPolls) {
        clearPollTimer();
        setStatus("二维码已过期，请重新生成");
        setError("轮询超时");
        return;
      }

      try {
        const response = await fetch(`/api/auth/qr/poll?qrcode_key=${encodeURIComponent(key)}`, {
          cache: "no-store",
        });
        const data = (await response.json()) as QRPollResponse;

        if (data.code === 0 && data.data?.code === 0) {
          clearPollTimer();
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
      const response = await fetch("/api/auth/qr", {
        cache: "no-store",
      });
      const data = (await response.json()) as QRGenerateResponse;

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

  const downloadQRCode = useCallback(() => {
    if (!qrImage) return;
    const link = document.createElement("a");
    link.href = qrImage;
    link.download = "bilibili-login-qr.png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
            使用哔哩哔哩手机APP扫码，在手机上确认登录。本网站只获取你的登录凭证，无法知道密码，更不会也无法更改密码或对账号安全方面做出任何更改。
          </p>

          <div className="mt-8 flex flex-col items-center gap-4">
            <div className="max-w-[280px] w-full rounded-[1.75rem] border border-black/10 bg-[#111111] p-4">
              <div className="w-full aspect-square rounded-3xl bg-white p-2 overflow-hidden">
                {qrImage ? (
                  <img src={qrImage} alt="Bilibili login QR code" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-sm text-white/65">二维码加载中...</div>
                )}
              </div>
            </div>
            
            <button
              type="button"
              onClick={downloadQRCode}
              disabled={!qrImage}
              className="flex items-center gap-1.5 rounded-full bg-black/10 px-5 py-2.5 text-sm font-medium text-black/80 transition hover:bg-black/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              下载二维码图片
            </button>
          </div>

          <div className="mt-6 text-center">
            <div className="text-lg font-medium text-black/80">{status}</div>
            {error ? (
              <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={loadQR}
              className="rounded-full bg-[#1f1c17] px-6 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
            >
              重新生成二维码
            </button>
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => {
                clearPollTimer();
                window.location.href = "/";
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