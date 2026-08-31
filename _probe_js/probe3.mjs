import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");
const needles = ["remoteEntry", ".json", "linglong", "container", "scripts", "getPublic", "external", "bfs/static"];
for (const needle of needles) {
  const hits = [];
  let i = -1;
  while ((hits.push(i), (i = t.indexOf(needle, i + 1)) >= 0)) { if (hits.length - 1 > 12) break; }
  console.log("\n== ", needle, " count", hits.length - 1);
  let j = -1, n = 0;
  while ((j = t.indexOf(needle, j + 1)) >= 0 && n < 6) {
    console.log("    ", t.slice(Math.max(0, j - 50), j + 90).replace(/\n/g, " "));
    n++;
  }
}