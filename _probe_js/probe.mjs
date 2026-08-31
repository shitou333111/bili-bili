import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");
const pats = [
  "currentScript",
  "publicPath",
  "\\.p=",
  "remoteEntry",
  "__webpack_require__",
  "\\.js[\"']",
  "bfs/static",
  "e.src",
  "t.src",
  ".appendChild(",
];
for (const p of pats) {
  const re = new RegExp(p, "g");
  let m, c = 0;
  const out = [];
  while ((m = re.exec(t)) && c < 8) { out.push(m[0].slice(0, 120)); c++; }
  console.log("==", p, "==");
  console.log(out.join(" | "));
}