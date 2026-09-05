/**
 * 精确模拟 react-particle-effect-button 状态机 + EntryBadge 时序（单轮完整生命周期）：
 *  mount(hidden=true) → 60ms → showing → anime 100→0 → 粒子耗尽 → normal → 停留3s
 *  → hiding → anime 0→100 → 粒子耗尽（死亡帧数对齐进度）→ hidden → onDone 卸载
 *
 * 关键时序：setState 同步提交渲染；anime update 通过 setTimeout(setState) 在下一帧生效。
 * 复刻补丁 6（死亡帧数对齐）与补丁 7（showing progress=100）。
 * 逐事件记录渲染样式，检测"badge 闪现"帧。
 */
const DURATION = 1300; // ms
const FRAMES = Math.round((DURATION * 60) / 1000); // 78
const EASE_IN_EXPO = (p) => (p === 0 ? 0 : p === 1 ? 100 : 100 * Math.pow(2, 10 * (p - 1)));
const SIZE = 140; // badge 宽度（px）
const SHOW_DELAY_MS = 60;
const HOLD_MS = 3000;

/** fix=true 模拟补丁7（showing 首帧 progress=100），false 模拟原库 */
function runRound({ fix }) {
  let status = "hidden";
  let progress = 0;
  let _progress = 1;
  let particles = []; // {death, life}
  let animating = null; // {kind, value, f}
  let holdLeft = null;
  let showDone = false;
  let done = false;
  const renders = [];
  const record = (reason) => {
    const s = status === "hiding" || status === "showing"
      ? { vis: "visible", px: Math.ceil((SIZE * progress) / 100) }
      : status === "hidden"
        ? { vis: "hidden", px: 0 }
        : { vis: "visible", px: 0 };
    const last = renders[renders.length - 1];
    if (!last || last.status !== status || last.vis !== s.vis || last.px !== s.px) {
      renders.push({ t: Math.round(t), reason, status, ...s, np: particles.length });
    }
  };

  const cycleStatus = () => {
    if (status === "normal") status = "hiding";
    else if (status === "hidden") status = "showing";
    else if (status === "hiding") status = "hidden";
    else if (status === "showing") status = "normal";
  };

  const startAnimation = () => {
    if (status === "hiding") _progress = 0;
    else _progress = 1;
    particles = [];
    animating = { kind: status === "hiding" ? "hiding" : "showing", value: status === "hiding" ? 0 : 100, f: 0 };
  };

  const addParticles = (prog) => {
    if (status !== "hiding" && status !== "showing") return;
    const delta = status === "hiding" ? prog - _progress : _progress - prog;
    _progress = prog;
    const i = Math.floor(10 * (delta * 100 + 1));
    if (i > 0) {
      for (let k = 0; k < i; k++) {
        const death = status === "hiding"
          ? Math.max(1, FRAMES * (1 - prog)) // 补丁6：死亡帧数对齐滑出进度
          : FRAMES; // 原库
        particles.push({ death, life: 0 });
      }
    }
  };

  let t = 0;
  let frame = 0;
  record("mount");
  while (t < 10000 && !done) {
    frame++;
    const frameTime = t;

    // 1. EntryBadge：60ms 后 hidden=false → componentDidUpdate → setState(showing, progress=fix?100:0)
    if (!showDone && frameTime >= SHOW_DELAY_MS) {
      showDone = true;
      if (status === "hidden") {
        status = "showing";
        progress = fix ? 100 : 0; // 补丁7：同步置100；原库：沿用旧值0 → 闪现帧
        startAnimation(); // setState 回调，anime 从下一帧起推进
        record("showing-start");
      }
    }

    // 2. anime 推进（RAF）：update 回调 → _addParticles 同步，setState(progress) 下一帧渲染生效
    if (animating) {
      const a = animating;
      a.f++;
      const p = a.f / FRAMES;
      let value;
      if (p >= 1) {
        value = a.kind === "hiding" ? 100 : 0;
        animating = null;
      } else {
        value = a.kind === "hiding" ? EASE_IN_EXPO(p) : 100 - EASE_IN_EXPO(p);
      }
      addParticles(value / 100);
      progress = value; // setTimeout(setState) → 本帧提交渲染
      record("anime");
    }

    // 3. 粒子更新 + 耗尽 → _cycleStatus + onComplete
    for (const pt of particles) pt.life++;
    particles = particles.filter((pt) => pt.life <= pt.death);
    if (!particles.length && (status === "showing" || status === "hiding")) {
      cycleStatus();
      record("cycle-status");
      if (status === "normal") {
        if (holdLeft == null) holdLeft = HOLD_MS;
      } else if (status === "hidden") {
        done = true;
      }
    }

    // 4. EntryBadge 停留计时结束 → setHidden(true) → componentDidUpdate → hiding
    if (holdLeft != null) {
      holdLeft -= 16.67;
      if (holdLeft <= 0) {
        holdLeft = null;
        if (status === "normal") {
          status = "hiding";
          startAnimation(); // progress 沿用 0：hiding 首帧 px=0 可见（正确）
          record("hiding-start");
        }
      }
    }

    t += 16.67;
  }
  return renders;
}

/** 检测闪现：上一帧 badge 不可见（hidden 或滑出中 px>40），本帧突然完整可见（px<=1） */
function detectFlash(renders) {
  const flash = [];
  for (let i = 1; i < renders.length; i++) {
    const p = renders[i - 1];
    const c = renders[i];
    if ((p.vis === "hidden" || (p.status === "hiding" && p.px > 40)) && c.vis === "visible" && c.px <= 1) {
      flash.push({ at: c.t, reason: c.reason, from: p, to: c });
    }
  }
  return flash;
}

for (const fix of [false, true]) {
  const renders = runRound({ fix });
  const flash = detectFlash(renders);
  console.log(`\n===== fix=${fix}（${fix ? "已打补丁7" : "原库行为"}）=====`);
  for (const r of renders) {
    console.log(`  t=${r.t}ms [${r.reason}] status=${r.status} vis=${r.vis} px=${r.px} np=${r.np}`);
  }
  console.log(`  闪现帧数: ${flash.length}${flash.length ? "\n" + JSON.stringify(flash, null, 1) : "（无，符合预期）"}`);
}
