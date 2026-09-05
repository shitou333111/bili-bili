/**
 * 验证"粒子竖直对齐成竖线"根因：
 * 复刻 react-particle-effect-button 的 _addParticles/_addParticle/_updateParticles
 * （含补丁 9d/9g/9h 视觉缩放，vs=1 即 1920 设计坐标），对比：
 *  - speed=1 固定（当前 EntryBadge）
 *  - speed=rand(4) 随机（原库默认）
 *
 * 度量指标：某一帧所有存活粒子的 x 坐标去重后个数（同 x 粒子重合 = 竖线）；
 * 以及粒子覆盖的 x 范围、y 范围。
 */
const FRAMES = Math.round((1300 * 60) / 1000); // 78
const WIDTH = 140; // badge 宽（1920 设计坐标）
const HEIGHT = 72; // badge 高
const PADDING = 150;
const VS = 1;
const OSC = 1; // demo #5 oscillationCoefficient
const AMOUNT = 10; // particlesAmountCoefficient

const rand = (v) => Math.random() * v - v / 2;

function sim({ speedFn }) {
  const particles = [];
  let progress = 100;
  let _progress = 100;
  const snapshots = [];
  const frames = FRAMES;
  for (let f = 0; f < frames; f++) {
    const p = 100 - (100 * (f + 1)) / frames; // 线性 progress（简化，真实为 easeInExpo）
    const delta = _progress - p;
    _progress = p;
    progress = p;
    const progressValue = WIDTH * (progress / 100) + delta * 220 * VS;
    let x = PADDING * VS;
    const y = PADDING * VS;
    x += progressValue; // direction='left'
    const i = Math.floor(AMOUNT * (delta * 100 + 1));
    for (let k = 0; k < i; k++) {
      const speed = speedFn();
      particles.push({
        startX: x,
        startY: y + HEIGHT * Math.random(),
        x: speed * -frames * VS,
        y: 0,
        counter: frames,
        increase: (Math.PI * 2) / 100,
        life: 0,
        death: frames,
        speed,
      });
    }
    // 更新所有存活粒子（含本帧新生的，简化为先创建后更新）
    for (const pt of particles) {
      if (pt.life > pt.death) continue;
      pt.x += pt.speed * VS;
      pt.y = OSC * Math.sin(pt.counter * pt.increase) * VS;
      pt.life++;
      pt.counter -= 1;
    }
    // 移除死亡
    for (let idx = particles.length - 1; idx >= 0; idx--) {
      if (particles[idx].life > particles[idx].death) particles.splice(idx, 1);
    }
    if (f % 13 === 0 || f === frames - 1) {
      const absX = particles.map((pt) => pt.startX + pt.x);
      const absY = particles.map((pt) => pt.startY + pt.y);
      const uniqX = new Set(absX.map((v) => Math.round(v * 10) / 10)).size;
      snapshots.push({
        f,
        alive: particles.length,
        uniqX,
        xRange: (Math.max(...absX) - Math.min(...absX)).toFixed(1),
        yRange: (Math.max(...absY) - Math.min(...absY)).toFixed(1),
      });
    }
  }
  return snapshots;
}

console.log("===== speed=1 固定（当前） =====");
console.log(JSON.stringify(sim({ speedFn: () => 1 }), null, 1));
console.log("===== speed=rand(4) 随机（原库默认） =====");
console.log(JSON.stringify(sim({ speedFn: () => rand(4) }), null, 1));
