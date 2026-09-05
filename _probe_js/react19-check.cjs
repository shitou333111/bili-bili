/**
 * React 19 + 打补丁后的 react-particle-effect-button 在 jsdom 中的确定性验证：
 * 1. 挂载 hidden=true → 翻转 hidden=false → 动画是否启动（_startAnimation 是否执行）
 * 2. anime 是否驱动粒子生成（onComplete 是否被调用）
 * 3. 使用函数式 size/speed（本次修复）时链路是否正常
 */
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.NodeList = dom.window.NodeList;
global.HTMLCollection = dom.window.HTMLCollection;
global.Document = dom.window.Document;
global.DocumentFragment = dom.window.DocumentFragment;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;
global.HTMLDivElement = dom.window.HTMLDivElement;
global.HTMLSpanElement = dom.window.HTMLSpanElement;
global.SVGElement = dom.window.SVGElement;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.CSS = dom.window.CSS;
// 注意：不要覆盖 global.performance（jsdom 的 performance.now 会引用 global 造成循环）

// canvas 2d context stub（jsdom 不支持 canvas）
dom.window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === "2d") {
    const self = this;
    const ctx = {
      canvas: self,
      fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1, lineCap: "", lineJoin: "",
    };
    for (const m of ["clearRect","fillRect","strokeRect","beginPath","closePath","moveTo","lineTo","arc","arcTo",
      "bezierCurveTo","quadraticCurveTo","rect","fill","stroke","clip","save","restore","translate","rotate","scale",
      "setTransform","transform","fillText","strokeText","measureText"]) {
      ctx[m] = typeof ctx[m] === "function" ? ctx[m] : () => { if (m === "measureText") return { width: 0 }; };
    }
    return ctx;
  }
  return null;
};

const React = require("react");
const { createRoot } = require("react-dom/client");
const ParticleButton = require("react-particle-effect-button");

const PROPS = {
  color: "#003ff1",
  duration: 1300,
  easing: "easeInExpo",
  size: () => Math.floor(Math.random() * 3 + 1),
  speed: () => Math.random() * 4 - 2,
  particlesAmountCoefficient: 10,
  oscillationCoefficient: 1,
};

const logs = [];
const log = (m) => { logs.push(m); console.log(`[t=${(performance.now() / 1000).toFixed(2)}s] ${m}`); };

const rootEl = document.getElementById("root");
const root = createRoot(rootEl);

let hidden = true;
let completes = 0;
root.render(React.createElement(ParticleButton, {
  ...PROPS,
  hidden,
  onComplete: () => { completes++; log(`onComplete #${completes}（hidden=${hidden}）`); },
}, React.createElement("div", { style: { width: 140, height: 60 } }, "TEST")));

log(`挂载完成，DOM canvas 数=${rootEl.querySelectorAll("canvas").length}`);

setTimeout(() => {
  hidden = false;
  log("翻转 hidden=false → 应触发 componentDidUpdate → showing");
  root.render(React.createElement(ParticleButton, {
    ...PROPS,
    hidden,
    onComplete: () => { completes++; log(`onComplete #${completes}（hidden=${hidden}）`); },
  }, React.createElement("div", { style: { width: 140, height: 60 } }, "TEST")));
}, 200);

setTimeout(() => {
  const canvas = rootEl.querySelector("canvas");
  const wrapper = rootEl.querySelector(".styles_wrapper__3KXDn") || rootEl.querySelector("[class*=wrapper]");
  log(`3s 检查：canvas[attr=${canvas?.width}×${canvas?.height} style="${canvas?.style.width}"] wrapper.visibility=${wrapper ? getComputedStyle(wrapper).visibility : "?"}`);
  log(`onComplete 总次数=${completes}（>0 说明动画链路完整：componentDidUpdate→_startAnimation→anime→粒子→onComplete）`);
  log(hidden === false && completes > 0 ? "✅ 验证通过：函数式 size/speed 下动画链路正常" : "❌ 验证失败：动画未启动");
  process.exit(0);
}, 8000);
