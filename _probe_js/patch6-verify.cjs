/**
 * 验证补丁 6 修正后（固定随机尾巴 0.35~0.65 帧程）的粒子消散时序：
 *  - 死亡顺序是否从左到右（与 badge 从左往右消失同步）
 *  - 是否所有粒子在 badge 完全消失（帧 78）前保持存活（不提前触发 onComplete → 无闪现）
 *  - 最后一批粒子死亡帧
 */
const FRAMES = 78;
const AMOUNT = 15; // 每帧生成粒子数（particlesAmountCoefficient=15 时约数量级）
const rnd = () => 0.35 + Math.random() * 0.3;

// 帧 t 出生粒子的死亡帧 = t + FRAMES*(0.35+rand*0.3)
const births = [];
for (let t = 0; t < FRAMES; t++) {
  const deathFrame = t + FRAMES * rnd();
  births.push({ t, deathFrame });
}

// 按死亡帧排序
const sorted = [...births].sort((a, b) => a.deathFrame - b.deathFrame);

console.log(`粒子数=${births.length}（每帧 ${AMOUNT} 个，共 ${FRAMES} 帧）`);
console.log(`出生范围：帧 0 ~ ${FRAMES - 1}（从左到右，与 badge 左→右消失同向）`);
console.log(`最早死亡帧：${Math.min(...births.map((b) => b.deathFrame)).toFixed(1)}`);
console.log(`最晚死亡帧：${Math.max(...births.map((b) => b.deathFrame)).toFixed(1)}`);
console.log(`badge 完全消失帧：${FRAMES}`);

// 出生 vs 死亡的排序一致性（早出生的早死）
let consistent = 0;
for (let i = 0; i < sorted.length - 1; i++) {
  if (sorted[i].t <= sorted[i + 1].t) consistent++;
}
console.log(`死亡顺序与出生顺序一致的相邻对：${consistent}/${sorted.length - 1}`);

// 帧 78 时存活粒子数（不该为 0 → 不提前触发状态翻转）
const aliveAtEnd = births.filter((b) => b.deathFrame >= FRAMES).length;
console.log(`帧 ${FRAMES}（badge 消失时）存活粒子：${aliveAtEnd}（>0 则不会提前触发 onComplete 闪现）`);
console.log(`粒子全部死光时刻：${Math.max(...births.map((b) => b.deathFrame)).toFixed(1)} 帧 = badge 消失后再 ${(Math.max(...births.map((b) => b.deathFrame)) - FRAMES).toFixed(1)} 帧（约 ${(((Math.max(...births.map((b) => b.deathFrame)) - FRAMES) / 60)).toFixed(2)}s 消散尾巴）`);
