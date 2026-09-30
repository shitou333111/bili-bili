/**
 * 全局轻提示（toast）工具
 *
 * 通过简单的发布/订阅实现，任何组件均可调用 showToast() 弹出提示。
 * 宿主组件 ToastHost 需要在布局中挂载一次。
 *
 * 两种形态由 `kind` 决定：
 * - `info`（默认）：黑底白字胶囊，5 秒后自动消失 —— 用于下载成功之类的短提示；
 * - `error`：浅色卡片，**不自动消失**，点一下才关，并且带「复制」按钮。
 *   报错文案往往又长又关键，一闪而过等于没提示。
 */

export type ToastKind = "info" | "error";

export type Toast = {
  message: string;
  kind: ToastKind;
};

type Handler = (toast: Toast) => void;

let handler: Handler | null = null;

export function subscribeToast(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** 弹出提示。报错请传 `"error"`，让它常驻到用户点掉为止。 */
export function showToast(message: string, kind: ToastKind = "info"): void {
  if (handler) handler({ message, kind });
}