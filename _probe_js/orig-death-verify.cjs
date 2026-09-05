/**
 * 验证恢复原库死亡公式（death = frames-20+rand*40）后的消散时序：
 *  - 死亡顺序是否与出生顺序一致（从左到右，与 badge 左→右消失同向）
 *  - badge 完全消失（帧78）时是否仍有粒子存活（不提前触发 onComplete → 无闪现）
 *  - 最后粒子死亡帧 / 消散尾巴时长
 */
const FRAMES = 78; // duration=1300ms → 78 帧 @60fps
const rnd = () => -20 + Math.random() * 40; // 原库：death = frames + rnd
const N = 200000; // 采样粒子数（求统计分布）

const births = [];
for (let t = 0; t < FRAMES; t++) {
  for (let k = 0; k < Math.floor(N / FRAMES); k++) {
    const deathFrame = t + FRAMES + rnd();
    births.push({ t, deathFrame });
  }
}

const sorted = [...births].sort((a, b) => a.deathFrame - b.deathFrame);
let consistent = 0;
for (let i = 0; i < sorted.length - 1; i++) {
  if (sorted[i].t <= sorted[i + 1].t) consistent++;
}
let minD = Infinity, maxD = -Infinity;
let aliveAtEnd = 0;
for (const b of births) {
  if (b.deathFrame < minD) minD = b.deathFrame;
  if (b.deathFrame > maxD) maxD = b.deathFrame;
  if (b.deathFrame >= FRAMES) aliveAtEnd++;
}
console.log(`粒子样本=${births.length}`);
console.log(`出生范围：帧 0 ~ ${FRAMES - 1}（生成线从左到右）`);
console.log(`死亡范围：帧 ${minD.toFixed(1)} ~ ${maxD.toFixed(1)}`);
console.log(`帧 ${FRAMES}（badge 完全消失）存活粒子占比：${((aliveAtEnd / births.length) * 100).toFixed(1)}%（>0 则不提前 onComplete）`);
console.log(`最后粒子死亡帧：${maxD.toFixed(0)} = badge 消失后再 ${(maxD - FRAMES).toFixed(0)} 帧（约 ${((maxD - FRAMES) / 60).toFixed(2)}s 飘散尾巴）`);
// 按出生帧分桶统计平均死亡帧：趋势应单调递增（出生越早死得越早 = 从左到右消散）
console.log("出生帧 → 平均死亡帧（应单调递增）：");
for (let t = 0; t < FRAMES; t += 10) {
  const bucket = births.filter((b) => b.t >= t && b.t < t + 10);
  const avg = bucket.reduce((s, b) => s + b.deathFrame, 0) / bucket.length;
  console.log(`  帧 ${t}~${t + 9} 出生 → 平均死亡帧 ${avg.toFixed(1)}`);
}
