"use client";

/**
 * 「完整录屏」模块（主播 → 大礼物 页）。
 *
 * 只是"启动/停止"的按钮与状态展示：阈值比较、15 秒尾窗、礼物名累积都在
 * `@/lib/wsa-recorder-client` 的单例里（面板卸载不会中断录制与尾窗）。
 *
 * 仅 Windows 桌面客户端可用（依赖 WSA + Windows Graphics Capture），其它平台整体置灰。
 * 首次使用要先在「插件」里装齐 ADB / WSA / B 站 APP —— 未装齐时开始按钮置灰。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveRoomInfo } from "@/components/display/DisplayPanel";
import { getPlatform, isWindowsDisplaySupported } from "@/lib/platform";
import { showToast } from "@/lib/toast";
import {
  RAW_RECORD_THRESHOLDS,
  isAutoStartEnabled,
  rawRecorder,
  setAutoStartEnabled,
  type RawRecordOutput,
  type RawRecordState,
} from "@/lib/wsa-recorder-client";
import FolderIconButton from "@/components/FolderIconButton";

const STATUS_TEXT: Record<RawRecordState["state"], string> = {
  idle: "未启动",
  starting: "正在打开录屏APP···",
  listening: "监听礼物，自动录制中···",
  recording: "礼物录屏中···",
  error: "启动失败",
};

/** 环境检测结果（与 Rust `SetupStatus` 对齐）。 */
type SetupStatus = {
  supported: boolean;
  ready: boolean;
  platform: string;
  wsa: boolean;
  adb: boolean;
  apk: boolean;
};

/** 安装进度（与 Rust `wsa-setup:progress` 事件负载对齐）。 */
type SetupProgress = {
  step: number;
  phase: string;
  message: string;
  received: number;
  total: number;
};

const SETUP_PROGRESS_EVENT = "wsa-setup:progress";

/** 按钮里那三个指示灯的键与顺序：**与安装顺序一致**（见 Rust `STEP_ADB`：adb → WSA → APP）。 */
const SETUP_LIGHTS = ["adb", "wsa", "apk"] as const;

/**
 * 指示灯配色。安装中按进度点亮（已过的步骤绿、当前琥珀、未开始灰），
 * 否则按检测结果（就绪绿、未就绪灰）。`index` 从 0 起、`step` 从 1 起。
 */
function lightClass(index: number, ok: boolean, busy: boolean, step: number) {
  if (!busy || step <= 0) return ok ? "bg-emerald-500" : "bg-black/25";
  if (index + 1 < step) return "bg-emerald-500";
  return index + 1 === step ? "bg-amber-500" : "bg-black/25";
}

async function invokeCmd<T>(cmd: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke(cmd)) as T;
}

/** 时间戳 → 「YYYY-MM-DD HH:mm」。 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 字节数 → 人类可读。 */
function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

export default function RawRecordPanel({ mid }: { mid: number }) {
  const [status, setStatus] = useState<RawRecordState>(rawRecorder.getState());
  const [threshold, setThreshold] = useState<number>(rawRecorder.getThreshold());
  const [lastOutput, setLastOutput] = useState<RawRecordOutput | null>(rawRecorder.getLastOutput());
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const [defaultRoomId, setDefaultRoomId] = useState<number | null>(null);

  const [autoStart, setAutoStart] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  /** 「首次安装」确认框：安装要下载几百兆，先让用户读完注意事项再动手 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 进度事件只在本面板发起安装期间才认（避免全局事件污染） */
  const setupBusyRef = useRef(false);

  const refreshSetup = useCallback(async () => {
    try {
      setSetup(await invokeCmd<SetupStatus>("wsa_setup_status"));
    } catch {
      setSetup(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    getPlatform()
      .then((p) => {
        if (!alive) return;
        const ok = isWindowsDisplaySupported(p);
        setSupported(ok);
        return ok ? refreshSetup() : undefined;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [refreshSetup]);

  useEffect(() => {
    // 热更新后前端 JS 状态会重置，靠它跟 Rust 侧对齐一次
    void rawRecorder.syncStatus();
    return rawRecorder.subscribe((s) => {
      setStatus(s);
      setLastOutput(rawRecorder.getLastOutput());
    });
  }, []);

  // 默认直播间号：当前登录账号对应的直播间（输入框可覆盖）
  useEffect(() => {
    let alive = true;
    resolveRoomInfo(mid)
      .then((info) => {
        if (alive) setDefaultRoomId(info.roomId);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mid]);

  // 自启动开关：全账号共用，落盘保存
  useEffect(() => {
    let alive = true;
    isAutoStartEnabled()
      .then((v) => {
        if (alive) setAutoStart(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 阈值档位：同样落盘保存，下次启动沿用上次的选择
  useEffect(() => {
    let alive = true;
    rawRecorder
      .restoreThreshold()
      .then((v) => {
        if (alive) setThreshold(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 安装进度：下载/解压/安装各阶段的结果回执
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<SetupProgress>(SETUP_PROGRESS_EVENT, (e) => {
          if (alive && setupBusyRef.current && e.payload) setProgress(e.payload);
        });
        unlisten = off;
      } catch {
        /* 非 Tauri 环境忽略 */
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const active =
    status.state === "listening" || status.state === "recording" || status.state === "starting";
  const envReady = setup?.ready === true;
  const canStart = supported && envReady && !active && !busy;
  const canStop = supported && active && !busy;

  const start = useCallback(async () => {
    if (!supported || !envReady) return;
    setBusy(true);
    try {
      let rid = Number(roomInput.trim()) || 0;
      if (!rid) {
        const info = await resolveRoomInfo(mid);
        rid = info.roomId;
        setDefaultRoomId(rid);
      }
      await rawRecorder.start(rid, mid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`启动失败：${msg.replace(/^[A-Z_]+::/, "")}`, "error");
      // 启动失败往往是环境变了（典型：WSA 里的 B 站 APP 被手动卸载）——
      // 立刻重查一次环境，让卡片回到红灯、用户能直接点按钮补装
      await refreshSetup();
    } finally {
      setBusy(false);
    }
  }, [envReady, mid, refreshSetup, roomInput, supported]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await rawRecorder.stop();
    } finally {
      setBusy(false);
    }
  }, []);

  /** 走一遍「下载 → 解压 → 安装」，已装好的步骤由后端自动跳过。 */
  const runInstall = useCallback(async () => {
    setProgress({ step: 0, phase: "start", message: "开始检测并安装所需环境…", received: 0, total: 0 });
    try {
      const st = await invokeCmd<SetupStatus>("wsa_setup_install");
      setSetup(st);
      showToast(st.ready ? "插件安装完成，可以开始录屏了" : "安装流程已结束，但仍有未就绪的项");
    } catch (err) {
      const msg = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
      if (msg.startsWith("CANCELLED")) {
        showToast("已中止安装，已下载 / 已解压的部分会保留，下次接着进行");
      } else {
        showToast(`安装失败：${msg.replace(/^[A-Z_]+::/, "")}`, "error");
      }
      await refreshSetup();
    }
  }, [refreshSetup]);

  /** 中止正在进行的安装：置后端标志，下载/解压/等待各环节会尽快收手（不删已完成的部分）。 */
  const abortInstall = useCallback(async () => {
    try {
      await invokeCmd<void>("wsa_setup_abort");
      showToast("正在中止安装…");
    } catch {
      showToast("中止失败，请稍后重试", "error");
    }
  }, []);

  /**
   * 环境按钮的唯一动作：**先检测**。
   * 绿灯时点它就是纯检测（等于原来的「重新检测」）；红灯时弹出「首次安装」提示框，
   * 用户读完点确认才真正开始安装。
   */
  const setupAction = useCallback(async () => {
    if (setupBusyRef.current) return;
    setupBusyRef.current = true;
    setSetupBusy(true);
    try {
      const st = await invokeCmd<SetupStatus>("wsa_setup_status");
      setSetup(st);
      if (st.ready) showToast("插件已安装，环境就绪");
      else setConfirmOpen(true);
    } catch {
      showToast("检测失败，请稍后重试", "error");
    } finally {
      setupBusyRef.current = false;
      setSetupBusy(false);
    }
  }, []);

  /** 确认框里点「开始安装」：跑完整安装流程（busy 与实际安装同生命周期）。 */
  const confirmInstall = useCallback(async () => {
    setConfirmOpen(false);
    if (setupBusyRef.current) return;
    setupBusyRef.current = true;
    setSetupBusy(true);
    try {
      await runInstall();
    } finally {
      setupBusyRef.current = false;
      setSetupBusy(false);
      setProgress(null);
    }
  }, [runInstall]);

  const toggleAutoStart = useCallback(async () => {
    const next = !autoStart;
    setAutoStart(next);
    try {
      await setAutoStartEnabled(next);
    } catch {
      setAutoStart(!next);
      showToast("保存自启动设置失败", "error");
    }
  }, [autoStart]);

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0;

  return (
    <section>
      {/* 标题居中 + 文件夹图标，与「展示」页模块卡片保持一致 */}
      <h3 className="mb-2.5 flex items-center justify-center gap-1 text-center text-sm font-bold text-black/75">
        礼物完整录屏
        <FolderIconButton disabled={!supported} />
      </h3>
      <div
        className={`space-y-4 rounded-2xl border border-amber-400 bg-amber-200 p-4 shadow-[0_1px_2px_rgba(31,28,23,0.04)] ${
          supported ? "" : "opacity-50"
        }`}
      >
        <p className="text-xs leading-relaxed text-black/50">
          自动录制收到礼物时的完整直播画面，包括PK分数 弹幕 飘屏，和自己手机录制的完全一样。首次使用会安装插件，比较耗时，需要在弹出的APP内登录一次。
        </p>

        {/* 首次安装提示 */}
        {/* {supported && !envReady && !setupBusy ? (
          <p className="text-xs leading-relaxed text-black/50">
            首次使用需安装三样工具：ADB、WSA、哔哩哔哩客户端。占用磁盘与内存较多，并需要一次管理员授权；
            这些工具全账号共用，装一次即可，切换账号不会重复安装。
          </p>
        ) : null} */}

        {/* 安装进度与结果回执 */}
        {setupBusy && progress ? (
          <div className="rounded-lg border border-black/10 bg-white/70 p-3 text-xs leading-relaxed text-black/60">
            <div>
              {progress.step > 0 ? `第 ${progress.step} / 3 步：${progress.message}` : progress.message}
            </div>
            {progress.total > 0 ? (
              <>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/10">
                  <div
                    className="h-full rounded-full bg-[#1f1c17] transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1 text-black/40">
                  {formatBytes(progress.received)} / {formatBytes(progress.total)}（{pct}%）
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {/* 插件安装按钮在左、房间号在右：两端对齐铺满一行（窄窗口下按钮自动换行） */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs">
          {/* 环境状态：红灯 = 未装齐，绿灯 = 已就绪。两种情况都可点：先检测，缺什么装什么 */}
          {supported ? (
            <button
              type="button"
              onClick={() => void (setupBusy ? abortInstall() : setupAction())}
              title={
                setupBusy
                  ? "点击中止当前安装（已下载 / 已解压的部分会保留，下次接着进行）"
                  : envReady
                    ? "点击可重新检测环境是否完整"
                    : "点击自动检测并安装缺少的组件（已装好的会跳过）"
              }
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1 text-xs font-medium transition ${
                setupBusy
                  ? "border-black/20 bg-black/10 text-black/70 hover:bg-black/20"
                  : envReady
                    ? "border-emerald-300 bg-emerald-100 text-black/70 hover:bg-emerald-200"
                    : "border-red-300 bg-red-100 text-black/75 hover:bg-red-200"
              }`}
            >
              {setupBusy ? "安装中··· 点击中止" : envReady ? "插件已安装" : "首次使用点击安装插件"}
              {/* 三个指示灯（ADB / WSA / APP）：全绿 = 插件已安装，不再另加文字标签 */}
              <span className="flex shrink-0 items-center gap-1">
                {SETUP_LIGHTS.map((k, i) => (
                  <span
                    key={k}
                    className={`h-1.5 w-1.5 rounded-full ${lightClass(
                      i,
                      setup?.[k] === true,
                      setupBusy,
                      progress?.step ?? 0
                    )}`}
                  />
                ))}
              </span>
            </button>
          ) : null}

          <span className="flex items-center gap-2">
            <span className="shrink-0 text-black/45">指定房间号</span>
            <input
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value.replace(/[^\d]/g, ""))}
              disabled={!supported || active}
              placeholder={defaultRoomId ? `默认 ${defaultRoomId}` : "留空用当前账号直播间"}
              className="w-[150px] rounded-lg border border-black/10 bg-white/90 px-2 py-1 text-xs text-black/75 outline-none transition placeholder:text-black/30 focus:bg-white disabled:opacity-50"
            />
            <span className="shrink-0 whitespace-nowrap text-black/35" title="仅决定录屏监听哪个房间的礼物，不影响展示、礼物统计等模块的直播间">
              仅用于录屏
            </span>
          </span>
        </div>

        {/* 阈值组在最左：标题在上、档位按钮在下（两行）；与启停按钮、自启动横向均匀分布 */}
        <div className="flex items-end justify-between">
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-black/45">录屏礼物触发阈值（电池）</span>
            <div className="flex w-fit overflow-hidden rounded-lg border border-black/10">
              {RAW_RECORD_THRESHOLDS.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={!supported}
                  onClick={() => {
                    rawRecorder.setThreshold(v);
                    setThreshold(v);
                  }}
                  className={`px-2.5 py-1 transition disabled:opacity-50 ${
                    threshold === v ? "bg-[#1f1c17] text-white" : "bg-white/90 text-black/60 hover:bg-white"
                  }`}
                >
                  ≥{v}
                </button>
              ))}
            </div>
          </div>

          {/* 启停合并为一个按钮：同一个功能的两个状态，文案与配色随状态切换 */}
          <button
            type="button"
            onClick={() => (active ? void stop() : void start())}
            disabled={active ? !canStop : !canStart}
            className={`rounded-lg px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
              active
                ? "bg-red-500 text-white hover:bg-red-600"
                : "bg-[#1f1c17] text-white hover:opacity-90"
            }`}
          >
            {active ? "停止自动录屏" : "启动自动录屏"}
          </button>

          {/* 自启动开关：标题在上、开关在下 */}
          <label
            className="flex cursor-pointer flex-col gap-1 text-xs text-black/45 select-none"
            title="打开后，每次启动软件都会自动开始监听录制"
          >
            <span>自启动</span>
            <button
              type="button"
              role="switch"
              aria-checked={autoStart}
              disabled={!supported || setupBusy}
              onClick={() => void toggleAutoStart()}
              className={`relative h-4 w-7 rounded-full transition disabled:opacity-40 ${
                autoStart ? "bg-emerald-500" : "bg-black/20"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all ${
                  autoStart ? "left-3.5" : "left-0.5"
                }`}
              />
            </button>
          </label>
        </div>

        <div className="rounded-lg border border-black/10 bg-amber-100 p-3 text-xs leading-relaxed text-black/60">
          <div>
            {STATUS_TEXT[status.state]}
            {status.state === "error" && status.error ? `：${status.error}` : ""}
          </div>
          {active && status.state === "listening" && status.error ? (
            <div className="mt-1 text-black/45">{status.error}</div>
          ) : null}
          {lastOutput ? (
            <div className="mt-1 text-black/45">
              最新录屏：{formatTime(lastOutput.at)}　{lastOutput.name}
            </div>
          ) : null}
          {!supported ? <div className="mt-1 text-black/45">该功能仅 Windows 桌面客户端可用</div> : null}
        </div>
      </div>

      {/* 「首次安装」确认框：安装前让用户先读完注意事项，确认后再动手 */}
      {confirmOpen ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pb-4 pt-5">
              <h4 className="text-center text-sm font-bold text-black/80">安装前请注意</h4>
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-black/70">
                <li>安装过程中会出现多个弹窗，如果没有在 3 秒内自动消失，就手动点击按钮「是」。</li>
                <li>下载插件网络较慢，比较耗时，有时会中断，那就再次点击按钮重新安装。</li>
                <li>插件安装是一次性的，以后直接点击「启动自动录屏」即可。</li>
                <li>第一次启动录屏，需要在 B 站 APP 内登录，和正常的 APP 操作一样。</li>
                <li>插件安装复杂，如果自动安装失败，可以B站私信作者帮助安装。</li>
              </ol>
            </div>
            <div className="flex gap-2 border-t border-black/10 px-5 py-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 rounded-lg border border-black/10 bg-white py-2 text-xs font-medium text-black/70 transition hover:bg-black/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmInstall()}
                className="flex-1 rounded-lg bg-[#1f1c17] py-2 text-xs font-medium text-white transition hover:opacity-90"
              >
                开始安装
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}