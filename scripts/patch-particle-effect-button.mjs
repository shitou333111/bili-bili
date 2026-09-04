/**
 * react-particle-effect-button 补丁（postinstall 自动执行）
 *
 * 背景：项目使用该库做"粒子聚合入场提示"，但 React 18/19 下原库存在若干与项目不符的问题，
 * 补丁统一在此维护（node_modules 直接改动会在 npm ci 后被还原，必须同步到本脚本）。
 * 补丁以"原始库 dist 文件"为基准（old 文本取自原版），`now` 为最终产物，可重复执行（幂等）。
 *
 * 覆盖问题：
 *  1. 生命周期：原库用已废弃的 componentWillReceiveProps（React 18/19 不再调用）→ 改用
 *     componentDidUpdate，确保 hidden 变化一定触发粒子动画；卸载时取消 RAF + pause anime。
 *  2. StrictMode 双挂载：componentWillUnmount 置 _unmounted=true 后在重挂载时残留 →
 *     _startAnimation 入口复位 _unmounted=false，保证粒子正常生成。
 *  3. 粒子范围：getBoundingClientRect 受祖先 transform:scale(fit) 影响导致飞行范围过大 →
 *     改用 offsetWidth/offsetHeight 取"布局尺寸"；showing 散布常量 220 → 120 收敛。
 *  4. badge 逐步显现/消失与粒子方向一致：原版用 transform 整体滑入 → clip-path 从右往左逐段
 *     显现/消失（聚合时粒子从右飞入、左侧最后成型，与粒子收敛方向对应）。
 *  5. 粒子颜色与 badge 渐变对应：绘制时按粒子当前位置映射到红橙黄（hue 0~60）。
 *  6. 时间刻度推进（重要）：粒子运动按时间推进（以 60fps 为基准）：原版按帧推进，低帧率
 *     （直播姬浏览器源约 30fps）下粒子明显变慢 → 用 performance.now() 计算时间步长，任何帧率下
 *     动画时长恒定。badge 揭示进度仍由 anime 的 update 回调每帧 setState 驱动（与粒子聚合同步）。
 *  7. 隐藏收尾：badge 完全隐藏(progress=100)后立即收尾，避免粒子提前死亡触发 _cycleStatus
 *     导致 badge 未完全滑出时闪现消失；粒子存活完整帧数（hiding 不再提前随机死亡）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = [
  path.join(__dirname, "..", "node_modules", "react-particle-effect-button", "dist", "index.es.js"),
  path.join(__dirname, "..", "node_modules", "react-particle-effect-button", "dist", "index.js"),
];

/** 每个补丁：名字 / 哨兵(判断是否已应用) / 原文本(原始库) / 新文本(最终) */
const PATCHES = [
  {
    name: "A 构造器初始化 _lastFrameTime",
    marker: "_this._lastFrameTime = null, _this._canvasRef",
    old: `    }, _this._rect = {
      width: 0,
      height: 0
    }, _this._canvasRef = function (ref) {`,
    now: `    }, _this._rect = {
      width: 0,
      height: 0
    }, _this._lastFrameTime = null, _this._canvasRef = function (ref) {`,
  },
  {
    name: "B _startAnimation 复位 _unmounted",
    marker: `    }, _this._startAnimation = function () {
      // StrictMode`,
    old: `    }, _this._startAnimation = function () {
      if (!_this._canvas || !_this._wrapper) return;`,
    now: `    }, _this._startAnimation = function () {
      // StrictMode Dev 会在首次挂载时"模拟卸载+重挂载"，componentWillUnmount 已置 _unmounted=true，
      // 重挂载时不会重置；若不在此复位，_addParticles 会因 _unmounted 直接 return，导致粒子一帧也不生成。
      _this._unmounted = false;
      if (!_this._canvas || !_this._wrapper) return;`,
  },
  {
    name: "C 布局尺寸改 offsetWidth/offsetHeight + 重置时间基准",
    marker: "offsetWidth/offsetHeight 不受 transform 影响",
    old: `      _this._particles = [];

      _this._rect = _this._wrapper.getBoundingClientRect();
      _this._canvas.width = _this._rect.width + canvasPadding * 2;`,
    now: `      _this._particles = [];

      // [patch-particle-effect-button] 每个动画阶段（聚合/消散）重置时间基准，避免
      // 阶段间首帧用陈旧时间差算出大步长导致粒子瞬时跳变
      _this._lastFrameTime = null;

      // [patch-particle-effect-button] 用 offsetWidth/offsetHeight 取"布局尺寸"替代
      // getBoundingClientRect：getBoundingClientRect 返回经过祖先 transform:scale(fit) 缩放后的
      // 视觉尺寸，画布在浏览器源高分辨率（fit>1）下会二次缩放，导致粒子飞行范围远大于 badge；
      // offsetWidth/offsetHeight 不受 transform 影响，使粒子范围与 badge 始终等比、任何分辨率一致。
      _this._rect = {
        width: _this._wrapper.offsetWidth,
        height: _this._wrapper.offsetHeight
      };
      _this._canvas.width = _this._rect.width + canvasPadding * 2;`,
  },
  {
    name: "D 存储 anime 实例 + 每帧 setState 驱动揭示进度 + 隐藏完成回调",
    marker: "_this._anime = anime_min({",
    old: `      anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },
        value: status === 'hiding' ? 100 : 0,
        duration: duration,
        easing: easing,
        begin: onBegin,
        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          setTimeout(function () {
            _this.setState({ progress: value });
          });

          if (duration) {
            _this._addParticles(value / 100);
          }
        }
      });`,
    now: `      _this._anime = anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },
        value: status === 'hiding' ? 100 : 0,
        duration: duration,
        easing: easing,
        begin: onBegin,
        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          // 每帧 setState 更新 progress → render 据此改 wrapper 的 clipPath 揭示 badge，
          // 与粒子聚合/消散保持同一 duration+easing 同步（与库原生动画一致）。
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
      });`,
  },
  {
    name: "E _loop 按时间推进",
    marker: "var now = typeof performance !== 'undefined' ? performance.now() : Date.now();",
    old: `    }, _this._loop = function () {
      _this._updateParticles();
      _this._renderParticles();

      if (_this._particles.length) {`,
    now: `    }, _this._loop = function () {
      if (_this._unmounted) return;
      // [patch-particle-effect-button] 粒子运动按时间推进（以 60fps 为基准）：原实现按帧推进、
      // 隐含假设 60fps。低帧率环境（如直播姬浏览器源被合成器限制到约 30fps）下每帧间隔变长，
      // 导致粒子飞行明显变慢、滞留，捕捉画面"缓慢"且粒子颜色长时间贴合 badge 渐变；
      // 改用时间步长后动画时长恒定，任何帧率下与编辑面板/浏览器预览一致。
      var now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (_this._lastFrameTime == null) _this._lastFrameTime = now;
      var step = (now - _this._lastFrameTime) / (1000 / 60);
      _this._lastFrameTime = now;
      if (step > 5) step = 5; // 后台/掉帧时防止超大步长导致粒子瞬时跳变
      _this._updateParticles(step);
      _this._renderParticles();

      if (_this._particles.length) {`,
  },
  {
    name: "F 生命周期迁移 + 卸载清理",
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
    name: "G badge 显现/消失改为 clip-path（由右向左逐段）",
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
    name: "I1 _addParticles 加卸载守卫",
    marker: "if (this._unmounted) return;\n      var _props2 = this.props,",
    old: `    value: function _addParticles(progress) {
      var _props2 = this.props,`,
    now: `    value: function _addParticles(progress) {
      if (this._unmounted) return;
      var _props2 = this.props,`,
  },
  {
    name: "I2 收敛粒子散布范围",
    marker: "(isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 120)",
    old: `      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 220);`,
    now: `      // [patch-particle-effect-button] 收敛粒子散布范围：原版 showing=220 过大，导致粒子
      // 起点/终点明显超出 badge 左右两端、削弱与 badge 的对应。hiding 保持 100、showing 收窄
      // 到 120，使粒子更贴近 badge 聚合。该常量非库暴露的 prop，只能通过补丁调整。
      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 120);`,
  },
  {
    name: "J 粒子存活完整帧数",
    marker: "death: frames,",
    old: `        life: 0,
        death: status === 'hiding' ? frames - 20 + Math.random() * 40 : frames,
        speed: _speed,
        size: _size`,
    now: `        life: 0,
        // [patch-particle-effect-button] 粒子存活完整帧数（原版 death 在 hiding 时提前随机死亡），
        // 与 badge 滑入/滑出动画全程同步，避免粒子提前死亡触发 _cycleStatus 提前切换 status，
        // 使 badge 在未完全滑出时闪现消失。
        death: frames,
        speed: _speed,
        size: _size`,
  },
  {
    name: "K1 _updateParticles 接收时间步长",
    marker: "value: function _updateParticles(step) {",
    old: `    value: function _updateParticles() {
      var oscillationCoefficient = this.props.oscillationCoefficient;`,
    now: `    value: function _updateParticles(step) {
      step = step || 1;
      var oscillationCoefficient = this.props.oscillationCoefficient;`,
  },
  {
    name: "K2 _updateParticles 按步长推进",
    marker: "p.x += p.speed * step;",
    old: `          p.x += p.speed;
          p.y = oscillationCoefficient * Math.sin(p.counter * p.increase);
          p.life++;
          p.counter += status === 'hiding' ? 1 : -1;`,
    now: `          p.x += p.speed * step;
          p.y = oscillationCoefficient * Math.sin(p.counter * p.increase);
          p.life += step;
          p.counter += (status === 'hiding' ? 1 : -1) * step;`,
  },
  {
    name: "L _renderParticles：canvas 防御 + 按位置取色 + 圆形 arc",
    marker: "this._ctx.arc(p.x, p.y, p.size, 0, 2 * Math.PI);",
    old: `      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          this._ctx.translate(p.startX, p.startY);
          this._ctx.rotate(p.angle * Math.PI / 180);
          this._ctx.globalAlpha = status === 'hiding' ? 1 - p.life / p.death : p.life / p.death;
          this._ctx.beginPath();

          if (type === 'circle') {
            this._ctx.arc(p.x, p.y, p.size, 0, 2 * Math.PI);
          } else if (type === 'triangle') {
            this._ctx.moveTo(p.x, p.y);
            this._ctx.lineTo(p.x + p.size, p.y + p.size);
            this._ctx.lineTo(p.x + p.size, p.y - p.size);
          } else if (type === 'rectangle') {
            this._ctx.rect(p.x, p.y, p.size, p.size);
          }

          if (style === 'fill') {
            this._ctx.fill();
          } else if (style === 'stroke') {
            this._ctx.closePath();
            this._ctx.stroke();
          }

          this._ctx.globalAlpha = 1;
          this._ctx.rotate(-p.angle * Math.PI / 180);
          this._ctx.translate(-p.startX, -p.startY);
        }
      }`,
    now: `      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      // [patch-particle-effect-button] 防御：卸载/重挂载间隙 canvas 可能为 null，
      // 直接跳过本帧绘制（_loop 仍会推进粒子生命周期并正常收尾），避免读取 width 崩溃
      if (!this._canvas || !this._ctx) return;
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

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
          this._ctx.beginPath();

          if (type === 'circle') {
            this._ctx.arc(p.x, p.y, p.size, 0, 2 * Math.PI);
          } else if (type === 'triangle') {
            this._ctx.moveTo(p.x, p.y);
            this._ctx.lineTo(p.x + p.size, p.y + p.size);
            this._ctx.lineTo(p.x + p.size, p.y - p.size);
          } else if (type === 'rectangle') {
            this._ctx.rect(p.x, p.y, p.size, p.size);
          }

          if (style === 'fill') {
            this._ctx.fill();
          } else if (style === 'stroke') {
            this._ctx.closePath();
            this._ctx.stroke();
          }

          this._ctx.globalAlpha = 1;
          this._ctx.rotate(-p.angle * Math.PI / 180);
          this._ctx.translate(-p.startX, -p.startY);
        }
      }`,
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
