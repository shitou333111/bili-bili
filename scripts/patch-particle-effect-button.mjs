/**
 * react-particle-effect-button 补丁（postinstall 自动执行）
 *
 * 背景：项目使用该库做"粒子聚合入场提示"，但 React 18/19 下原库存在若干与项目不符的问题，
 * 主要包括：
 *  1. 生命周期：原库用已废弃的 componentWillReceiveProps（React 18/19 不再调用）→ 改用
 *     componentDidUpdate，确保 hidden 变化一定触发粒子动画。
 *  2. StrictMode 双挂载：componentWillUnmount 置 _unmounted=true 后在重挂载时残留 →
 *     _startAnimation 入口复位 _unmounted=false，保证粒子正常生成。
 *  3. 卸载崩溃：销毁后 RAF/anime 仍访问 _canvas → 卸载时取消 RAF 并 pause anime。
 *  4. badge 逐步显现/消失与粒子方向一致：原版用 transform 整体滑入，改为 clip-path 从右往左
 *     逐段显现/消失（聚合时粒子从右飞入、左侧最后成型，与粒子收敛方向对应）。
 *  5. 粒子起点/终点超出 badge 左右两端：原 showing=220 的散布常量过大 → 收窄到 120，让粒子更
 *     贴近 badge 聚合。
 *  6. 粒子颜色与 badge 渐变对应：绘制时按粒子当前位置映射到红橙黄（hue 0~60），保证任一时刻
 *     左端纯红、右端纯黄，与 badge 渐变（最左红、最右黄）一致。
 *
 * 说明：粒子"按进度批量着色"等为排查 badge 两端偏色而临时加入的冗余逻辑已移除——真正根因是
 * badge 的 background-origin（CSS 层），库内无需做相近的着色逻辑。
 *
 * 幂等：已打补丁时直接跳过（每个子补丁以"新内容哨兵"判断是否已应用）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = [
  path.join(__dirname, "..", "node_modules", "react-particle-effect-button", "dist", "index.es.js"),
  path.join(__dirname, "..", "node_modules", "react-particle-effect-button", "dist", "index.js"),
];

/** 每个补丁：名字 / 哨兵(判断是否已应用) / 原文本 / 新文本 */
const PATCHES = [
  {
    name: "1 _startAnimation 复位 _unmounted",
    marker: "_this._unmounted = false;",
    old: `    }, _this._startAnimation = function () {
      if (!_this._canvas || !_this._wrapper) return;`,
    now: `    }, _this._startAnimation = function () {
      // StrictMode Dev 会在首次挂载时"模拟卸载+重挂载"，componentWillUnmount 已置 _unmounted=true，
      // 重挂载时不会重置；若不在此复位，_addParticles 会因 _unmounted 直接 return，导致粒子一帧也不生成。
      _this._unmounted = false;
      if (!_this._canvas || !_this._wrapper) return;`,
  },
  {
    name: "2 存储 anime 实例引用",
    marker: "_this._anime = anime_min({",
    old: `      anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },`,
    now: `      _this._anime = anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },`,
  },
  {
    name: "3 隐藏完成回调（隐藏后立即收尾）",
    marker: "complete: function complete() {",
    old: `        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          setTimeout(function () {
            _this.setState({ progress: value });
          });

          if (duration) {
            _this._addParticles(value / 100);
          }
        }
      });
    }, _this._loop = function () {
      _this._updateParticles();`,
    now: `        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          setTimeout(function () {
            _this.setState({ progress: value });
          });

          if (duration) {
            _this._addParticles(value / 100);
          }
        },
        complete: function complete() {
          // hiding：badge 已随动画完全隐藏(progress=100)后立即收尾，不等粒子清空，
          // 避免粒子提前死亡触发 _cycleStatus 在 badge 未完全隐藏时闪现消失；
          // 同时清空粒子并停 RAF，防止 _loop 粒子清空后再 _cycleStatus 产生状态竞争。
          if (_this.state.status === 'hiding') {
            _this._particles = [];
            if (_this._raf) {
              cancelAnimationFrame(_this._raf);
              _this._raf = null;
            }
            _this.setState({ status: 'hidden' });
            _this.props.onComplete();
          }
        }
      });
    }, _this._loop = function () {
      if (_this._unmounted) return;
      _this._updateParticles();`,
  },
  {
    name: "4 生命周期迁移 + 卸载清理",
    marker: "key: 'componentDidUpdate',",
    old: `  createClass(ParticleEffectButton, [{
    key: 'componentWillReceiveProps',
    value: function componentWillReceiveProps(props) {
      if (props.hidden !== this.props.hidden) {
        var status = this.state.status;


        if (status === 'normal' && props.hidden) {
          this.setState({ status: 'hiding' }, this._startAnimation);
        } else if (status === 'hidden' && !props.hidden) {
          this.setState({ status: 'showing' }, this._startAnimation);
        } else if (status === 'hiding' && !props.hidden) {
          // TODO: show button in middle of hiding animation
        } else if (status === 'showing' && props.hidden) {
          // TODO: hide button in middle of showing animation
        }
      }
    }
  }, {`,
    now: `  createClass(ParticleEffectButton, [{
    key: 'componentDidUpdate',
    value: function componentDidUpdate(prevProps) {
      // React 18/19 已移除 componentWillReceiveProps（旧名与 UNSAFE_ 名均不再调用），
      // 改用现代生命周期 componentDidUpdate（必然触发）处理 hidden 变化 → 触发粒子动画。
      if (this.props.hidden !== prevProps.hidden) {
        var props = this.props;
        var status = this.state.status;
        if (status === 'normal' && props.hidden) {
          this.setState({ status: 'hiding', progress: 0 }, this._startAnimation);
        } else if (status === 'hidden' && !props.hidden) {
          // progress 初值置 100：聚合从"badge 在右侧外(隐藏)"开始随粒子滑入；
          // 若沿用初始 progress=0，render 会先原位完整显示 badge 一帧（闪现/无过渡、
          // 与粒子聚合不同步）。
          this.setState({ status: 'showing', progress: 100 }, this._startAnimation);
        } else if (status === 'hiding' && !props.hidden) {
          // TODO: show button in middle of hiding animation
        } else if (status === 'showing' && props.hidden) {
          // TODO: hide button in middle of showing animation
        }
      }
    }
  }, {
    key: 'componentWillUnmount',
    value: function componentWillUnmount() {
      // 卸载时立即取消 RAF 并暂停 anime 动画，避免组件销毁后 _loop/_addParticles
      // 仍访问 _canvas 触发 "Cannot read properties of null (reading 'width')" 崩溃
      this._unmounted = true;
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
      if (this._anime) {
        this._anime.pause();
        this._anime = null;
      }
    }
  }, {`,
  },
  {
    name: "5 badge 显现/消失改为 clip-path（由右向左逐段）",
    marker: "wrapperStyles.clipPath = 'inset(0 0 0 ' + hideLeft + '%)';",
    old: `      if (status === 'hiding' || status === 'showing') {
        var prop = this._isHorizontal() ? 'translateX' : 'translateY';
        var size = this._isHorizontal() ? this._rect.width : this._rect.height;
        var value = direction === 'left' || direction === 'top' ? progress : -progress;
        var px = Math.ceil(size * value / 100);

        wrapperStyles.transform = prop + '(' + px + 'px)';
        contentStyles.transform = prop + '(' + -px + 'px)';
      } else if (status === 'hidden') {`,
    now: `      if (status === 'hiding' || status === 'showing') {
        // badge 从右往左逐段显现/消失，与粒子聚合/消散方向一一对应：
        // showing: progress 100→0 → reveal 0→1（右侧先显现，向左展开）；
        // hiding: progress 0→100 → reveal 1→0（右侧先收起，向左消失）。
        var reveal = (100 - progress) / 100;
        var hideLeft = Math.max(0, Math.min(100, (1 - reveal) * 100));
        wrapperStyles.clipPath = 'inset(0 0 0 ' + hideLeft + '%)';
      } else if (status === 'hidden') {`,
  },
  {
    name: "6 _addParticles 加卸载守卫",
    marker: "if (this._unmounted) return;\n      var _props2 = this.props,",
    old: `    value: function _addParticles(progress) {
      var _props2 = this.props,`,
    now: `    value: function _addParticles(progress) {
      if (this._unmounted) return;
      var _props2 = this.props,`,
  },
  {
    name: "7 收敛粒子散布范围",
    marker: "(isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 120)",
    old: `      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 220);`,
    now: `      // [patch-particle-effect-button] 收敛粒子散布范围：原版 showing=220 过大，导致粒子
      // 起点/终点明显超出 badge 左右两端、削弱与 badge 的对应。hiding 保持 100、showing 收窄
      // 到 120，使粒子更贴近 badge 聚合。该常量非库暴露的 prop，只能通过补丁调整。
      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 120);`,
  },
  {
    name: "8 粒子存活完整帧数",
    marker: "death: frames,",
    old: `        life: 0,
        death: status === 'hiding' ? frames - 20 + Math.random() * 40 : frames,
        speed: _speed,
        size: _size
      });`,
    now: `        life: 0,
        // [patch-particle-effect-button] 粒子存活完整帧数（原版 death 在 hiding 时提前随机死亡），
        // 与 badge 滑入/滑出动画全程同步，避免粒子提前死亡触发 _cycleStatus 提前切换 status，
        // 使 badge 在未完全滑出时闪现消失。
        death: frames,
        speed: _speed,
        size: _size
      });`,
  },
  {
    name: "9 粒子按渲染位置实时取色",
    marker: "(p.startX + p.x - _pad) / _w",
    old: `      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          this._ctx.translate(p.startX, p.startY);
          this._ctx.rotate(p.angle * Math.PI / 180);
          this._ctx.globalAlpha = status === 'hiding' ? 1 - p.life / p.death : p.life / p.death;
          this._ctx.beginPath();`,
    now: `      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          this._ctx.translate(p.startX, p.startY);
          this._ctx.rotate(p.angle * Math.PI / 180);
          this._ctx.globalAlpha = status === 'hiding' ? 1 - p.life / p.death : p.life / p.death;
          // [patch-particle-effect-button] 粒子颜色按当前实际渲染位置实时计算（随飞行平滑过渡）：
          // 与 badge 渐变"最左纯红、最右纯黄、中间橙黄"保持一致，保证任一时刻左右端颜色正确。
          if (this._isHorizontal()) {
            var _pad = this.props.canvasPadding;
            var _w = this._rect.width || 1;
            var _rel = Math.max(0, Math.min(1, (p.startX + p.x - _pad) / _w));
            p.color = 'hsl(' + Math.round(60 * _rel) + ',90%,60%)';
          }
          // 逐粒子使用各自颜色（无 color 时回退到 prop color，如非水平方向）
          this._ctx.fillStyle = this._ctx.strokeStyle = p.color || color;
          this._ctx.beginPath();`,
  },
];

function applyReplace(name, marker, old, now, src) {
  if (src.includes(marker)) {
    return { src, applied: false, skip: true, srcFile: null };
  }
  if (!src.includes(old)) {
    return { src, applied: false, skip: false, srcFile: null };
  }
  return { src: src.replace(old, now), applied: true, skip: false, srcFile: null };
}

let changed = false;
let skipped = true;
for (const file of files) {
  if (!existsSync(file)) {
    console.warn(`[patch-particle-effect-button] 未找到 ${file}（依赖未安装？），跳过`);
    continue;
  }
  let src = readFileSync(file, "utf8");
  let fileChanged = false;
  for (const p of PATCHES) {
    const r = applyReplace(p.name, p.marker, p.old, p.now, src);
    if (r.applied) {
      src = r.src;
      fileChanged = true;
      changed = true;
      skipped = false;
      console.log(`[patch-particle-effect-button] ${p.name} ✅`);
    } else if (!r.skip) {
      console.warn(`[patch-particle-effect-button] ${p.name} ⚠️ 未匹配到原文本（可能已被修改），请检查`);
    }
  }
  if (fileChanged) {
    writeFileSync(file, src, "utf8");
    console.log(`[patch-particle-effect-button] 已写入 ${path.basename(file)}`);
  }
}

if (changed) {
  console.log("[patch-particle-effect-button] 补丁完成");
} else if (skipped) {
  console.log("[patch-particle-effect-button] 已打补丁，跳过");
}