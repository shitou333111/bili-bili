/**
 * 展示模块 —— 启动时自动恢复。
 *
 * 业务规则：当"展示总开关"开启时，软件启动后应自动启动本地浏览器源 HTTP+WS 服务并恢复对该
 * 账号直播间的弹幕监听（礼物展示 / 入场提示 / 入场动画 / 盲盒盈亏查询等全部监听），无需用户
 * 打开"展示"面板。浏览器源服务本身无窗口，直播姬添加浏览器源后即可透明叠加。
 *
 * 健壮性：
 *  - 刚启动时各进程 / 网络可能繁忙，网络解析房间号可能失败 → 只把"已成功"标记为完成，
 *    失败时自动延迟重试（指数退避，若干次后放弃），不阻塞主流程。
 *  - 幂等：displayDanmaku.start() 对同一房间重复调用会直接忽略，后续打开"展示"面板不会重复监听。
 */
import { getPlatform } from "@/lib/platform";
import { loadDisplayConfig } from "./config";
import { displayDanmaku } from "./danmaku";
import { resolveRoomInfo } from "@/components/display/DisplayPanel";

// 已成功自动恢复（防 StrictMode / 多次账号切换重复成功恢复）
let done = false;
// 正在进行的尝试（合并并发调用，避免 StrictMode 双跑各自重试叠加）
let inFlight = false;
let attempts = 0;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 4000;

/**
 * 在应用启动、账号就绪后调用：若展示总开关开启且为本机本地账号，则自动启动浏览器源服务
 * 并恢复全部弹幕监听。整体非阻塞；失败会异步重试。
 */
export function autoStartDisplay(mid: number, isLocalAccount: boolean): Promise<void> {
  return autoStartOnce(mid, isLocalAccount);
}

async function autoStartOnce(mid: number, isLocalAccount: boolean): Promise<void> {
  if (done || inFlight || !mid) return;
  // 前置条件即时判定（本地账号 / 未开总开关）→ 不需要重试
  const platform = await getPlatform().catch(() => null);
  if (!platform || !platform.isNative || !isLocalAccount) return;
  const cfg = await loadDisplayConfig().catch(() => null);
  if (!cfg || !cfg.master) return;

  inFlight = true;
  try {
    attempts += 1;
    const roomInfo = await resolveRoomInfo(mid); // 网络调用，刚启动可能繁忙
    // 浏览器源架构下无画布窗口：启动本地 HTTP+WS 服务（Rust 端绑定 127.0.0.1:25100 起端口）。
    await displayDanmaku.startServer();
    await displayDanmaku.start(roomInfo.roomId, mid); // 开启全部弹幕监听（幂等）
    done = true;
    attempts = 0;
    console.log("[展示] 启动自动恢复：已启动浏览器源服务并开始全部监听", { roomId: roomInfo.roomId });
  } catch (e) {
    console.warn(`[展示] 启动自动恢复失败（${attempts}/${MAX_ATTEMPTS}），稍后重试`, (e as Error)?.message || e);
    if (attempts < MAX_ATTEMPTS) {
      const delay = RETRY_BASE_MS * attempts; // 指数退避：4s → 8s → 12s → …
      setTimeout(() => {
        inFlight = false;
        void autoStartOnce(mid, isLocalAccount);
      }, delay);
      return;
    }
    console.warn("[展示] 启动自动恢复多次失败，放弃（用户打开'展示'面板可手动开启）", e);
  }
  inFlight = false;
}