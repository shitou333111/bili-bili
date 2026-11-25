/**
 * /sing/<uid> 用户歌单固定地址
 *
 * 任意添加过 UID 的用户都可以通过自己的固定地址被查看；
 * 打开的是自己的 UID 时仍可编辑（等同 /sing）。
 */
import SingClient from "@/components/sing/SingClient";

/**
 * 静态导出（桌面端 output: export）要求动态段能预生成参数，否则构建直接失败。
 * 桌面端不会打开 /sing/<uid>（「歌单网站」走外部浏览器访问服务器地址），
 * 因此导出时给一个占位参数即可；Web 构建返回空数组，保持任意 UID 动态渲染。
 */
export function generateStaticParams() {
  return process.env.TAURI_BUILD === "1" ? [{ uid: "0" }] : [];
}

export default async function Page({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  return <SingClient routeUid={uid} />;
}
