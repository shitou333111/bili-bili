/**
 * 从 GetEffectConfListV2.json 中抽取所有 type=5 的全屏特效，
 * 只保留 id / web_mp4 / web_mp4_json，并按 id 从高到低排序输出到 JSON 文件。
 *
 * 用法：
 *   node scripts/extract-effect-conf.mjs <GetEffectConfListV2.json> [输出.json]
 *
 * 输出路径省略时写到当前目录的 effect-conf-type5.json。
 */

import fs from "node:fs";
import path from "node:path";

const [file, outArg] = process.argv.slice(2);
if (!file) {
  console.error("用法: node scripts/extract-effect-conf.mjs <GetEffectConfListV2.json> [输出.json]");
  process.exit(1);
}

/** 递归收集所有「同时含 type 与 id 的对象」 */
function collectItems(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && "type" in item && "id" in item) out.push(item);
      else collectItems(item, out);
    }
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectItems(v, out);
  }
  return out;
}

const items = collectItems(JSON.parse(fs.readFileSync(file, "utf8")));
const type5 = items
  .filter((it) => Number(it.type) === 5)
  .map((it) => ({
    id: Number(it.id),
    web_mp4: it.web_mp4 ?? "",
    web_mp4_json: it.web_mp4_json ?? "",
  }))
  .sort((a, b) => b.id - a.id);

const outFile = outArg || path.join(process.cwd(), "effect-conf-type5.json");
fs.writeFileSync(outFile, `${JSON.stringify(type5, null, 2)}\n`, "utf8");

console.log(`type=5 共 ${type5.length} 条，已按 id 从高到低写入：${outFile}`);
console.log(`id 范围：${type5[0]?.id ?? "-"} ~ ${type5[type5.length - 1]?.id ?? "-"}`);
