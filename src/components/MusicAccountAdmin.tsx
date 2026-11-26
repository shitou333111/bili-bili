"use client";

/**
 * 管理后台 · 音乐账号（点歌听「软件内播放」用）
 *
 * 服务器上为各平台配置一个有会员权益的账号，观众点歌后由服务器精确取流，
 * 经 Next 反代给客户端播放。账号通过手机客户端扫码登录（Cookie 只存在服务器）。
 */
import { useCallback, useEffect, useState } from "react";
import PlatformIcon from "@/components/PlatformIcon";
import { isTauri } from "@/lib/server-api";

interface AccountStatus {
  loggedIn: boolean;
  updatedAt?: number;
  cookieKeys?: string[];
}

interface QrState {
  source: string;
  key: string;
  url?: string;
  image?: string;
  status: string;
  message?: string;
  /** 平台额外状态（汽水短信验证等） */
  extra?: Record<string, string>;
}

const PLATFORMS: { value: string; label: string }[] = [
  { value: "netease", label: "网易云" },
  { value: "qq", label: "QQ音乐" },
  { value: "kugou", label: "酷狗" },
  { value: "soda", label: "汽水" },
];

/**
 * 汽水账号 / 取流功能暂搁置：
 * music-lib 文档明确说明，汽水会员曲目需要官方客户端的签名组件（bdms.node）才能拿到完整音频，
 * 仅 Cookie 只能取到试听片段。相关代码保留，等库更新后把这里改回 true 即可恢复。
 */
const SODA_ENABLED = false;

const STATUS_TEXT: Record<string, string> = {
  waiting: "等待扫码",
  scanned: "已扫码，请在手机上确认",
  success: "登录成功",
  expired: "二维码已过期",
  failed: "登录失败",
};

function adminSid(): string | null {
  try {
    return typeof window !== "undefined" ? localStorage.getItem("bili_live_admin_sid") : null;
  } catch {
    return null;
  }
}

async function adminRequest(url: string, init?: RequestInit): Promise<Response> {
  const sid = adminSid();
  const headers = {
    ...((init?.headers as Record<string, string> | undefined) || {}),
    ...(sid ? { "X-Admin-Sid": sid } : {}),
  };
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, { ...init, headers });
  }
  return fetch(url, { ...init, headers, credentials: "include" });
}

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function MusicAccountAdmin() {
  const [accounts, setAccounts] = useState<Record<string, AccountStatus>>({});
  const [available, setAvailable] = useState<boolean | null>(null);
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrImage, setQrImage] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [notice, setNotice] = useState("");
  /** 手动绑定 Cookie 的平台（空 = 表单未展开） */
  const [cookieSource, setCookieSource] = useState("");
  const [cookieText, setCookieText] = useState("");
  const [cookieBusy, setCookieBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await adminRequest("/api/admin/music");
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.code !== 0) {
        setAvailable(false);
        return;
      }
      setAvailable(json.data?.available !== false);
      setAccounts(json.data?.accounts || {});
    } catch {
      setAvailable(false);
    }
  }, []);

  /** 统一处理扫码 / 验证码查询结果 */
  function applyQrResult(data: Record<string, unknown>) {
    const status = typeof data.status === "string" ? data.status : "waiting";
    const extra =
      data.extra && typeof data.extra === "object" ? (data.extra as Record<string, string>) : undefined;
    setQr((cur) =>
      cur
        ? {
            ...cur,
            status,
            message: typeof data.message === "string" ? data.message : cur.message,
            extra: extra ?? cur.extra,
          }
        : cur,
    );
    if (data.loggedIn === true || status === "success") {
      const label = PLATFORMS.find((p) => p.value === qr?.source)?.label || qr?.source || "账号";
      setNotice(`${label} 登录成功`);
      void load();
    }
  }

  /**
   * 手动绑定 Cookie（汽水专用）。
   * 汽水扫码依赖官方动态风控签名（a_bogus / msToken），music-lib 明确未调通，
   * 只能由管理员从已登录的汽水客户端/浏览器复制完整 Cookie 粘贴保存。
   */
  async function saveCookie() {
    const source = cookieSource;
    const cookie = cookieText.trim();
    if (!source || !cookie) return;
    const label = PLATFORMS.find((p) => p.value === source)?.label || source;
    setCookieBusy(true);
    setNotice("");
    try {
      const res = await adminRequest("/api/admin/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_cookie", source, cookie }),
      });
      const json = await res.json().catch(() => null);
      const data = json?.data;
      if (!res.ok || json?.code !== 0 || data?.ok === false) {
        setNotice(data?.error || "Cookie 保存失败，请确认服务器音乐服务已启动");
        return;
      }
      setNotice(`${label} Cookie 已保存`);
      setCookieSource("");
      setCookieText("");
      void load();
    } catch {
      setNotice("请求失败，请检查网络");
    } finally {
      setCookieBusy(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后异步拉取服务器账号状态
    void load();
  }, [load]);

  // 二维码渲染：平台给的是图片就直接用，否则用返回的 url 自行生成
  useEffect(() => {
    let alive = true;
    if (!qr) return;
    void (async () => {
      let img = qr.image || "";
      if (!img && qr.url) {
        try {
          const { default: QRCode } = await import("qrcode");
          img = await QRCode.toDataURL(qr.url, { width: 240, margin: 1, errorCorrectionLevel: "M" });
        } catch {
          img = "";
        }
      }
      if (alive) setQrImage(img);
    })();
    return () => {
      alive = false;
    };
    // 只在二维码变化时重新生成；状态轮询更新 qr.status 不需要重绘二维码
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr?.key, qr?.url, qr?.image]);

  // 轮询扫码状态；终态（成功/过期）后停止。
  // 注意：单次查询失败不能直接判死（汽水接口会限流/抖动），只提示并继续轮询。
  useEffect(() => {
    if (!qr?.key) return;
    if (qr.status === "success" || qr.status === "expired") return;
    let alive = true;
    const timer = window.setInterval(async () => {
      try {
        const res = await adminRequest("/api/admin/music", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "qr_check", source: qr.source, key: qr.key }),
        });
        const json = await res.json().catch(() => null);
        if (!alive) return;
        const data = json?.data;
        if (!res.ok || json?.code !== 0 || !data?.ok) {
          setQr((cur) =>
            cur ? { ...cur, message: data?.error || "查询失败，正在重试…" } : cur,
          );
          return;
        }
        applyQrResult(data);
      } catch {
        /* 网络抖动：下一轮继续 */
      }
    }, 2600);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr?.key, qr?.source, qr?.status, load]);

  const startLogin = async (source: string) => {
    setNotice("");
    setBusy(source);
    try {
      const res = await adminRequest("/api/admin/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "qr_start", source }),
      });
      const json = await res.json().catch(() => null);
      const data = json?.data;
      if (!res.ok || json?.code !== 0 || !data?.ok) {
        setNotice(data?.error || "二维码获取失败，请确认服务器音乐服务已启动");
        return;
      }
      setQrImage("");
      setQr({
        source,
        key: String(data.key || ""),
        url: typeof data.url === "string" ? data.url : undefined,
        image: typeof data.image === "string" ? data.image : undefined,
        status: "waiting",
      });
    } catch {
      setNotice("请求失败，请检查网络");
    } finally {
      setBusy("");
    }
  };

  const clearAccount = async (source: string) => {
    const label = PLATFORMS.find((p) => p.value === source)?.label || source;
    if (!window.confirm(`确定退出 ${label} 账号？退出后该平台的点歌将无法在软件内播放。`)) return;
    setBusy(source);
    setNotice("");
    try {
      const res = await adminRequest("/api/admin/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear", source }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.code !== 0 || json?.data?.ok === false) {
        setNotice("退出失败，请稍后重试");
        return;
      }
      setNotice(`${label} 已退出登录`);
      void load();
    } catch {
      setNotice("请求失败，请检查网络");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="rounded-xl border border-black/10 bg-white/80 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-bold">音乐账号</h2>
          <span className="text-[10px] text-black/40">点歌听「软件内播放」使用</span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/50 transition hover:border-black/25 hover:text-black/80"
        >
          刷新状态
        </button>
      </div>

      {available === false && (
        <p className="mb-1.5 text-[11px] text-[#e74c3c]">
          音乐服务未就绪：服务器上需要以 serve 模式运行 music-service（默认 127.0.0.1:8081）。
        </p>
      )}
      {notice && <p className="mb-1.5 text-[11px] text-black/60">{notice}</p>}

      <div className="space-y-1.5">
        {PLATFORMS.map((p) => {
          const st = accounts[p.value];
          // 汽水：扫码未调通、Cookie 也不足以取完整音频 → 暂搁置入口（代码保留）
          const sodaShelved = p.value === "soda" && !SODA_ENABLED;
          // 汽水恢复后只提供手动填写 Cookie
          const manual = p.value === "soda" && !sodaShelved;
          const editing = manual && cookieSource === p.value;
          return (
            <div key={p.value} className="rounded-lg border border-black/10 bg-white/70">
              <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <PlatformIcon platform={p.value} size={18} />
                <span className="text-xs font-medium">{p.label}</span>
                {st?.loggedIn ? (
                  <span className="rounded bg-[#2ecc71]/10 px-1.5 py-0.5 text-[10px] text-[#2e9e5b]">
                    已登录{st.updatedAt ? ` · ${formatTime(st.updatedAt)}` : ""}
                  </span>
                ) : (
                  <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-black/40">未登录</span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  {sodaShelved ? (
                    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] text-black/40">
                      暂不支持（等待库更新）
                    </span>
                  ) : manual ? (
                    <button
                      type="button"
                      onClick={() => {
                        setCookieSource(editing ? "" : p.value);
                        setCookieText("");
                        setNotice("");
                      }}
                      className="rounded-lg bg-[#1f1c17] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90"
                    >
                      {st?.loggedIn ? "更新 Cookie" : "填写 Cookie"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === p.value}
                      onClick={() => void startLogin(p.value)}
                      className="rounded-lg bg-[#1f1c17] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === p.value ? "获取中…" : st?.loggedIn ? "重新登录" : "扫码登录"}
                    </button>
                  )}
                  {p.value === "qq" && (
                    <button
                      type="button"
                      disabled={busy === p.value}
                      onClick={() => void startLogin("qq_wx")}
                      className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/60 transition hover:border-black/25 disabled:opacity-50"
                    >
                      微信扫码
                    </button>
                  )}
                  {st?.loggedIn && (
                    <button
                      type="button"
                      disabled={busy === p.value}
                      onClick={() => void clearAccount(p.value)}
                      className="rounded-lg border border-[#e74c3c]/25 bg-[#fdf0ef] px-2 py-1 text-[11px] text-[#e74c3c] transition hover:border-[#e74c3c]/50 disabled:opacity-50"
                    >
                      退出
                    </button>
                  )}
                </span>
              </div>
              {editing && (
                <div className="border-t border-black/5 px-2 py-1.5">
                  <p className="mb-1 text-[10px] leading-relaxed text-black/45">
                    汽水音乐扫码登录依赖官方动态风控签名，暂未调通。请在已登录的汽水客户端或浏览器中复制完整
                    Cookie 后粘贴到这里。
                  </p>
                  <textarea
                    value={cookieText}
                    onChange={(e) => setCookieText(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    placeholder="name=value; name2=value2"
                    className="w-full resize-y rounded-lg bg-white px-2 py-1 font-mono text-[11px] text-black/80 outline-none ring-1 ring-black/10 transition focus:ring-[#ec4141]/30"
                  />
                  <div className="mt-1 flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setCookieSource("");
                        setCookieText("");
                      }}
                      className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/60 transition hover:border-black/25"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={!cookieText.trim() || cookieBusy}
                      onClick={() => void saveCookie()}
                      className="rounded-lg bg-[#1f1c17] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
                    >
                      {cookieBusy ? "保存中…" : "保存"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {qr && (
        <div className="mt-2 rounded-xl border border-black/10 bg-white p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">
              {PLATFORMS.find((p) => p.value === qr.source)?.label || "QQ音乐"} 扫码登录
            </span>
            <button
              type="button"
              onClick={() => {
                setQr(null);
                setQrImage("");
              }}
              className="text-[11px] text-black/40 hover:text-black/70"
            >
              关闭
            </button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-[132px] w-[132px] shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white">
              {qrImage ? (
                <img src={qrImage} alt="登录二维码" className="h-[124px] w-[124px]" />
              ) : (
                <span className="text-[10px] text-black/30">二维码生成中…</span>
              )}
            </div>
            <div className="min-w-0 text-[11px] leading-relaxed text-black/60">
              <p className="font-medium text-black/80">{STATUS_TEXT[qr.status] || qr.status}</p>
              {qr.message && <p className="break-all text-black/45">{qr.message}</p>}

              <p className="mt-1 text-black/40">用对应平台的手机客户端扫码；登录成功后 Cookie 只保存在服务器。</p>
              {(qr.status === "expired" || qr.status === "failed") && (
                <button
                  type="button"
                  onClick={() => void startLogin(qr.source)}
                  className="mt-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] text-black/60 hover:border-black/25"
                >
                  刷新二维码
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
