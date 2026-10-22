"use client";

/**
 * PWA 更新 hook（Web 端专用）
 *
 * 与客户端 updater.ts 的"热更新"体验保持一致：
 *   1) 打开页面后静默检查线上版本（不阻塞页面）
 *   2) 发现新版本 → 浏览器在后台下载并安装新 Service Worker
 *   3) 下载完成 → 顶部横幅提示"新内容已准备就绪，点击立即生效"
 *   4) 用户点击 → SKIP_WAITING + controllerchange → 刷新页面
 *
 * 不在 install 阶段自动 skipWaiting / 自动刷新：避免打断用户操作，也避免刷新死循环。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BUILD_SEQ } from "./build-info";

export type PwaUpdateStatus =
  | "idle" // 未检查 / 等待检查
  | "checking" // 正在向服务器确认版本
  | "downloading" // 已发现新版本，浏览器正在后台下载
  | "ready" // 新版本已下载完成，等待用户点击刷新
  | "latest" // 已是最新（短暂显示 5s）
  | "error";

export interface PwaUpdateController {
  /** 浏览器支持并已成功注册 Service Worker（开发模式 / 非 https 时为 false） */
  supported: boolean;
  status: PwaUpdateStatus;
  /** 当前页面内置的构建序号（帮助页显示的"当前版本"） */
  currentSeq: number;
  /** 服务器最新构建序号（检查成功后才有值） */
  latestSeq: number | null;
  error: string;
  /** 手动检查更新 */
  check: () => Promise<void>;
  /** 应用已下载的新版本并刷新页面 */
  apply: () => void;
}

/** 页面内置构建序号（CI 注入；本地构建为 0） */
const CURRENT_SEQ = Number(BUILD_SEQ) || 0;
/** 回到前台时的自动检查间隔（与客户端"回到应用时静默检查"一致） */
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Service Worker install 没有进度事件，超时即视为下载失败 */
const DOWNLOAD_TIMEOUT_MS = 90 * 1000;

export function usePwaUpdate(enabled: boolean): PwaUpdateController {
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<PwaUpdateStatus>("idle");
  const [latestSeq, setLatestSeq] = useState<number | null>(null);
  const [error, setError] = useState("");

  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const waitingRef = useRef<ServiceWorker | null>(null);
  /** 注册时是否已存在 controller：用于区分"首次安装"和"更新" */
  const hadControllerRef = useRef(false);
  /** 用户主动点了刷新：只有此时 controllerchange 才 reload */
  const userAppliedRef = useRef(false);
  const inflightRef = useRef(false);
  const lastCheckRef = useRef(0);
  const latestResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkRef = useRef<(() => Promise<void>) | null>(null);

  const clearDownloadTimeout = useCallback(() => {
    if (downloadTimeoutRef.current) {
      clearTimeout(downloadTimeoutRef.current);
      downloadTimeoutRef.current = null;
    }
  }, []);

  /** 手动检查后按钮短暂显示"已是最新"（5s）后恢复为"检查更新" */
  const scheduleLatestReset = useCallback(() => {
    if (latestResetRef.current) clearTimeout(latestResetRef.current);
    latestResetRef.current = setTimeout(() => {
      latestResetRef.current = null;
      setStatus((s) => (s === "latest" ? "idle" : s));
    }, 5000);
  }, []);

  /** 向指定 SW 询问它缓存的构建序号（超时/不支持时返回 0） */
  const getWorkerSeq = useCallback((worker: ServiceWorker): Promise<number> => {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: number) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      const timer = setTimeout(() => finish(0), 1500);
      try {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => {
          clearTimeout(timer);
          finish(Number(e.data?.seq) || 0);
        };
        worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
      } catch {
        clearTimeout(timer);
        finish(0);
      }
    });
  }, []);

  /** 记录等待中的新版本序号，供帮助页显示"最新版本" */
  const noteWaitingSeq = useCallback(
    (worker: ServiceWorker) => {
      void getWorkerSeq(worker).then((seq) => {
        if (seq > 0) setLatestSeq(seq);
      });
    },
    [getWorkerSeq],
  );

  /** 服务端关闭 PWA 时：卸载 SW 并清空缓存，回到普通网页 */
  const teardown = useCallback(async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.indexOf("bguagua-") === 0).map((k) => caches.delete(k)));
    } catch {
      /* 清理失败不阻塞 */
    }
    regRef.current = null;
    waitingRef.current = null;
    setSupported(false);
    setStatus("idle");
    setLatestSeq(null);
    setError("");
  }, []);

  const check = useCallback(async () => {
    const reg = regRef.current;
    if (!reg || inflightRef.current) return;
    inflightRef.current = true;
    lastCheckRef.current = Date.now();
    if (latestResetRef.current) {
      clearTimeout(latestResetRef.current);
      latestResetRef.current = null;
    }
    setStatus("checking");
    setError("");
    try {
      const res = await fetch(`/api/pwa/version?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json?.data || {};

      if (data.enabled === false) {
        await teardown();
        return;
      }

      const latest = Number(data.seq) || 0;
      setLatestSeq(latest > 0 ? latest : null);

      // 是否"需要刷新"只看页面自身内置的构建序号：
      // 若页面已是网络返回的最新 HTML（常见于旧 SW 控制下刚打开的新页面），
      // 即使 controller 还是旧版本也不需要提示，否则会误报"有新内容"。
      if (latest > CURRENT_SEQ) {
        // 已经下载完成的等待版本（浏览器在注册时自动完成的更新）：直接可刷新
        if (reg.waiting) {
          waitingRef.current = reg.waiting;
          noteWaitingSeq(reg.waiting);
          clearDownloadTimeout();
          setStatus("ready");
          return;
        }

        setStatus("downloading");
        clearDownloadTimeout();
        downloadTimeoutRef.current = setTimeout(() => {
          setStatus((s) => (s === "downloading" ? "error" : s));
          setError("下载超时，请稍后重试");
        }, DOWNLOAD_TIMEOUT_MS);

        await reg.update();

        // update() 返回后可能：等待版本已就绪 / 仍在安装 / 浏览器判定内容未变化。
        // 已就绪必须立刻切 ready，否则会一直停在"下载中"直到超时。
        setTimeout(() => {
          const r = regRef.current;
          if (!r) return;
          if (r.waiting) {
            waitingRef.current = r.waiting;
            noteWaitingSeq(r.waiting);
            clearDownloadTimeout();
            setStatus("ready");
            setError("");
            return;
          }
          if (!r.installing) {
            clearDownloadTimeout();
            setStatus((s) => (s === "downloading" ? "latest" : s));
            scheduleLatestReset();
          }
        }, 800);
      } else {
        setStatus("latest");
        scheduleLatestReset();
      }
    } catch (e: any) {
      setStatus("error");
      setError(`检查失败：${e?.message || String(e)}`);
    } finally {
      inflightRef.current = false;
    }
  }, [clearDownloadTimeout, noteWaitingSeq, scheduleLatestReset, teardown]);

  useEffect(() => {
    checkRef.current = check;
  }, [check]);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // 仅生产构建启用：dev 模式的 HMR 资源随时变化，SW 缓存会干扰开发
    if (process.env.NODE_ENV !== "production") return;

    let disposed = false;
    hadControllerRef.current = !!navigator.serviceWorker.controller;

    const onControllerChange = () => {
      if (!hadControllerRef.current) {
        hadControllerRef.current = true;
        return;
      }
      if (userAppliedRef.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    /** 已监听的 installing worker，避免 updatefound 与注册后补挂重复绑定 */
    const watched = new WeakSet<ServiceWorker>();

    /** 跟踪某个正在安装的 worker：安装完成 → 等待用户点刷新；安装失败 → 回 idle */
    const trackInstalling = (worker: ServiceWorker) => {
      // 首次安装（页面尚无 controller）不算更新，不弹任何提示
      if (!navigator.serviceWorker.controller) return;
      if (watched.has(worker)) return;
      watched.add(worker);
      setStatus((s) => (s === "ready" ? s : "downloading"));
      setError("");
      worker.addEventListener("statechange", () => {
        if (disposed) return;
        if (worker.state === "installed") {
          clearDownloadTimeout();
          // 只有比页面自身更新的版本才值得提示刷新：
          // 旧 SW 控制下加载的新页面，install 出来的 SW 序号与页面相同，弹横幅反而打扰用户
          void getWorkerSeq(worker).then((seq) => {
            if (disposed) return;
            if (seq > CURRENT_SEQ) {
              waitingRef.current = worker;
              setStatus("ready");
              setError("");
              noteWaitingSeq(worker);
            } else {
              setStatus((s) => (s === "downloading" ? "idle" : s));
            }
          });
        } else if (worker.state === "redundant") {
          clearDownloadTimeout();
          setStatus((s) => (s === "downloading" ? "idle" : s));
        }
      });
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        if (disposed) return;
        regRef.current = reg;
        setSupported(true);

        // 已有等待中的新版本（用户上次没点刷新）：直接弹横幅。
        // 仍需确认它比页面自身新，否则"刚打开的新页面 + 旧 SW 自动更新"会误报。
        if (reg.waiting && navigator.serviceWorker.controller) {
          const waiting = reg.waiting;
          void getWorkerSeq(waiting).then((seq) => {
            if (disposed || seq <= CURRENT_SEQ) return;
            waitingRef.current = waiting;
            setStatus("ready");
            noteWaitingSeq(waiting);
          });
        } else if (reg.installing) {
          // register() 触发的自动更新可能早于 updatefound 监听绑定而完成安装，
          // 这里补挂一次，避免"新版本已在下载/已就绪但页面毫无反应"。
          trackInstalling(reg.installing);
        }

        reg.addEventListener("updatefound", () => {
          const installing = reg.installing;
          if (!installing) return;
          trackInstalling(installing);
        });

        // 冷启动静默检查：不阻塞页面（与客户端首页自动检查一致）
        setTimeout(() => {
          if (!disposed) void checkRef.current?.();
        }, 2000);
      })
      .catch(() => {
        if (!disposed) setSupported(false);
      });

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheckRef.current < AUTO_CHECK_INTERVAL_MS) return;
      void checkRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      clearDownloadTimeout();
      if (latestResetRef.current) {
        clearTimeout(latestResetRef.current);
        latestResetRef.current = null;
      }
    };
  }, [enabled, clearDownloadTimeout, noteWaitingSeq]);

  const apply = useCallback(() => {
    const waiting = waitingRef.current || regRef.current?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    userAppliedRef.current = true;
    waiting.postMessage({ type: "SKIP_WAITING" });
    // 兜底：个别浏览器 controllerchange 触发不稳定，3s 后强制刷新
    setTimeout(() => window.location.reload(), 3000);
  }, []);

  return {
    supported,
    status,
    currentSeq: CURRENT_SEQ,
    latestSeq,
    error,
    check,
    apply,
  };
}
