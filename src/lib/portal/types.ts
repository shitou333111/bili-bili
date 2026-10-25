/** 渲染器每帧需要的完整状态（仅 ring + spark 所需字段）。 */
export interface RenderState {
  /** Seconds since the sequence began. */
  timeSec: number;
  /** Ring centre and radius, CSS pixels, viewport space (top-left origin). */
  cx: number;
  cy: number;
  radius: number;
  /** 0..1 arc trace. */
  progress: number;
  startAngle: number;
  direction: number;
  /** Master brightness / flare. */
  energy: number;
  /** Slow rotation offset, radians. */
  spin: number;
  /** 0..1, ring blowing apart. */
  dissipate: number;
}

/**
 * Everything about how the rim *looks*, in one place.
 * 值来自用户在 SlingTab tools/tune.html 调试后的参数。
 */
export interface LookParams {
  /** Filament brightness. */
  core: number;
  /** Filament half-width as a fraction of the disc radius. */
  thickness: number;
  /** How hard the high-frequency speckle chops the filament into embers. */
  grain: number;
  /** Ember dust hugging the outside of the filament. */
  dust: number;
  /** Bloom weight. */
  glow: number;
  /**
   * Seconds of past trajectory drawn behind each spark. This is a *trail
   * length*, not a motion-blur amount: the ribbon follows the particle's own
   * parabolic path, which is what makes the strands curve like hair instead of
   * lying flat like dashes.
   */
  streak: number;
}

/** 用户调试好的火圈外观参数。 */
export const DEFAULT_LOOK: LookParams = {
  core: 1.85,
  thickness: 0.0315,
  grain: 0.71,
  dust: 0,
  glow: 2,
  streak: 0.195,
};
