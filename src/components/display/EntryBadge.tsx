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
/**
 * badge 背景专用：同一渐变但颜色整体带 50% alpha —— badge 底与三层光晕整体半透明，
 * 更易与底层直播画面融合；头像/昵称元素不使用它，保持完全不透明。
 * （用带 alpha 的渐变而非对整个 badge 设 opacity：opacity 会作用于子元素，
 *   头像/昵称也会跟着变透明。）
 */
const BADGE_GRADIENT_50 =
  "linear-gradient(90deg,hsla(0,90%,60%,0.5),hsla(30,90%,60%,0.5),hsla(60,90%,60%,0.5))";
/** 光晕组整体不透明度：与 badge 背景的 50% alpha 对齐，整个入场提示半透明融入直播画面 */
const GLOW_OPACITY = 0.5;
/** 粒子聚合/滑入滑出时长（= 库 duration）；光晕滑动窗口擦除与之同步 */
const ANIM_MS = 1300;
/** 消散缓动 ≈ 库侧 easeInExpo（慢→快）：光晕滑动窗口擦除与 badge 滑出同缓动 */
const ENTRY_EASE = "cubic-bezier(0.7, 0, 0.84, 0)";
/**
 * 聚合缓动 = ENTRY_EASE 的时间反演（快→慢）：Expo 家族的 Out 贝塞尔，
 * 与库侧补丁 17 给"聚合"传入的 easeOutExpo 是同一条曲线。
 * 揭示比例 = 1 - progress/100 = easeOutExpo(t/ANIM_MS)，与光晕窗口擦除的比例完全一致。
 */
const ENTRY_EASE_MIRROR = "cubic-bezier(0.19, 1, 0.22, 1)";
/** 光晕最大向外扩散量（px）≈ HALO_PAD + 远端 blur 泄出：滑动窗口裁剪框向外扩出该量，保留完整辉光不被裁掉 */
const HALO_EXTENT = 40;
/**
 * 光晕向外扩展量（px，1920 设计坐标）。
 * 光晕层以绝对定位负 inset 外挂在 ParticleButton **之外**，不参与任何布局/测量：
 * - 库按其 wrapper 的 getBoundingClientRect 决定粒子 canvas 大小（wrapper 尺寸=子元素尺寸），
 *   且 wrapper 带 overflow:hidden（放进子树会被裁掉外扩光晕）；
 * - 因此粒子特效与画布虚线选择框都只匹配"排除光晕的核心 badge"尺寸，光晕纯绘制在外围。
 */
const HALO_PAD = 14;

/** 头像边长（px，1920 设计坐标）；数值走内联 style（同 padding，不依赖 Tailwind 类） */
const AVATAR_SIZE = 96;
/** 昵称字号（px，1920 设计坐标）；比头像放大幅度更大（72/96 vs 原 52/84），昵称在 badge 中占比更高 */
const NAME_FONT_SIZE = 72;

/** 头像：face 缺失/加载失败时回退为昵称首字渐变圆。无白色圆环，头像占满整个圆形区域。 */
function Avatar({ face, uname }: { face: string; uname: string }) {
  const [failed, setFailed] = useState(!face);
  if (failed) {
    return (
      <div
        className="rounded-full bg-gradient-to-br from-[#ff6699] to-[#7b5cff] text-white"
        style={{
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          fontSize: NAME_FONT_SIZE,
          // 居中与行高走内联 style（同 badge padding，不依赖 Tailwind 类）；
          // lineHeight:1 消除 line-height normal 的字体行盒不对称，首字在圆内完全居中
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 1,
        }}
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
  // onDone 只允许触发一次：库内 _loop 在粒子跑空时可多次进入 onComplete，双 onDone 会
  // 让父级双 shift 队列/双 notifyEffectPlay（跳过排队入场、重复播报）
  const doneFiredRef = useRef(false);
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
      if (doneFiredRef.current) return;
      doneFiredRef.current = true;
      doneRef.current();
    }
  }, []);

  return (
    // 最外层只做定位容器：尺寸 = ParticleButton（= 核心 badge，不含光晕）。
    // 光晕以绝对定位负 inset 外挂，不参与布局 → 库 wrapper 的 getBoundingClientRect
    // （决定粒子 canvas 大小）与父级 MovableBox 虚线选择框都只匹配核心 badge 尺寸；
    // 本容器及祖先（除画布整体 overflow）无裁剪，光晕纯绘制在外围。
    //
    // fontSize:0 竖直居中关键：库 wrapper 带 overflow:hidden，按 CSS 2.1 规范这类
    // inline-block 的基线 = 底边 margin edge → particles 行盒把 wrapper 按"底边"对齐到
    // 行盒基线，行盒 strut（继承 16px 字体、line-height 1.5 ≈ 24px 高的空行盒）的下伸部
    // 伸出 wrapper 底边约 6px → particles/本容器比 badge 高 6px 且全部在下方，光晕与
    // 虚线选择框据此锚定 → badge 在整体中偏上、下方留白大。strut 尺寸随 font-size 归零，
    // 容器高度严格 = badge 高度，上下完全对称。
    // 注意：凡在本容器内显示文本的元素必须显式设置 fontSize（昵称 span / 回退头像均已设）。
    <div className="relative inline-flex" style={{ fontSize: 0 }}>
      {/* 光晕组：三层渐进模糊的暖色辉光，外挂在 ParticleButton 之外（不参与布局/测量，
          也不被库 wrapper 的 overflow:hidden 裁剪）。
          显现/消退用"滑动窗口裁剪"：外层 overflow:hidden 作裁剪框并 translateX(100%↔0)，
          内层（= badge 矩形，三层光晕的定位上下文）等值反向平移 → 光晕在屏幕上位置不动、
          可见区左端随窗口从左到右擦除、右端最后消失，与库对 badge 内容的 translateX 裁剪
          完全同几何、同时长、同缓动 → 同步逐渐形成/消失。
          性能关键：动画只动 transform（合成属性）。此前用 clip-path 过渡 + filter:blur，
          clip-path 非合成属性、每帧变化都强制重算三层高斯模糊（全量重绘），在直播姬浏览器源
          （CEF/软件合成）里拖垮整页帧率 → 帧驱动的粒子动画卡顿、粒子按帧计的寿命被拉长，
          消退末尾 badge 裁剪的异步 setState 掉队 → 右侧小块顿挫。改后三层 blur 仅光栅化一次
          缓存为纹理，动画期间只做纹理平移 + 矩形裁剪合成，零重绘。 */}
      <div
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          inset: -HALO_EXTENT,
          overflow: "hidden",
          // 光晕组整体 50% 半透明（含三层光晕）：与 badge 背景的 50% alpha 对齐，
          // 整体与底层直播画面融合；badge 内的头像/昵称不受影响（在此层之外）。
          // 置于滑动窗口层 = 整组一次合成，三层光晕的相对叠加关系不变。
          opacity: GLOW_OPACITY,
          transform: `translateX(${hidden ? "100%" : "0%"})`,
          // 缓动按方向切换，两侧都是"揭示比例随时间"的曲线，且与库侧同一 progress 同步：
          // - 消散：库侧 easeInExpo（慢→快）→ ENTRY_EASE；
          // - 聚合：库侧补丁 17 改用 easeOutExpo（快→慢，ENTRY_EASE 的时间反演）→
          //   ENTRY_EASE_MIRROR，与 badge 内容揭示比例严格相等，不会出现光晕先/后成型的分层。
          // 延迟不单独写：transition 简写第 4 个值就是 delay、缺省 0s（两侧都零延迟：聚合
          // 揭示窗口 = 粒子扫掠窗口 [0,ANIM_MS]，与消散同构互为时间反演）。简写与
          // transitionDelay 混写时，重渲染写简写会重置全部子属性 → React 报警且可能互相覆盖。
          transition: `transform ${ANIM_MS}ms ${hidden ? ENTRY_EASE : ENTRY_EASE_MIRROR}`,
          willChange: "transform",
        }}
      >
        {/* 内层与外层窗口等值反向平移（calc = 内层自身宽 + 两侧外扩 = 外层位移量，
            严格抵消、光晕不随动画晃动）；inset:HALO_EXTENT = badge 矩形，
            三层光晕的 inset 数值与此前完全一致 */}
        <div
          className="absolute pointer-events-none"
          style={{
            inset: HALO_EXTENT,
            transform: `translateX(${
              hidden ? `calc(-100% - ${HALO_EXTENT * 2}px)` : "0%"
            })`,
            // 与外层裁剪框同缓动、同零延迟（简写缺省 delay=0s）：两层必须严格同步，滑动窗口
            // 与内容反向平移才能严格抵消，光晕才不会提前露出/晃动，也与 badge 内容揭示同刻完成
            transition: `transform ${ANIM_MS}ms ${hidden ? ENTRY_EASE : ENTRY_EASE_MIRROR}`,
            willChange: "transform",
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
        // size 有意放大到 6~12（半径，库公开 size 参数；原库默认 1~3、demo #5 固定 3）：
        // 1920 画布 + 缩放预览下原值粒子过小，只调此公开传参，不改库内部代码。
        //
        // speed 有意改回"原库默认随机函数"（defaultProps 中 speed=rand(4)≈±2 随机）：
        // demo #5 的固定 speed=1 会让同一帧生成的所有粒子
        // x 位移完全同步，粒子云水平散不开，没有原库 demo 的分散飘逸感。
        // 注意：随机 speed 只能拉开飞行中段，收敛终点 p.x=speed*vs*(-frames+k) 在
        // k=frames 时恒为 0（与 speed 无关），终点仍会塌缩成竖线。竖线的真正根因是
        // 横向模式 spawn X 偏移写死 0（同一 startX），已由 patch-particle-effect-button.mjs
        // 补丁 12 给 startX 加横向抖动打散（端点 X 散布 0px → 不再塌缩成竖线）。
        // 补丁 19 把该抖动 clamp 进 badge 矩形（j ∈ [-progressValue, width-progressValue]
        // ⇒ startX ∈ [pad, pad+width]）：收敛云与 badge 严格等宽等位。此前抖动 ±height/2
        // 不受约束，收敛云两侧各外扩 h/2，出现"位置对但 badge 比聚集区小一圈"。
        easing="easeInExpo"
        size={() => Math.floor(Math.random() * 7 + 6)}
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
        className="rounded-full"
        style={{
          position: "relative",
          // 背景用 50% alpha 渐变（而非整元素 opacity）：badge 底半透明融入直播画面，
          // 但头像/昵称保持完全不透明
          background: BADGE_GRADIENT_50,
          // 布局关键样式全部走内联 style（不依赖 Tailwind 类）：pr-6 等新增类未被打包进
          // Tailwind v4 JIT 产物，实测 paddingRight 为 0 导致昵称紧贴右边界；
          // 48px = 昵称末字到 badge 右边界间距（1920 设计坐标）
          display: "inline-flex",
          alignItems: "center",
          gap: "24px",
          paddingLeft: "16px",
          paddingRight: "48px",
          paddingTop: "2px",
          paddingBottom: "2px",
          // 竖直居中的真根因在外层容器（particles 行盒 strut，见外层 fontSize:0 注释），
          // 本 badge 内部经实测已完全居中。以下两项保留：verticalAlign:top 让 badge
          // 顶对齐行盒顶（防御基线对齐残余）；lineHeight:1 消除昵称 line-height normal
          // 的字体行盒不对称，头像+昵称在 badge 内完全竖直居中
          verticalAlign: "top",
          lineHeight: 1,
        }}
      >
        <Avatar face={user.face} uname={user.uname} />
        <span
          className="font-bold text-white whitespace-nowrap tracking-wider"
          style={{ fontSize: NAME_FONT_SIZE, lineHeight: 1 }}
        >
          {user.uname}
        </span>
      </div>
      </ParticleButton>
    </div>
  );
}
