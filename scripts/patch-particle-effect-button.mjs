/**
 * react-particle-effect-button 补丁（postinstall 自动执行）
 *
 * 原则：库的粒子动画行为保持原始实现不变（demo 第 5 个 "Refresh" 按钮的原参数、原粒子散布/
 * 聚合/消散逻辑、原 render 的 transform 滑入滑出）。补丁做三件事：
 *
 *  1. 生命周期兼容（必须，否则库在 React 18/19 下不可用）：
 *     - 原库用已废弃的 componentWillReceiveProps（React 18/19 不再调用）→ 改用
 *       componentDidUpdate，确保 hidden 变化一定触发粒子动画；
 *     - 卸载时取消 RAF 并置 _unmounted，避免组件销毁后 _loop/_addParticles 继续访问
 *       canvas 触发运行时崩溃（React StrictMode 双挂载场景下尤为必要）。
 *  2. 色调调整（项目需求）：粒子颜色按粒子当前绝对水平位置映射到
 *     红橙黄暖色相区间（hue 0°~60°），与 badge 背景渐变（0°→30°→60°）严格对应。
 *  3. 动画行为修正（项目需求，均为围绕原库在缩放场景/React 时序下的适配）：
 *     - patch 7/8 修复聚合起始/首帧 badge 闪现（progress 同步 + 挂载即测量 _rect）；
 *     - patch 9a~9h 视觉缩放：canvas 分辨率=视觉尺寸、粒子坐标/位移/振荡随视觉缩放比
 *       等比放大，保证编辑 iframe（缩放预览）与浏览器源（1:1）粒子相对 badge 完全一致。
 *       原库死亡时序保持不动（death=frames-20+rand*40）：粒子按生成线从左到右渐进生成，
 *       死亡顺序天然=出生顺序=从左到右，与 badge 从左往右消失方向一致，无需任何补丁。
 *
 * 补丁以"原始库 dist 文件"为基准（old 文本取自原版），`now` 为最终产物，可重复执行（幂等）。
 * node_modules 直接改动会在 npm ci 后被还原，必须同步到本脚本。
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
    name: "1 生命周期：componentWillReceiveProps → componentDidUpdate + 卸载清理",
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
      // React 18/19 已移除 componentWillReceiveProps，改用必然触发的 componentDidUpdate
      // 处理 hidden 变化 → 触发粒子动画。
      if (this.props.hidden !== prevProps.hidden) {
        var props = this.props;
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
  }, {
    key: 'componentWillUnmount',
    value: function componentWillUnmount() {
      // 卸载时立即取消 RAF 并标记 _unmounted，避免组件销毁后 _loop/_addParticles
      // 仍访问 canvas 触发 "Cannot read properties of null" 崩溃
      this._unmounted = true;
      if (this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = null;
      }
    }
  }, {`,
  },
  {
    name: "2 _startAnimation 复位 _unmounted",
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
    name: "3 _addParticles 加卸载守卫",
    marker: "if (this._unmounted) return;\n      var _props2 = this.props,",
    old: `    value: function _addParticles(progress) {
      var _props2 = this.props,`,
    now: `    value: function _addParticles(progress) {
      if (this._unmounted) return;
      var _props2 = this.props,`,
  },
  {
    name: "4 色调调整：粒子颜色按位置映射红橙黄（hue 0~60）",
    marker: "'hsl(' + Math.round(60 * _rel) + ',90%,60%)'",
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
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          // 色调调整：按粒子当前绝对水平位置（startX + x，绘制坐标即绝对坐标）映射到
          // 红橙黄暖色相区间（hue 0°~60°，左红右黄），与 badge 渐变 0°→30°→60° 严格对应。
          // 粒子其余参数/分布/运动/方向/范围保持原始库行为不变。
          var _pad = this.props.canvasPadding * (this._visualScale || 1);
          var _w = this._rect.width || 1;
          var _rel = Math.max(0, Math.min(1, (p.startX + p.x - _pad) / _w));
          this._ctx.fillStyle = this._ctx.strokeStyle = 'hsl(' + Math.round(60 * _rel) + ',90%,60%)';
          this._ctx.translate(p.startX, p.startY);
          this._ctx.rotate(p.angle * Math.PI / 180);
          this._ctx.globalAlpha = status === 'hiding' ? 1 - p.life / p.death : p.life / p.death;
          this._ctx.beginPath();`,
  },
  {
    name: "7 修复聚合起始首帧 badge 闪现：showing 时同步置 progress=100",
    marker: "this.setState({ status: 'showing', progress: 100 }, this._startAnimation);",
    old: `        } else if (status === 'hidden' && !props.hidden) {
          this.setState({ status: 'showing' }, this._startAnimation);`,
    now: `        } else if (status === 'hidden' && !props.hidden) {
          // 状态切到 showing 时 progress 必须同步置为 100：若沿用初始/旧值（0），
          // 首个 showing render 的 transform 位移为 0，badge 会完整可见一帧后再被
          // anime 首帧拉到 100 隐藏，形成"消散结束后 badge 闪现"（编辑循环/连续入场
          // 场景每轮都会闪）。progress=100 时 badge 被 wrapper overflow:hidden 完全
          // 裁剪不可见，随后 anime 100→0 正常滑入聚合。
          this.setState({ status: 'showing', progress: 100 }, this._startAnimation);`,
  },
  {
    name: "8 挂载时测量 _rect，修复 showing 起始帧 badge 闪现（真正的根因）",
    marker: "key: 'componentDidMount',\n    value: function componentDidMount() {",
    old: `  createClass(ParticleEffectButton, [{
    key: 'componentDidUpdate',`,
    now: `  createClass(ParticleEffectButton, [{
    key: 'componentDidMount',
    value: function componentDidMount() {
      // _startAnimation 只在 hidden 翻转（动画启动）时测量 _rect；而 showing 的首帧
      // render 先于 _startAnimation 执行（setState 回调在 render 之后），此时 _rect 仍为
      // 初始 {width:0,height:0} → px=ceil(0*progress/100)=0 → badge 不被裁剪、完整可见一帧，
      // 即"开始瞬间闪现"（补丁 7 置 progress=100 无效，因为 size=0）。
      // 挂载后立即测量一次真实尺寸，使 showing 起始帧 progress=100 时 px=真实宽度，
      // badge 被 wrapper overflow:hidden 完全裁剪不可见。
      if (this._wrapper) {
        this._rect = this._wrapper.getBoundingClientRect();
      }
    }
  }, {
    key: 'componentDidUpdate',`,
  },
  {
    name: "9a 视觉缩放：canvas 分辨率=视觉尺寸、CSS=逻辑尺寸，避免放大模糊与范围错乱",
    marker: "// 视觉缩放比（CSS zoom × transform:scale 的乘积）",
    old: `      _this._rect = _this._wrapper.getBoundingClientRect();
      _this._canvas.width = _this._rect.width + canvasPadding * 2;
      _this._canvas.height = _this._rect.height + canvasPadding * 2;
      _this._ctx = _this._canvas.getContext('2d');`,
    now: `      _this._rect = _this._wrapper.getBoundingClientRect();
      // 视觉缩放比（CSS zoom × transform:scale 的乘积）：首次测量时 canvas 尚无显式
      // CSS 尺寸（渲染宽=属性宽），canvas 视觉宽/属性宽 恰等于父级所有缩放之积。
      // 保存后粒子坐标按此等比放大——粒子特效按"放大后的 badge"重新绘制，而不是把
      // 位图 canvas 整体拉伸（拉伸会导致粒子范围错位 + 模糊）。
      if (_this._visualScale == null) {
        var _cw0 = _this._canvas.width || 1;
        _this._visualScale = _this._canvas.getBoundingClientRect().width / _cw0;
      }
      var _vs = _this._visualScale;
      // 分辨率 = 视觉尺寸（badge 视觉宽 + padding 视觉宽×2）→ 缩放后 1:1 清晰；
      // CSS 尺寸 = 分辨率/视觉缩放（原始逻辑尺寸）→ 避免被 zoom/scale 二次放大变糊。
      _this._canvas.width = _this._rect.width + canvasPadding * 2 * _vs;
      _this._canvas.height = _this._rect.height + canvasPadding * 2 * _vs;
      _this._canvas.style.width = _this._rect.width / _vs + canvasPadding * 2 + 'px';
      _this._canvas.style.height = _this._rect.height / _vs + canvasPadding * 2 + 'px';
      _this._ctx = _this._canvas.getContext('2d');`,
  },
  {
    name: "9b 视觉缩放：粒子生成起点（canvasPadding）等比放大",
    marker: "var x = canvasPadding * (this._visualScale || 1);",
    old: `      var x = canvasPadding;
      var y = canvasPadding;`,
    now: `      var x = canvasPadding * (this._visualScale || 1);
      var y = canvasPadding * (this._visualScale || 1);`,
  },
  {
    name: "9c 视觉缩放：粒子来源偏移系数（220）等比放大",
    marker: "var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 220) * (this._visualScale || 1);",
    old: `      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 220);`,
    now: `      var progressValue = (isHorizontal ? width : height) * progress + delta * (status === 'hiding' ? 100 : 220) * (this._visualScale || 1);`,
  },
  {
    name: "9d 视觉缩放：粒子水平位移等比放大",
    marker: "x: status === 'hiding' ? 0 : _speed * -frames * (this._visualScale || 1),",
    old: `        x: status === 'hiding' ? 0 : _speed * -frames,`,
    now: `        x: status === 'hiding' ? 0 : _speed * -frames * (this._visualScale || 1),`,
  },
  {
    name: "9e 视觉缩放：粒子尺寸等比放大",
    marker: "size: _size * (this._visualScale || 1)",
    old: `        size: _size`,
    now: `        size: _size * (this._visualScale || 1)`,
  },
  {
    name: "9f 视觉缩放：色调映射起点（canvasPadding）等比放大",
    marker: "var _pad = this.props.canvasPadding * (this._visualScale || 1);",
    old: `          var _pad = this.props.canvasPadding;`,
    now: `          var _pad = this.props.canvasPadding * (this._visualScale || 1);`,
  },
  {
    name: "9g 视觉缩放：粒子 y 振荡振幅等比放大（否则缩放后轨迹近似纯水平直线，呈水平成簇感）",
    marker: "p.y = oscillationCoefficient * Math.sin(p.counter * p.increase) * (this._visualScale || 1);",
    old: `          p.y = oscillationCoefficient * Math.sin(p.counter * p.increase);`,
    now: `          p.y = oscillationCoefficient * Math.sin(p.counter * p.increase) * (this._visualScale || 1);`,
  },
  {
    name: "9h 视觉缩放：粒子逐帧 x 位移等比放大（否则 9d 把初始位移放大、逐帧步进却没放大，粒子每秒视觉位移减半，追不上 badge 边缘 → 聚簇且与 badge 进度失配）",
    marker: "p.x += p.speed * (this._visualScale || 1);",
    old: `          p.x += p.speed;`,
    now: `          p.x += p.speed * (this._visualScale || 1);`,
  },
];

function applyReplace(name, marker, old, now, src) {
  if (src.includes(marker)) {
    return { src, applied: false, skip: true };
  }
  if (!src.includes(old)) {
    return { src, applied: false, skip: false };
  }
  return { src: src.replace(old, now), applied: true, skip: false };
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
