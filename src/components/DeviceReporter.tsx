"use client";

import { useEffect } from "react";
import { collectUserDeviceInfo } from "@/lib/device";
import { isTauri, serverPost } from "@/lib/server-api";
import { getPlatform } from "@/lib/platform";

/**
 * 常驻设备信息上报组件（渲染空内容）。
 *
 * 启动时采集平台（web/电脑/安卓/ios）与设备信息（品牌/系统版本/浏览器）上报到
 * /api/user/report，由服务端记录到 users-list.json，供 admin 用户列表展示。
 *
 * 节流：同一设备+用户 24 小时内只上报一次；仅在服务端确认 recorded 后才写节流标记，
 * 避免未登录时先写标记导致登录后 24 小时内不补报。
 */

const STORAGE_KEY = "bili_live_device_report";
const THROTTLE_MS = 24 * 60 * 60 * 1000;

type ReportMark = { sig: string; mid: number; ts: number };

function readMark(): ReportMark | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReportMark;
    return typeof parsed?.sig === "string" && typeof parsed?.ts === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export default function DeviceReporter() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const device = await collectUserDeviceInfo();
        if (cancelled) return;

        // 设备签名：同一设备+同一用户 24h 内不重报
        const sig = [
          device.platform,
          device.brand ?? "",
          device.os ?? "",
          device.osVersion ?? "",
          device.browser ?? "",
        ].join("|");

        // Tauri 端登录态在本地，带上 mid/uname；Web 端由服务端按会话 cookie 解析
        let mid = 0;
        let uname = "";
        if (isTauri()) {
          try {
            const state = await (await getPlatform()).getSessionState();
            const session = state.sessions.find((s) => s.sid === state.currentSid);
            if (session && session.mid > 0) {
              mid = session.mid;
              uname = session.uname;
            }
          } catch {
            /* 读取本地会话失败则不带身份 */
          }
        }

        const mark = readMark();
        if (mark && mark.sig === sig && mark.mid === mid && Date.now() - mark.ts < THROTTLE_MS) {
          return;
        }

        const resp = await serverPost<{ code: number; data?: { recorded?: boolean } }>(
          "/api/user/report",
          { mid, uname, device },
        );
        if (resp?.code === 0 && resp.data?.recorded) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ sig, mid, ts: Date.now() } satisfies ReportMark));
          } catch {
            /* 存储失败下次再报 */
          }
        }
      } catch {
        /* 上报失败静默，不影响使用 */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
