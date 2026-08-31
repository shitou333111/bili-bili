import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");
// find all quoted .js occurrences with context (chunk map)
let i = -1, n = 0;
const seen = new Set();
while ((i = t.indexOf(".js", i + 1)) >= 0 && n < 80) {
  const start = Math.max(0, i - 30);
  const frag = t.slice(start, i + 4);
  if (!/["']$/.test(frag.slice(0, 1))) { continue; }
  const m = frag.match(/([A-Za-z0-9._\-\[\]()]+\.js)$/);
  if (!m) continue;
  const name = m[1];
  if (seen.has(name)) continue;
  seen.add(name);
  console.log(name, "  << ", t.slice(Math.max(0, i - 40), i + 3).replace(/\n/g, ""));
  n++;
}
console.log("TOTAL unique .js refs:", seen.size);