declare module "react-particle-effect-button" {
  import type { Component, ReactNode } from "react";

  type ParticleType = "circle" | "rectangle" | "triangle";
  type ParticleDirection = "left" | "right" | "top" | "bottom";

  export interface ParticleEffectButtonProps {
    /** true=消散动画，false=聚合成型 */
    hidden?: boolean;
    /** 动画完成回调（聚合完成 / 消散完成各触发一次） */
    onComplete?: () => void;
    /** 动画开始回调 */
    onBegin?: () => void;
    /** 粒子颜色（单色；本项目实际按位置渐变着色，见 particleColors） */
    color?: string;
    /**
     * 自定义粒子渐变色 [左色, 右色]（库补丁 26）：
     * 每粒子颜色按其水平位置在两端色间按 RGB 插值；缺省时保持库原始红黄（hue 0~60）。
     */
    particleColors?: string[];
    /** 粒子类型：circle=圆点  rectangle=方块  triangle=三角 */
    type?: ParticleType;
    /** 粒子填充方式：fill=实心  stroke=描边 */
    style?: "fill" | "stroke";
    /** 内容滑入/滑出方向 */
    direction?: ParticleDirection;
    /** 动画时长(ms) */
    duration?: number;
    /** 缓动函数名 */
    easing?: string;
    /** 粒子大小（px）或取大小的函数 */
    size?: number | (() => number);
    /** 粒子速度或取速度的函数 */
    speed?: number | (() => number);
    /** 粒子数量系数（越大粒子越多） */
    particlesAmountCoefficient?: number;
    /** 粒子震荡系数 */
    oscillationCoefficient?: number;
    /** 画布留白（px） */
    canvasPadding?: number;
    className?: string;
    children?: ReactNode;
  }

  export default class ParticleEffectButton extends Component<ParticleEffectButtonProps> {}
}
