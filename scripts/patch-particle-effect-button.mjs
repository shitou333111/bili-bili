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
    // marker 取守卫单行（补丁 21 会在其后插入粒子上限，跨行 marker 会被拆散导致误报）
    marker: "if (this._unmounted) return;",
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
  {
    name: "10 视觉缩放：badge 滑入滑出裁剪位移量换算回本地单位（修复缩放<1 时右侧一段一次性出现/消失）",
    marker: "var size = (this._isHorizontal() ? this._rect.width : this._rect.height) / (this._visualScale || 1);",
    old: `        var size = this._isHorizontal() ? this._rect.width : this._rect.height;`,
    now: `        // 视觉→本地单位换算：_rect 来自 getBoundingClientRect()，是含祖先
        // zoom/transform:scale 的视觉尺寸；而 translateX 的 px 是本地布局单位。
        // badge 被 transform:scale(S<1) 缩小时直接用视觉宽做位移，擦除距离只有 W·S
        // （W=badge 本地宽），右侧 (1−S)·W 段会：聚合时首帧整段一次性出现、消散时一直
        // 残留到 status='hidden' 的 visibility:hidden 一次性消失（S=1 无症状，S 越小越明显）。
        // 除以视觉缩放比换回本地宽度，擦除距离=完整 badge 宽，滑入/滑出全程连续。
        var size = (this._isHorizontal() ? this._rect.width : this._rect.height) / (this._visualScale || 1);`,
  },
  {
    name: "11 挂载时提前计算 _visualScale（showing 首帧 render 早于 _startAnimation，补丁 10 需要它）",
    marker: "_vs1 > 0",
    old: `      if (this._wrapper) {
        this._rect = this._wrapper.getBoundingClientRect();
      }
    }`,
    now: `      if (this._wrapper) {
        this._rect = this._wrapper.getBoundingClientRect();
      }
      // 提前计算视觉缩放比（与 9a 同公式）：showing 的首帧 render 早于 _startAnimation，
      // 补丁 10 的位移量换算需要 _visualScale，若此处不提前算，首帧会按 || 1 回退，
      // 缩放<1 时右侧一段仍会闪现一帧。仅在测得有效比值时写入，避免隐藏容器测得 0。
      if (this._visualScale == null && this._canvas) {
        var _cw1 = this._canvas.width || 1;
        var _vs1 = this._canvas.getBoundingClientRect().width / _cw1;
        if (_vs1 > 0) this._visualScale = _vs1;
      }
    }`,
  },
  {
    name: "12 竖线根因：横向 spawn X 偏移写死 0 → 收敛终点塌缩成竖线；加 ±h/2 横向抖动打散成随机云",
    // marker 取注释片段而非 x 行：补丁 19 会把 x 行改写为 clamp 版，若 marker 是 x 行则
    // 19 应用后 12 的 marker 消失，重复执行时 12 误报"未匹配"警告
    marker: "// 竖线根因（原库横向模式固有缺陷）",
    old: `            x: x + (isHorizontal ? 0 : width * Math.random()),
            y: y + (isHorizontal ? height * Math.random() : 0)`,
    now: `            // 竖线根因（原库横向模式固有缺陷）：横向 X 偏移原为写死 0 → 同批生成的所有粒子
            // 共享同一 startX；收敛末期 p.x 一律趋于 0（p.x=speed*vs*(k-frames)，k=frames 时与
            // speed 无关），屏幕 X 塌缩到 startX 一点，而 Y=startY=height*rand 铺满整高 →
            // 聚合末/消散初塌缩成一条高度=badge 高的竖线。竖线长度=badge 高度（早期小按钮
            // h40 不易察觉，badge 增高到 ~100 后暴露）。修复：给每个粒子加与纵向散布同量级的
            // 横向随机抖动（±height/2，与 Y 散布 [0,height] 各向同性），使收敛终点成为一片
            // 随机云而非一条竖线。注：随机 speed 只能拉开飞行中段，终点 p.x=0 与 speed 无关，
            // 无法消除塌缩，必须抖动 startX。
            x: x + (isHorizontal ? (Math.random() - 0.5) * height : width * Math.random()),
            y: y + (isHorizontal ? height * Math.random() : 0)`,
  },
  {
    name: "16 聚合两段感：废弃 13/14/15 的「整体延后一个 duration」方案，恢复原库 update（与消散同构、零延迟），聚合改由 easing 时间反演（补丁 17）",
    marker: "_clipMirror16",
    old: `        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          setTimeout(function () {
            _this.setState({ progress: value });
          });

          if (duration) {
            _this._addParticles(value / 100);
          }
        }`,
    now: `        update: function update(anim) {
          var value = anim.animatables[0].target.value;
          // 聚合与消散共用同一逐帧驱动、零延迟：揭示窗口 = 粒子扫掠窗口 [0,duration]，
          // 同时开始、同刻完成；两者的差异只由 easing 承担（聚合 = 消散的时间反演，见补丁 17）。
          // 历史补丁 13/14/15 曾把聚合揭示整体延后一个 duration → 前 1300ms badge 完全不可见、
          // 粒子扫掠完才开始单独揭示，即"粒子聚完 badge 再单独显示"的两段感，已废弃。
          // _clipMirror16
          setTimeout(function () {
            _this.setState({ progress: value });
          });

          if (duration) {
            _this._addParticles(value / 100);
          }
        }`,
  },
  {
    name: "17 聚合用消散的时间反演缓动：消散 easeInExpo（慢→快）→ 聚合 easeOutExpo（快→慢，同一 Expo 家族），粒子扫掠线/揭示边界/光晕共用同一 progress",
    marker: "_easeMirror17",
    old: `        easing: easing,`,
    now: `        // 聚合 easing = 消散 easing 的时间反演（Expo 家族 Out 贝塞尔）：_easeMirror17
        easing: status === 'hiding' ? easing : 'easeOutExpo',`,
  },
  {
    // 粒子范围超出 badge 根因：_visualScale 首测后永久缓存（9a 仅 ==null 时测、11 仅挂载时测），
    // 而挂载时（+0ms）与动画启动时（+SHOW_DELAY 60ms）之间视觉缩放可能仍在变化（编辑画布
    // fit/缩放过渡未稳定等）→ s0<S，扫掠范围按 F=S/s0 倍整体超出 badge（canvas视觉宽/badge
    // 视觉宽 = F + 300/B），且只在最初几轮失配、缩放稳定后自愈——与实测症状一致。
    // 修复：每次 _startAnimation 都重测（F≡1，范围恒为设计态）。测量前清空 canvas 显式
    // CSS 宽高：无显式宽度时 canvas 渲染宽=属性宽，gBCR宽/属性宽 恰为当前视觉缩放积
    // （与属性宽取值无关，含上一轮写入的属性宽同样成立）。
    name: "18 每次动画启动重测 _visualScale（修复最初几轮粒子范围超出 badge）",
    marker: "每次动画启动都重测视觉缩放比",
    old: `      if (_this._visualScale == null) {
        var _cw0 = _this._canvas.width || 1;
        _this._visualScale = _this._canvas.getBoundingClientRect().width / _cw0;
      }`,
    now: `      // 每次动画启动都重测视觉缩放比（补丁 18）：挂载时的测量值可能与动画启动时的实际
      // 视觉缩放不一致（fit/缩放过渡未稳定），缓存旧值会使粒子范围按 S/s0 倍超出 badge。
      // 测量前清空显式 CSS 宽高，此时 canvas 渲染宽=属性宽，gBCR宽/属性宽=当前视觉缩放。
      _this._canvas.style.width = '';
      _this._canvas.style.height = '';
      var _cw0 = _this._canvas.width || 1;
      var _vs0 = _this._canvas.getBoundingClientRect().width / _cw0;
      if (_vs0 > 0) _this._visualScale = _vs0;`,
  },
  {
    // badge 与粒子聚集区大小不一致根因：粒子收敛终点 X = startX = 生成线 x + 横向抖动，
    // 生成线 x 扫过 badge 宽 [pad, pad+width]（收敛云本应与 badge 等宽、中心对齐），但
    // 补丁 12 的抖动 ±height/2 不受约束 → 收敛云两侧各外扩 h/2（badge 高 ~100px 即两侧各
    // 外扩 ~50px），"位置对但 badge 比聚集区小一圈"。修复：把抖动 clamp 进 badge 矩形，
    // 抖动 j ∈ [-progressValue, width-progressValue] ⇒ startX = x+j ∈ [pad, pad+width]，
    // 收敛云 X 范围 = badge 宽（Y 侧 height*rand 本就在 [0,height] 矩形内）。仍保留随机
    // 抖动打散竖线（补丁 12 目的不变），只是不再越出 badge 边界。
    // clamp 按 direction 'left'（项目唯一用法，EntryBadge 未传 direction）校准。
    name: "19 聚集区与 badge 一致性：横向抖动 clamp 进 badge 矩形（收敛云不再两侧外扩 h/2）",
    marker: "_clamp19",
    old: `            x: x + (isHorizontal ? (Math.random() - 0.5) * height : width * Math.random()),
            y: y + (isHorizontal ? height * Math.random() : 0)`,
    now: `            // _clamp19 抖动 clamp 进 badge 矩形：j ∈ [-progressValue, width-progressValue]
            // ⇒ 收敛终点 startX = x+j ∈ [pad, pad+width]，聚集云与 badge 严格等宽等位
            x: x + (isHorizontal ? Math.max(-progressValue, Math.min(width - progressValue, (Math.random() - 0.5) * height)) : width * Math.random()),
            y: y + (isHorizontal ? height * Math.random() : 0)`,
  },
  {
    // 单帧 arc=146518 粒子爆炸根因：_startAnimation 可在旧 anime 时间线仍在跑时被重入调用
    // （componentDidUpdate hidden 翻转 / StrictMode 模拟重挂载等），而原实现从不取消旧 anime
    // （anime_min 返回值被丢弃、componentWillUnmount 只 cancel RAF）。旧时间线的 update 与
    // 新时间线交错改写 _progress（L "this._progress = progress"），delta = 两时间线进度差
    // ≈0.5~1/次 → 单批 15×(delta×100+1) ≈ 700~1500 粒/次 → 2 条时间线 ×~50 帧累计 ≈14.6 万
    // 活粒子同屏（粒子寿命 58~98 帧允许累积），单帧 arc=146518 ≈ 212ms longtask（实测
    // ≈1.45µs/arc）——与真实窗口 2 的 longtask max 212ms / 17 长帧完全自洽。
    // 修复：(1) 启动新动画前 best-effort pause 旧 anime；(2) 每次启动递增 _animGen，
    // update（含其 setTimeout）世代号不匹配即 return → 旧时间线彻底 no-op，
    // _progress 只被单一时间线单调推进，delta 回归 ~1/帧 → 粒子量回归 ~2700 稳态。
    name: "20 动画世代号守卫：_startAnimation 重入时停用旧 anime 时间线（根治单帧 arc 14.6 万粒子爆炸）",
    marker: "_noConcurrentAnime20",
    old: `      anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },
        value: status === 'hiding' ? 100 : 0,
        duration: duration,
        // 聚合 easing = 消散 easing 的时间反演（Expo 家族 Out 贝塞尔）：_easeMirror17
        easing: status === 'hiding' ? easing : 'easeOutExpo',
        begin: onBegin,
        update: function update(anim) {
          var value = anim.animatables[0].target.value;`,
    now: `      // _noConcurrentAnime20 动画世代号守卫：重入时旧 anime 若仍在跑，其 update 会与新
      // 时间线交错改写 _progress 使 delta 失控（单批 700~1500 粒，实测单帧 arc=146518 /
      // longtask 212ms）。启动新动画前 best-effort pause 旧 anime，并以 _animGen 世代号
      // 使旧时间线 update 彻底 no-op。
      if (_this._anime && typeof _this._anime.pause === 'function') {
        _this._anime.pause();
      }
      _this._animGen = (_this._animGen || 0) + 1;
      var _gen = _this._animGen;
      _this._anime = anime_min({
        targets: { value: status === 'hiding' ? 0 : 100 },
        value: status === 'hiding' ? 100 : 0,
        duration: duration,
        // 聚合 easing = 消散 easing 的时间反演（Expo 家族 Out 贝塞尔）：_easeMirror17
        easing: status === 'hiding' ? easing : 'easeOutExpo',
        begin: onBegin,
        update: function update(anim) {
          if (_gen !== _this._animGen) return;
          var value = anim.animatables[0].target.value;`,
  },
  {
    // 同屏粒子硬上限（防御性兜底）：正常稳态 ≈2700 粒（窗口 1 实测 1850），而并发时间线 bug
    // 曾单帧 arc=146518。补丁 20 根治之外的保险：即使仍有异常路径，5000 粒/帧 ≈ 7ms 绘制
    // （按实测 1.45µs/arc），把最坏卡顿钳制在可接受范围。
    name: "21 同屏粒子硬上限 5000（兜底：杜绝十万级单帧 arc）",
    marker: "_particleCap20",
    old: `    value: function _addParticles(progress) {
      if (this._unmounted) return;`,
    now: `    value: function _addParticles(progress) {
      if (this._unmounted) return;
      // _particleCap20 同屏粒子硬上限：正常稳态 ≈2700（实测 1850），5000 留余量；
      // 超限直接丢弃本批，最坏 5000 arc/帧 ≈ 7ms，杜绝十万级 arc 的单帧 200ms+ 卡顿。
      if (this._particles && this._particles.length >= 5000) return;`,
  },
  {
    // _updateParticles 死亡清理 bug：splice(i,1) 后被顶上来的元素被 i++ 跳过 → 死粒子
    // 滞留数组（不绘制但占 length）。滞留的纯死粒子数组还会让 _loop 的
    // "if (this._particles.length)" 恒真 → 粒子早已全部死亡却永不进入 _cycleStatus+onComplete，
    // 拖满 12.4s 兜底才结束。splice 后 i-- 修正遍历。
    name: "22 _updateParticles splice 后下标左移（死粒子不再滞留、loop 能正常收尾）",
    marker: "_spliceFix20",
    old: `        if (p.life > p.death) {
          this._particles.splice(i, 1);
        } else {`,
    now: `        if (p.life > p.death) {
          this._particles.splice(i, 1);
          i--; // _spliceFix20 splice 后下标左移，避免跳过顶上来的元素
        } else {`,
  },
  {
    // 补丁 20 配套：update 顶部守卫只拦同步 _addParticles；已排队的 setTimeout(setState)
    // 在旧时间线被停用后仍会执行，把过期 progress 写回（不产生粒子，但揭示进度闪一帧）。
    // 世代号不匹配直接丢弃。
    name: "23 setTimeout setState 加世代号守卫（旧时间线过期 progress 不再写回）",
    marker: "_genGuard23",
    old: `          setTimeout(function () {
            _this.setState({ progress: value });
          });`,
    now: `          setTimeout(function () {
            if (_gen !== _this._animGen) return; // _genGuard23 旧时间线过期 progress 不写回
            _this.setState({ progress: value });
          });`,
  },
  {
    // 归因计量：arc 计数只能说明"每帧画了多少粒子"，不能说明"画得多贵"。实测长帧与
    // arc 峰值期强相关，但 EntryBadge 光晕 blur 层存活期同样重叠，需实测粒子库逐帧
    // 耗时（update=JS 数学 / render=canvas 状态切换+arc+fill）才能在两者之间定罪。
    // 耗时累加到 window 全局，?diag=1 探针按采样窗口读增量输出。
    name: "24 _loop 逐帧耗时计量（update/render 分开，归因探针按窗口读增量）",
    marker: "_diagDraw24",
    old: `    }, _this._loop = function () {
      _this._updateParticles();
      _this._renderParticles();`,
    now: `    }, _this._loop = function () {
      // _diagDraw24 归因计量：本帧 update/render 耗时累加到 window（探针读增量）
      var _t0 = performance.now();
      _this._updateParticles();
      var _t1 = performance.now();
      _this._renderParticles();
      var _t2 = performance.now();
      window.__pebUpdMs = (window.__pebUpdMs || 0) + (_t1 - _t0);
      window.__pebRenderMs = (window.__pebRenderMs || 0) + (_t2 - _t1);
      window.__pebLoopN = (window.__pebLoopN || 0) + 1;`,
  },
  {
    // 实测 render 稳定 ~10.2ms/帧（占 8s 窗口 23%、特效期帧预算 62%），每粒子成本构成：
    // hsl 串拼接+颜色解析、translate/rotate×2（矩阵状态切换）、globalAlpha 两次写。
    // 本补丁为低风险视觉无损优化（type='circle' 是默认值，EntryBadge 实际走的分支）：
    //  1) hsl 串缓存：hue=Math.round(60*rel) 只有 0~60 共 61 种取值 → 预建字符串，
    //     免每粒子每帧字符串拼接；且 fill 模式只写 fillStyle（stroke 同理），省一半颜色解析。
    //  2) circle 跳过 ctx.translate/rotate：圆旋转不改变形状，把 translate(startX,startY)∘
    //     rotate(θ) 数学折算进圆心绝对坐标（对任意入口矩阵恒等），每粒子省 4 次 canvas
    //     矩阵状态切换；triangle/rectangle 旋转影响形状，仍走原 translate/rotate。
    //  3) 循环不变量 (_pad/_w) 提出循环；globalAlpha 归 1 移到循环后统一做
    //     （循环内每次绘制前都会重设 alpha，中间无绘制，状态可观察性不变）。
    name: "25 render 低开销：hsl 串缓存 + circle 免 translate/rotate（视觉无损）",
    marker: "_renderOpt25",
    old: `    value: function _renderParticles() {
      var _props4 = this.props,
          color = _props4.color,
          type = _props4.type,
          style = _props4.style;
      var status = this.state.status;


      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          // 色调调整：按粒子当前绝对水平位置（startX + x，绘制坐标即绝对坐标）映射到
          // 红橙黄暖色相区间（hue 0°~60°，左红右黄），与 badge 渐变 0°→30°→60° 严格对应。
          // 粒子其余参数/分布/运动/方向/范围/存活帧数保持原始库行为不变。
          var _pad = this.props.canvasPadding * (this._visualScale || 1);
          var _w = this._rect.width || 1;
          var _rel = Math.max(0, Math.min(1, (p.startX + p.x - _pad) / _w));
          this._ctx.fillStyle = this._ctx.strokeStyle = 'hsl(' + Math.round(60 * _rel) + ',90%,60%)';
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
      }
    }`,
    now: `    value: function _renderParticles() {
      var _props4 = this.props,
          color = _props4.color,
          type = _props4.type,
          style = _props4.style;
      var status = this.state.status;


      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._ctx.fillStyle = this._ctx.strokeStyle = color;

      // _renderOpt25 低开销渲染（视觉无损）：
      // 1) hsl 串缓存（hue 仅 0~60 共 61 种取值，预建免每粒子拼接）；
      // 2) circle 跳过 ctx.translate/rotate，把变换折算进圆心绝对坐标
      //    （triangle/rectangle 旋转影响形状，仍走原矩阵变换）；
      // 3) 循环不变量提出循环、globalAlpha 归 1 移到循环后统一做
      //    （每次绘制前均重设 alpha，循环中间无绘制，可观察状态不变）。
      if (!this._hslCache) {
        this._hslCache = [];
        for (var _k25 = 0; _k25 <= 60; _k25++) this._hslCache[_k25] = 'hsl(' + _k25 + ',90%,60%)';
      }
      var _cache25 = this._hslCache;
      var _pad25 = this.props.canvasPadding * (this._visualScale || 1);
      var _w25 = this._rect.width || 1;
      var _isCircle25 = type === 'circle';

      for (var i = 0; i < this._particles.length; ++i) {
        var p = this._particles[i];

        if (p.life < p.death) {
          // 色调调整：按粒子当前绝对水平位置（startX + x，绘制坐标即绝对坐标）映射到
          // 红橙黄暖色相区间（hue 0°~60°，左红右黄），与 badge 渐变 0°→30°→60° 严格对应。
          // 粒子其余参数/分布/运动/方向/范围/存活帧数保持原始库行为不变。
          var _rel = Math.max(0, Math.min(1, (p.startX + p.x - _pad25) / _w25));
          var _hsl25 = _cache25[Math.round(60 * _rel)];
          if (style === 'fill') {
            this._ctx.fillStyle = _hsl25;
          } else {
            this._ctx.strokeStyle = _hsl25;
          }
          this._ctx.globalAlpha = status === 'hiding' ? 1 - p.life / p.death : p.life / p.death;
          this._ctx.beginPath();

          if (_isCircle25) {
            // 等价折算：translate(startX,startY)∘rotate(θ) 作用于 (p.x,p.y)
            //   cx = startX + x·cosθ − y·sinθ / cy = startY + x·sinθ + y·cosθ
            var _rad25 = p.angle * Math.PI / 180;
            var _cos25 = Math.cos(_rad25);
            var _sin25 = Math.sin(_rad25);
            this._ctx.arc(p.startX + p.x * _cos25 - p.y * _sin25, p.startY + p.x * _sin25 + p.y * _cos25, p.size, 0, 2 * Math.PI);
          } else {
            this._ctx.translate(p.startX, p.startY);
            this._ctx.rotate(p.angle * Math.PI / 180);

            if (type === 'triangle') {
              this._ctx.moveTo(p.x, p.y);
              this._ctx.lineTo(p.x + p.size, p.y + p.size);
              this._ctx.lineTo(p.x + p.size, p.y - p.size);
            } else if (type === 'rectangle') {
              this._ctx.rect(p.x, p.y, p.size, p.size);
            }
          }

          if (style === 'fill') {
            this._ctx.fill();
          } else if (style === 'stroke') {
            this._ctx.closePath();
            this._ctx.stroke();
          }

          if (!_isCircle25) {
            this._ctx.rotate(-p.angle * Math.PI / 180);
            this._ctx.translate(-p.startX, -p.startY);
          }
        }
      }

      this._ctx.globalAlpha = 1;
    }`,
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
