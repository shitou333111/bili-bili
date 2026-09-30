"use client";

/**
 * 全局常驻（挂在根布局）：软件启动时若「自启动」开关打开，则自动开始监听录制。
 *
 * 放在根布局而不是面板里：录制要在"打开软件就启动"，而面板只在用户切到
 * 大礼物页时才挂载 —— 挂面板里就达不到"自启动"的效果。
 */

import { useEffect } from "react";
import { rawRecorder } from "@/lib/wsa-recorder-client";

export default function RawRecordAutoStarter() {
  useEffect(() => {
    void rawRecorder.autoStartIfEnabled();
  }, []);
  return null;
}