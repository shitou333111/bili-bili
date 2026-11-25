/**
 * /sing/<uid> 用户歌单固定地址
 *
 * 任意添加过 UID 的用户都可以通过自己的固定地址被查看；
 * 打开的是自己的 UID 时仍可编辑（等同 /sing）。
 */
import SingClient from "@/components/sing/SingClient";

export default async function Page({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  return <SingClient routeUid={uid} />;
}
