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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
/** badge 核心渐变（红→橙→黄，与粒子色相对应）；光晕层复用同一渐变保证融合一致 */
const BADGE_GRADIENT =
  "linear-gradient(90deg,hsl(0,90%,60%),hsl(30,90%,60%),hsl(60,90%,60%))";
/** 粒子聚合/滑入滑出时长（= 库 duration）；光晕 clip-path 擦除与之同步 */
const ANIM_MS = 1300;
/** 约 easeInExpo（库 easing）：与 badge 滑入/滑出同缓动，供光晕 clip-path 擦除同步显现 */
const ENTRY_EASE = "cubic-bezier(0.7, 0, 0.84, 0)";
/** 光晕最大向外扩散量（px）≈ HALO_PAD + 远端 blur 泄出：clip-path 用负 inset 保留完整辉光不被裁掉 */
const HALO_EXTENT = 40;
/**
 * 光晕向外扩展量（px，1920 设计坐标）。
 * 光晕层以绝对定位负 inset 外挂在 ParticleButton **之外**，不参与任何布局/测量：
 * - 库按其 wrapper 的 getBoundingClientRect 决定粒子 canvas 大小（wrapper 尺寸=子元素尺寸），
 *   且 wrapper 带 overflow:hidden（放进子树会被裁掉外扩光晕）；
 * - 因此粒子特效与画布虚线选择框都只匹配"排除光晕的核心 badge"尺寸，光晕纯绘制在外围。
 */
const HALO_PAD = 14;

/** 头像边长（px，1920 设计坐标）；与昵称字号同比放大，数值走内联 style（同 padding，不依赖 Tailwind 类） */
const AVATAR_SIZE = 72;
/** 昵称字号（px，1920 设计坐标） */
const NAME_FONT_SIZE = 36;

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆。无白色圆环，头像占满整个圆形区域。 */
function Avatar({ face, uname }: { face: string; uname: string }) {
  const [failed, setFailed] = useState(!face);
  if (failed) {
    return (
      <div
        className="rounded-full bg-gradient-to-br from-[#ff6699] to-[#7b5cff] flex items-center justify-center text-white"
        style={{ width: AVATAR_SIZE, height: AVATAR_SIZE, fontSize: NAME_FONT_SIZE }}
      >
        {(uname || "?")[0]}
      </div>
    );
  }
  return (
    <img
      src={face}
      alt=""
      onError={() => setFailed(true)}
      className="rounded-full object-cover"
      style={{ width: AVATAR_SIZE, height: AVATAR_SIZE }}
    />
  );
}

export default function EntryBadge({
  user,
  onDone,
  onMeasure,
}: {
  user: DisplayEntryPayload;
  onDone: () => void;
  /** 测量 badge 实际宽度（挂载后同步回调，供父级按昵称长度动态水平居中；无延迟） */
  onMeasure?: (width: number) => void;
}) {
  const [hidden, setHidden] = useState(true);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // badge 内容引用：粒子动画开始前（隐藏状态）即可测得内容宽度（transform 位移不影响 offsetWidth）
  const badgeRef = useRef<HTMLDivElement | null>(null);

  // 挂载后同步测量 badge 宽度并上报（useLayoutEffect 在浏览器绘制前执行，动画 60ms 后才开始，
  // 父级据此重算居中 x 不会产生闪烁/延迟）
  useLayoutEffect(() => {
    if (onMeasure && badgeRef.current) {
      onMeasure(badgeRef.current.offsetWidth);
    }
  }, [onMeasure]);

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
    // 最外层只做定位容器：尺寸 = ParticleButton（= 核心 badge，不含光晕）。
    // 光晕以绝对定位负 inset 外挂，不参与布局 → 库 wrapper 的 getBoundingClientRect
    // （决定粒子 canvas 大小）与父级 MovableBox 虚线选择框都只匹配核心 badge 尺寸；
    // 本容器及祖先（除画布整体 overflow）无裁剪，光晕纯绘制在外围。
    <div className="relative inline-flex">
      {/* 光晕组：三层渐进模糊的暖色辉光，外挂在 ParticleButton 之外（不参与布局/测量，
          也不被库 wrapper 的 overflow:hidden 裁剪）。整组用 clip-path 做"从右到左"的擦除显现，
          与库对 badge 内容（昵称/头像）的 translateX+裁剪滑入同向、同时长、同缓动 → 同步逐渐形成，
          而不是一次性淡入成型。hidden 时擦到最右外侧 → 完全不可见。 */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          clipPath: hidden
            ? `inset(-${HALO_EXTENT}px -${HALO_EXTENT}px -${HALO_EXTENT}px calc(100% + ${HALO_EXTENT}px))`
            : `inset(-${HALO_EXTENT}px)`,
          transition: `clip-path ${ANIM_MS}ms ${ENTRY_EASE}`,
        }}
      >
        {/* 远端大光晕：大模糊、向外大范围扩散 */}
        <div
          className="absolute pointer-events-none"
          style={{
            inset: -HALO_PAD,
            borderRadius: 999,
            background: BADGE_GRADIENT,
            filter: "blur(18px)",
            opacity: 0.5,
          }}
        />
        {/* 中层光晕：衔接远端与贴边，形成"逐渐模糊逐渐透明"的连续梯度 */}
        <div
          className="absolute pointer-events-none"
          style={{
            inset: -HALO_PAD / 2,
            borderRadius: 999,
            background: BADGE_GRADIENT,
            filter: "blur(10px)",
            opacity: 0.75,
          }}
        />
        {/* 贴边光晕：从 badge 轮廓起 blur 向外渗，把生硬的边缘线糊开 */}
        <div
          className="absolute pointer-events-none"
          style={{
            inset: -3,
            borderRadius: 999,
            background: BADGE_GRADIENT,
            filter: "blur(6px)",
            opacity: 1,
          }}
        />
      </div>
      <ParticleButton
        hidden={hidden}
        onComplete={handleComplete}
        color={PARTICLE_COLOR}
        duration={ANIM_MS}
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
        {/* 胶囊 badge（核心，唯一参与测量的元素）：头像（左）+ 昵称（右）；背景为红橙黄暖色
            渐变（0°→30°→60°），与粒子时间点色相对应：聚合时粒子沿 红→橙→黄 收拢。
            inline-flex 宽度严格按"头像+昵称+内边距"收缩自适应。
            不加 inset box-shadow：白色内发光会在 badge 边缘叠一层"白色背景"，
            与外侧三层光晕之间形成明显分界。去掉后 badge 渐变直接与同色光晕相接、无缝融合。
            不加 border：半透明白边框会在 badge 边缘形成一圈白环，同样割裂渐变与光晕。 */}
      <div
        ref={badgeRef}
        className="relative inline-flex items-center gap-6 rounded-full py-[2px]"
        style={{
          position: "relative",
          background: BADGE_GRADIENT,
          // padding 用内联 style（不依赖 Tailwind 类）：pr-6 等新增类未被打包进
          // Tailwind v4 JIT 产物，实测 paddingRight 为 0 导致昵称紧贴右边界；
          // 48px = 昵称末字到 badge 右边界间距（1920 设计坐标）
          paddingLeft: "16px",
          paddingRight: "48px",
        }}
      >
        <Avatar face={user.face} uname={user.uname} />
        <span
          className="font-bold text-white whitespace-nowrap tracking-wider"
          style={{ fontSize: NAME_FONT_SIZE }}
        >
          {user.uname}
        </span>
      </div>
      </ParticleButton>
    </div>
  );
}
