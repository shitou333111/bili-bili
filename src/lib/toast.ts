/**
 * 全局轻提示（toast）工具
 *
 * 通过简单的发布/订阅实现，任何组件均可调用 showToast() 弹出
 * 会自动消失的简短提示（用于下载成功等场景）。
 * 宿主组件 ToastHost 需要在布局中挂载一次。
 */

type Handler = (message: string) => void;

let handler: Handler | null = null;

export function subscribeToast(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function showToast(message: string): void {
  if (handler) handler(message);
}