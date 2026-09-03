"use client";

/**
 * 粒子入场提示 —— 使用 react-particle-effect-button（用户最初推荐的库）。
 *
 * 流程：初始隐藏 → 短暂延迟后 hidden=false（粒子聚合 + badge 随库原生动画滑入，
 * 与粒子同步）→ 停留 3s → hidden=true（badge 随库原生动画滑出 + 粒子同步消散）→ 通知父组件。
 *
 * badge 不做额外的透明度 gating：库在聚合/消散期间对内容做 transform 滑入/滑出，
 * 天然与粒子动画同步（同一 duration/easing）。若再手动隐藏 badge 反而会造成
 * "提前全部消失 / 最后一次性显示" 的错位。
 *
 * 测试循环不在本组件内做"自动重新聚合"（库的 hidden 翻转在第二轮不再触发聚合），
 * 而是由父组件在 onDone 后用新的 key 重新挂载本组件，每轮都是全新一轮动画；
 * 组件常驻不卸载，粒子隐藏间隙内容仍占位，外层虚线框不消失。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ParticleButton from "react-particle-effect-button";
import type { DisplayEntryPayload } from "@/lib/display/types";

/** 首次出现前的延迟（让粒子动画在挂载后启动） */
const SHOW_DELAY_MS = 60;
/** 聚合成型后停留时长 */
const HOLD_MS = 3000;
/** 完整生命周期（延迟 0.06s + 聚合 1.3s + 停留 3s + 消散 1.3s ≈ 5.7s），供画布兜底移除使用 */
export const ENTRY_TOTAL_MS = 6000;
/** 粒子颜色：仅作 fallback（库内已按时间点映射到红橙黄暖色相区间 0°~60°） */
const PARTICLE_COLOR = "#003ff1";

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆。无白色圆环，头像占满整个圆形区域。 */
function Avatar({ face, uname }: { face: string; uname: string }) {
  const [failed, setFailed] = useState(!face);
  if (failed) {
    return (
      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#ff6699] to-[#7b5cff] flex items-center justify-center text-white text-sm">
        {(uname || "?")[0]}
      </div>
    );
  }
  return (
    <img
      src={face}
      alt=""
      onError={() => setFailed(true)}
      className="w-7 h-7 rounded-full object-cover"
    />
  );
}

export default function EntryBadge({
  user,
  onDone,
}: {
  user: DisplayEntryPayload;
  onDone: () => void;
}) {
  const [hidden, setHidden] = useState(true);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 挂载后触发"聚合"动画（每次挂载都是全新一轮：聚合 → 停留 → 消散 → onDone）
  useEffect(() => {
    const t = setTimeout(() => {
      setHidden(false);
    }, SHOW_DELAY_MS);
    return () => {
      clearTimeout(t);
    };
  }, [user.uid, user.uname]);

  // 粒子动画完成回调：聚合完成 → 开始停留计时；消散完成 → 由父组件决定下一轮（重新挂载以规避
  // 库内部 hidden 翻转在第二轮不触发聚合的缺陷）。
  const handleComplete = useCallback(() => {
    if (!hiddenRef.current) {
      if (holdTimerRef.current) return;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        setHidden(true);
      }, HOLD_MS);
    } else {
      doneRef.current();
    }
  }, []);

  return (
    <ParticleButton
      hidden={hidden}
      onComplete={handleComplete}
      // 严格使用库 demo 第 5 个 "Refresh" 按钮的参数（duration/easing/size/speed/
      // particlesAmountCoefficient/oscillationCoefficient/direction 与 demo 完全一致，
      // direction 不设置使用默认 'left' 水平聚合方向）。content 与粒子的进度由库内同一
      // duration + easing 驱动，天然同步：粒子先逐渐聚合，badge 随之形成，消散时再随粒子散开。
      color={PARTICLE_COLOR}
      duration={1300}
      easing="easeInOutCubic"
      size={2}
      speed={1}
      particlesAmountCoefficient={20}
      oscillationCoefficient={1}
      className="pointer-events-none"
    >
      {/* 胶囊 badge：头像（左）+ 昵称（右）；背景为红橙黄暖色渐变（0°→30°→60°），
          与粒子时间点色相对应：聚合时粒子沿 红→橙→黄 收拢，消散时反向退色。
          inline-flex：宽度严格按"头像+昵称+内边距"收缩自适应，不被父级 block 拉伸成固定宽 */}
      <div
        className="inline-flex items-center gap-3 rounded-full py-0.5 border border-white/30 shadow-[0_3px_14px_rgba(0,0,0,0.30)]"
        style={{
          background:
            "linear-gradient(90deg,hsl(0,90%,60%),hsl(30,90%,60%),hsl(60,90%,60%))",
          // 渐变铺满整个 border-box（默认 background-origin 为 padding-box，只铺到 padding 区，
          // 导致两端 1px 半透明白 border 环落在渐变之外、被浏览器填充成"对侧端色"——
          // 左端(红侧)环显示黄色、右端(黄侧)环显示红色。改为 border-box 后 0% 红 / 100% 黄
          // 正好落在两端边框环下方，两端尖角颜色恢复正常。
          backgroundOrigin: "border-box",
          // padding 用内联 style（不依赖 Tailwind 类）：pr-6 等新增类未被打包进
          // Tailwind v4 JIT 产物，实测 paddingRight 为 0 导致昵称紧贴右边界；
          // pr-6 = 24px（昵称末字到 badge 右边界间距）
          paddingLeft: "8px",
          paddingRight: "24px",
        }}
      >
        <Avatar face={user.face} uname={user.uname} />
        <span className="text-sm font-bold text-white whitespace-nowrap tracking-wider">
          {user.uname}
        </span>
      </div>
    </ParticleButton>
  );
}
