/**
 * 「原始录屏」客户端（Windows 桌面专属）。
 *
 * 职责划分：本模块当"触发脑"——阈值比较、15 秒尾窗计时、礼物名累积与文件名字串生成；
 * Rust 命令层只当"执行器"（拉 WSA / 两阶段进房 / 开录 / 收尾命名）。
 *
 * 状态机放模块级单例、不挂面板组件：录制在 Rust 侧持续进行，用户切到别的 tab 时面板会卸载，
 * 若计时器挂在组件上会丢尾窗，导致录制永不收尾。
 */

import { getPlatform } from "./platform";
import {
  displayDanmaku,
  subscribeQualifyingGift,
  type QualifyingGiftEvent,
} from "./display/danmaku";

/** 与 Rust 命令层 `RecState` 对齐（serde camelCase）。 */
export type RawRecordState = {
  state: "idle" | "starting" | "listening" | "recording" | "error";
  roomId: number | null;
  error: string | null;
};

/** Rust 侧状态事件名。 */
export const RAW_RECORD_STATE_EVENT = "wsa-recording:state";

/** 最近一次成功落盘的产物：只留文件名与生成时间（完整路径不进界面）。 */
export type RawRecordOutput = {
  name: string;
  at: number;
};

/** 「自启动」开关在 store 里的键（全账号共用）。 */
const AUTOSTART_KEY = "rawRecordAutoStart";
/** 会话/配置所在的 store 文件（与 platform/tauri.ts 的 getSessionState 同一份）。 */
const STORE_FILE = "bili-live-state.json";

/** 读「软件启动即自动开始监听」开关。 */
export async function isAutoStartEnabled(): Promise<boolean> {
  try {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(STORE_FILE, { autoSave: false });
    return (await store.get<boolean>(AUTOSTART_KEY)) ?? false;
  } catch {
    return false;
  }
}

/** 写「自启动」开关。 */
export async function setAutoStartEnabled(on: boolean): Promise<void> {
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load(STORE_FILE, { autoSave: false });
  await store.set(AUTOSTART_KEY, on);
  await store.save();
}

/** 尾窗：最后一个达标礼物之后继续录 15 秒。 */
const TAIL_MS = 15_000;

/** 阈值档位（礼物单价，电池）。`1` 是测试档：任何礼物都会触发。 */
export const RAW_RECORD_THRESHOLDS = [1, 199, 1000, 10000] as const;

/** 默认阈值（电池）。 */
export const RAW_RECORD_DEFAULT_THRESHOLD = 1000;

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (await invoke(cmd, args)) as T;
}

/** `CODE::中文` → 中文（错误码仍打到控制台，便于定位）。 */
function describeError(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  console.error("[原始录屏]", raw);
  const msg = raw.replace(/^[A-Z_]+::/, "").trim();
  return msg || "未知错误";
}

/** 本地日期 YYYYMMDD（文件名前缀）。 */
function yyyymmdd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 从完整路径里取文件名（产物只展示文件名，不展示路径）。 */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

class RawRecorder {
  private listeners = new Set<(s: RawRecordState) => void>();
  private state: RawRecordState = { state: "idle", roomId: null, error: null };
  private lastOutput: RawRecordOutput | null = null;

  private threshold: number = RAW_RECORD_DEFAULT_THRESHOLD;
  private unsubGift: (() => void) | null = null;
  private unlistenRust: (() => void) | null = null;
  private timer: number | null = null;
  /** Rust 侧已开录 */
  private recording = false;
  /** 本段录制里先后达标过的礼物名（去重、保序） */
  private names: string[] = [];
  /** 开录在途的 Promise（停止时要等它落地，避免留下"没人收尾"的录制） */
  private starting: Promise<unknown> | null = null;

  // ---------- 对外读取 ----------

  getState(): RawRecordState {
    return this.state;
  }

  /** 本会话最近一次成功落盘的产物（仅文件名 + 生成时间，未产出为 null）。 */
  getLastOutput(): RawRecordOutput | null {
    return this.lastOutput;
  }

  getThreshold(): number {
    return this.threshold;
  }

  /** 改阈值：对下一次触发即时生效（已在录的那段不受影响）。 */
  setThreshold(v: number): void {
    this.threshold = v;
  }

  subscribe(cb: (s: RawRecordState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---------- 对外动作 ----------

  /** 启动监听：复用展示模块的弹幕监听 → 拉起 WSA + B 站 APP（两阶段进房，约 30 秒）并挂 overlay。 */
  async start(roomId: number, mid: number): Promise<void> {
    if (this.state.state !== "idle" && this.state.state !== "error") return;
    const platform = await getPlatform();
    if (!platform.isNative || platform.os !== "windows") {
      this.setState({ state: "error", roomId: null, error: "原始录屏仅在 Windows 桌面版可用" });
      return;
    }
    this.names = [];
    this.recording = false;
    this.setState({ state: "starting", roomId, error: null });
    await this.ensureRustListener();
    // 先接上收礼通知（WSA 冷启动这 30 秒里的礼物不能漏），再拉 WSA
    this.subscribeGifts();
    try {
      await displayDanmaku.start(roomId, mid); // 幂等：已在监听同一房间则直接返回
      const st = await invokeCmd<RawRecordState>("start_wsa_recording", { roomId });
      this.setState({ state: st?.state ?? "listening", roomId, error: null });
    } catch (err) {
      this.setState({ state: "error", roomId, error: describeError(err) });
    }
  }

  /** 停止监听：收尾在录的那段 → 关 B 站 APP 与 WSA → 销毁 overlay。 */
  async stop(): Promise<void> {
    this.clearTail();
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        /* 开录失败已在 onGift 里处理 */
      }
      this.starting = null;
    }
    if (this.recording) await this.finishRecording();
    this.unsubGift?.();
    this.unsubGift = null;
    try {
      await invokeCmd("stop_wsa_recording");
      this.setState({ state: "idle", roomId: null, error: null });
    } catch (err) {
      this.setState({ state: "error", roomId: null, error: describeError(err) });
    }
  }

  /** 与 Rust 侧对齐一次（热更新后前端 JS 状态会重置，靠它恢复界面）。 */
  async syncStatus(): Promise<void> {
    await this.ensureRustListener();
    if (this.recording) return;
    try {
      const st = await invokeCmd<RawRecordState>("wsa_recording_status");
      this.setState({ state: st?.state ?? "idle", roomId: st?.roomId ?? null, error: st?.error ?? null });
      if (this.state.state === "listening") this.subscribeGifts();
    } catch {
      /* 非 Windows / 非 Tauri：保持 idle */
    }
  }

  /**
   * 软件启动时的自启动：开关打开且当前已有登录账号 → 自动开始监听该账号的直播间。
   * 登录态/房间号可能比组件挂载晚落地，所以带几轮重试；真正发起启动只尝试一次。
   */
  async autoStartIfEnabled(): Promise<void> {
    if (this.state.state !== "idle" && this.state.state !== "error") return;
    if (!(await isAutoStartEnabled())) return;
    let platform: Awaited<ReturnType<typeof getPlatform>>;
    try {
      platform = await getPlatform();
    } catch {
      return;
    }
    if (!platform.isNative || platform.os !== "windows") return;

    // 环境没装齐（WSA/adb/APP）就别硬启，免得一开机就抛一串错误状态
    try {
      const st = await invokeCmd<{ ready: boolean }>("wsa_setup_status");
      if (!st?.ready) return;
    } catch {
      return;
    }

    for (let i = 0; i < 10; i++) {
      if (this.state.state !== "idle" && this.state.state !== "error") return;
      try {
        const { currentSid, sessions } = await platform.getSessionState();
        const acc = sessions.find((s) => s.sid === currentSid);
        if (acc?.mid) {
          const { resolveRoomInfo } = await import("@/components/display/DisplayPanel");
          const info = await resolveRoomInfo(acc.mid);
          if (info.roomId) {
            await this.start(info.roomId, acc.mid);
            return;
          }
        }
      } catch (err) {
        console.error("[原始录屏] 自启动准备失败", err);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ---------- 内部 ----------

  private setState(patch: Partial<RawRecordState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) {
      try {
        cb(this.state);
      } catch (err) {
        console.error("[原始录屏] 状态订阅回调异常", err);
      }
    }
  }

  private async ensureRustListener(): Promise<void> {
    if (this.unlistenRust) return;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      this.unlistenRust = await listen<RawRecordState>(RAW_RECORD_STATE_EVENT, (e) => {
        const p = e.payload;
        // 是否"在录"由本模块决定（它才是触发脑），别被 Rust 的 listening 覆盖
        if (!p || this.recording) return;
        this.setState({ state: p.state, roomId: p.roomId ?? null, error: p.error ?? null });
      });
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  }

  private subscribeGifts(): void {
    if (!this.unsubGift) this.unsubGift = subscribeQualifyingGift((g) => void this.onGift(g));
  }

  /** 达标礼物：未在录则开录，已在录则只重置尾窗（15 秒内再来礼物不结束）。 */
  private async onGift(g: QualifyingGiftEvent): Promise<void> {
    // 还没进入 listening（WSA 仍在启动）时不触发，避免开录命令打空
    if (!this.recording && this.state.state !== "listening") return;
    if (!(g.priceBattery >= this.threshold)) return;
    const name = (g.giftName || "").trim() || "礼物";

    if (!this.recording) {
      // 乐观置位：连来两个礼物时不重复开录
      this.recording = true;
      this.names = [name];
      this.setState({ state: "recording", error: null });
      const p = invokeCmd<string>("start_raw_record").catch((err) => {
        this.recording = false;
        this.names = [];
        this.setState({ state: "listening", error: describeError(err) });
        throw err;
      });
      this.starting = p;
      p.catch(() => {})
        .finally(() => {
          if (this.starting === p) this.starting = null;
        });
    } else if (!this.names.includes(name)) {
      this.names.push(name);
    }
    this.resetTail();
  }

  private resetTail(): void {
    this.clearTail();
    this.timer = window.setTimeout(() => void this.finishRecording(), TAIL_MS);
  }

  private clearTail(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 尾窗到点（或手动停止）：收尾落盘，文件名「日期-礼物名1-礼物名2」。 */
  private async finishRecording(): Promise<void> {
    this.clearTail();
    if (!this.recording) return;
    this.recording = false;
    const stem = this.stem();
    this.names = [];
    this.setState({ state: "listening" });
    try {
      const path = await invokeCmd<string | null>("stop_raw_record", { fileStem: stem });
      if (path) this.lastOutput = { name: fileNameOf(path), at: Date.now() };
      this.setState({ error: null });
    } catch (err) {
      this.setState({ error: describeError(err) });
    }
  }

  private stem(): string {
    const date = yyyymmdd();
    return this.names.length ? `${date}-${this.names.join("-")}` : date;
  }
}

/** 全局单例 */
export const rawRecorder = new RawRecorder();