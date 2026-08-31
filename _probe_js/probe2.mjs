import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");
console.log("TOTAL LEN", t.length);
for (const needle of ["bfs/static", ".p=", "t.src=", "currentScript"]) {
  let i = -1;
  let n = 0;
  console.log("\n###### needle:", needle);
  while ((i = t.indexOf(needle, i + 1)) >= 0 && n < 5) {
    console.log("--- offset", i, "---");
    console.log(t.slice(Math.max(0, i - 60), i + 160).replace(/\n/g, " "));
    n++;
  }
}