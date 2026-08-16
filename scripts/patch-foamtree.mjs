/**
 * FoamTree 版权 logo 移除补丁（postinstall 自动执行）
 *
 * @carrotsearch/foamtree 是 Demo 版：内置一个始终存在的 attribution 分组，
 * 会在画布底部（右下角）强制绘制 "Carrot Search FoamTree" 公司 logo。
 * 通过 API 的 attributionWeight:0 / attributionText:"" 无法关闭（Demo 版忽略该配置，
 * attribution 分组在模型加载时无条件创建，见 foamtree.js 第 239 行标题栏绘制逻辑）。
 *
 * 解决方式：把 foamtree.js 中硬编码的 XOR 混淆 logo 字符串替换为空串，
 * 使标题栏绘制逻辑 y=yd.Zf("")="" → "y&&0!==y.length" 为假 → 不再绘制 logo 与背景条。
 * 这样全平台（含移动端 WebView）都不会再出现公司 logo。
 *
 * 幂等：已打补丁（存在 yd.Zf("")）时直接跳过。
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

// XOR 混淆后的 "Carrot Search FoamTree …carrotsearch.com/foamtree for more details."
const OLD =
  'yd.Zf("B`ssnu!Rd`sbi!Gn`lUsdd!whrt`mh{`uhno/!Busm,bmhbj!uid!mnfn!un!fn!un!iuuqr;..b`ssnurd`sbi/bnl.gn`lusdd!gns!lnsd!edu`hmr/")';
const NEW = 'yd.Zf("")';

try {
  if (!existsSync(file)) {
    console.warn("[patch-foamtree] 未找到 foamtree.js（依赖未安装？），跳过");
    process.exit(0);
  }
  const src = readFileSync(file, "utf8");
  if (!src.includes(OLD)) {
    if (src.includes(NEW)) {
      console.log("[patch-foamtree] 已打补丁，跳过");
    } else {
      console.warn("[patch-foamtree] 未匹配到硬编码 logo 字符串（版本可能变化），跳过");
    }
    process.exit(0);
  }
  writeFileSync(file, src.replace(OLD, NEW), "utf8");
  console.log("[patch-foamtree] 已移除 FoamTree 公司 logo 字符串");
} catch (e) {
  console.warn("[patch-foamtree] 补丁失败:", e.message);
  process.exit(0);
}
