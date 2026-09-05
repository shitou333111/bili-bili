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
/** 停留时长 */
const HOLD_MS = 3000;
/**
 * 完整生命周期（自然结束 ≈ 8.6s @60fps）：延迟 0.06s + 聚合滑入 1.3s + 聚合粒子尾巴 1.3s
 * + 停留 3s + 消散滑出 1.3s + 消散粒子尾巴 ~1.3s。粒子死亡按"帧数"计（库内原库公式
 * death=frames-20~+20，粒子按生成线渐进生成、死亡顺序=出生顺序），实际耗时随刷新率
 * 放大（30fps 最坏 ≈11.5s）。
 * 该值用于：画布兜底移除（防卡死）与测试循环重挂载周期，须大于自然生命周期，
 * 否则会在粒子尚在飞散时强拆 badge，造成"消散被截断"（之前 6000ms 会在消散中途截断）。
 */
export const ENTRY_TOTAL_MS = 12000;
/** 粒子颜色：仅作 fallback（库内已按时间点映射到红橙黄暖色相区间 0°~60°） */
const PARTICLE_COLOR = "#003ff1";

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆。无白色圆环，头像占满整个圆形区域。 */
function Avatar({ face, uname }: { face: string; uname: string }) {
  const [failed, setFailed] = useState(!face);
  if (failed) {
    return (
      <div className="w-14 h-14 rounded-full bg-gradient-to-br from-[#ff6699] to-[#7b5cff] flex items-center justify-center text-white text-[28px]">
        {(uname || "?")[0]}
      </div>
    );
  }
  return (
    <img
      src={face}
      alt=""
      onError={() => setFailed(true)}
      className="w-14 h-14 rounded-full object-cover"
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
      color={PARTICLE_COLOR}
      duration={1300}
      // 以下参数除 size/speed 外与库官方 demo 第 5 个 "Refresh" 按钮完全一致
      // （example/src/demos.js）：duration:1300 / easing:'easeInExpo' / size:3 / speed:1 /
      // particlesAmountCoefficient:10 / oscillationCoefficient:1 / direction 默认 'left'。
      //
      // size 与 speed 有意改回"原库默认随机函数"（defaultProps 中 size=1~3 随机、
      // speed=rand(4)≈±2 随机）：demo #5 的固定 speed=1 会让同一帧生成的所有粒子
      // x 位移完全同步（初始位移 -speed×frames 与逐帧增量 +speed 都相同），整帧上千
      // 粒子堆在同一 x 坐标、铺满 badge 高度 → 视觉上呈"竖直对齐成一条竖线"水平扫过，
      // 没有原库 demo 的分散飘逸感（已用 _probe_js/line-check.cjs 复刻粒子运动模拟证实：
      // 固定 speed 首帧仅 1 个不同 x 坐标，随机 speed 有上千个）。恢复随机后粒子速度
      // 各异、大小参差，水平散开成片，还原原库 demo 的粒子聚散效果。
      easing="easeInExpo"
      size={() => Math.floor(Math.random() * 4 + 3)}
      speed={() => Math.random() * 4 - 2}
      particlesAmountCoefficient={15}
      oscillationCoefficient={1}
      className="pointer-events-none"
    >
      {/* 胶囊 badge：头像（左）+ 昵称（右）；背景为红橙黄暖色渐变（0°→30°→60°），
          与粒子时间点色相对应：聚合时粒子沿 红→橙→黄 收拢，消散时反向退色。
          inline-flex：宽度严格按"头像+昵称+内边距"收缩自适应，不被父级 block 拉伸成固定宽 */}
      <div
        className="inline-flex items-center gap-6 rounded-full py-[2px] border border-white/30"
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
          // 48px = 昵称末字到 badge 右边界间距（1920 设计坐标）
          paddingLeft: "16px",
          paddingRight: "48px",
        }}
      >
        <Avatar face={user.face} uname={user.uname} />
        <span className="text-[28px] font-bold text-white whitespace-nowrap tracking-wider">
          {user.uname}
        </span>
      </div>
    </ParticleButton>
  );
}
