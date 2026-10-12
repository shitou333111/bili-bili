"use client";

/**
 * 模块标题右侧的文件夹图标（各页面样式一致）：
 * - output（默认）：打开统一产物目录（「礼物截图录屏」），礼物截图 / 礼物模拟录屏 / 完整录屏 三个模块共用
 * - material：打开活动素材下载目录（exe 同级「B瓜活动素材下载」）
 */

import { useCallback } from "react";
import { openMaterialFolder, openOutputFolder } from "@/lib/output-folder";
import { showToast } from "@/lib/toast";

export default function FolderIconButton({
  disabled,
  variant = "output",
}: {
  disabled?: boolean;
  variant?: "output" | "material";
}) {
  const open = useCallback(async () => {
    try {
      if (variant === "material") await openMaterialFolder();
      else await openOutputFolder();
    } catch (err) {
      showToast(`打开文件夹失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [variant]);

  const label = variant === "material" ? "打开素材文件夹" : "打开产物文件夹";

  return (
    <button
      type="button"
      onClick={() => void open()}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-black/45 transition hover:bg-black/5 hover:text-black/70 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path
          d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l1.6 2h9.4A1.5 1.5 0 0 1 21 9.5v7A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5v-9Z"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
