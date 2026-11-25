"use client";

/**
 * /sing 点歌机歌单页（自己的本地 UID）
 *
 * 具体实现见 components/sing/SingClient；固定地址 /sing/<uid> 复用同一组件。
 */
import SingClient from "@/components/sing/SingClient";

export default function Page() {
  return <SingClient />;
}
