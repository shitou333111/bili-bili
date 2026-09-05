/**
 * 实证"badge 消失方向 vs 粒子死亡顺序"是否匹配。
 *
 * 复刻库 render 的 transform 遮罩逻辑（index.es.js 行 478-485，当前补丁状态，无 clip-path）：
 *   wrapper.transform = translateX(px)，px = ceil(size*progress/100)（direction='left'）
 *   content.transform  = translateX(-px)
 *   wrapper overflow:hidden → 可见 badge 区间 = [px, W-px]（交集，px<=W/2 时非空）
 *
 * 复刻粒子 hiding 时序（补丁 5/6）：
 *   生成线 startX = padding + W*(progress/100) + delta*100（从左向右移动）
 *   death = max(frames*0.35, frames*(1-progress))（progress 为粒子生成时值）
 *
 * 输出：badge 可见区间随时间的变化（→ 真实消失方向）+ 粒子生成/死亡顺序。
 */
const W = 350; // badge 宽度（1920 设计坐标）
const PADDING = 150;
const FRAMES = Math.round((1300 * 60) / 1000); // 78

// anime easeInExpo 进度（0..1）
function easeInExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, 10 * (t - 1));
}

console.log("帧 | progress% | px | badge可见区间  | 生成线x | 新粒子death  | 新粒子绝对x范围");
console.log("---+-----------+----+---------------+---------+--------------+---------------");
const rows = [];
for (let f = 0; f <= FRAMES; f += 6) {
  const p = easeInExpo(f / FRAMES) * 100; // hiding progress 0→100
  const px = Math.ceil((W * p) / 100);
  const visLeft = Math.max(0, Math.min(px, W));
  const visRight = Math.max(0, Math.min(W - px, W));
  const startX = PADDING + (W * p) / 100;
  const death = Math.max(FRAMES * 0.35, FRAMES * (1 - p / 100));
  rows.push({
    f,
    p: p.toFixed(1),
    px,
    vis: `[${visLeft.toFixed(0)}, ${visRight.toFixed(0)}]`,
    startX: startX.toFixed(0),
    death: death.toFixed(0),
    xRange: `${(startX - 2 * FRAMES).toFixed(0)} ~ ${(startX + 2 * FRAMES).toFixed(0)}`,
  });
  console.log(
    `${String(f).padStart(3)} | ${rows[rows.length - 1].p.padStart(9)} | ${String(px).padStart(4)} | ${rows[rows.length - 1].vis.padStart(13)} | ${rows[rows.length - 1].startX.padStart(7)} | ${rows[rows.length - 1].death.padStart(12)} | ${rows[rows.length - 1].xRange}`,
  );
}

console.log("\n===== 结论推导 =====");
console.log(`badge 可见区间：${rows[0].vis} → ${rows[rows.length - 1].vis}（两侧向中间收缩，p=50 时完全消失）`);
console.log(`粒子生成线：左侧(${rows[0].startX}) → 右侧(${rows[rows.length - 1].startX})，即从左到右生成`);
console.log(`粒子死亡帧数：左侧粒子 ${rows[0].death} 帧 → 右侧粒子 ${rows[rows.length - 1].death} 帧（左侧活得久、右侧先死）`);
