/**
 * FoamTree 版权 logo 移除补丁（postinstall 自动执行）
 *
 * @carrotsearch/foamtree 是 Demo 版：内置一个始终存在的 attribution 分组，
 * 会在画布底部（右下角）强制绘制公司 logo。
 *
 * 两层补丁：
 *   1. 把 XOR 混淆的 logo 文本替换为空串 → 文字不显示
 *   2. 强制 w.titleBarShown=false → 标题栏背景矩形也不绘制（否则会留下一个无文字色块）
 *
 * 通过 API 的 attributionWeight:0 / attributionText:"" 无法关闭（Demo 版忽略该配置）。
 *
 * 幂等：已打补丁时直接跳过。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(
  __dirname,
  "..",
  "node_modules",
  "@carrotsearch",
  "foamtree",
  "foamtree.js"
);

try {
  if (!existsSync(file)) {
    console.warn("[patch-foamtree] 未找到 foamtree.js（依赖未安装？），跳过");
    process.exit(0);
  }
  let src = readFileSync(file, "utf8");
  let changed = false;

  // 补丁 1：XOR 混淆后的 "Carrot Search FoamTree …carrotsearch.com/foamtree for more details."
  const OLD_TEXT =
    'yd.Zf("B`ssnu!Rd`sbi!Gn`lUsdd!whrt`mh{`uhno/!Busm,bmhbj!uid!mnfn!un!fn!un!iuuqr;..b`ssnurd`sbi/bnl.gn`lusdd!gns!lnsd!edu`hmr/")';
  const NEW_TEXT = 'yd.Zf("")';
  if (src.includes(OLD_TEXT)) {
    src = src.replace(OLD_TEXT, NEW_TEXT);
    changed = true;
    console.log("[patch-foamtree] 补丁1: 已移除 logo 文字");
  }

  // 补丁 2：阻止 attribution 组的标题栏背景矩形绘制（否则文字清空后仍留下色块）
  // 注意：OLD_TITLEBAR 必须包含末尾分号，否则替换后 `;else` 变成无效语法
  const OLD_TITLEBAR = 'if(b.attribution)var y=yd.Zf("");';
  const NEW_TITLEBAR = 'if(b.attribution){var y=yd.Zf("");w.titleBarShown=false}';
  if (src.includes(OLD_TITLEBAR) && !src.includes(NEW_TITLEBAR)) {
    src = src.replace(OLD_TITLEBAR, NEW_TITLEBAR);
    changed = true;
    console.log("[patch-foamtree] 补丁2: 已禁用 attribution 标题栏背景");
  }

  // 修复：旧版补丁不含分号，替换后残留 `;else` 导致语法错误
  // 修复前：if(b.attribution){var y=...;w.titleBarShown=false};else
  // 修复后：if(b.attribution){var y=...;w.titleBarShown=false}else
  if (src.includes("w.titleBarShown=false};else")) {
    src = src.replace("w.titleBarShown=false};else", "w.titleBarShown=false}else");
    changed = true;
    console.log("[patch-foamtree] 修复: 已移除残留分号（;else → else）");
  }

  // 补丁 3：attribution 组权重强制为 0。
  // Demo 版在 l() 函数中无条件给 attribution 组分配至少 2.5% 的权重
  // （Math.max(.025, attributionWeight)），即使 API 设置 attributionWeight:0 也无效。
  // 结果是右下角始终有一个色块（attribution 组的多边形），之前补丁只清空了文字和标题栏。
  // 这里把权重计算改为 0，使 attribution 组的面积为零、视觉上不可见。
  const OLD_WEIGHT = "y.attribution&&(y.weight=Math.max(.025,a.Gg)*m)";
  const NEW_WEIGHT = "y.attribution&&(y.weight=0)";
  if (src.includes(OLD_WEIGHT) && !src.includes(NEW_WEIGHT)) {
    src = src.replace(OLD_WEIGHT, NEW_WEIGHT);
    changed = true;
    console.log("[patch-foamtree] 补丁3: 已强制 attribution 组权重为 0");
  }

  if (changed) {
    writeFileSync(file, src, "utf8");
    console.log("[patch-foamtree] 补丁完成");
  } else {
    console.log("[patch-foamtree] 已打补丁，跳过");
  }
} catch (e) {
  console.warn("[patch-foamtree] 补丁失败:", e.message);
  process.exit(0);
}