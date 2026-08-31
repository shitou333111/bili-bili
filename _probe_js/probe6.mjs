import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");

const hexMapRe = /\{(\d+:"[a-f0-9]+"(?:,\d+:"[a-f0-9]+")*)\}/g;
let m, i = 0;
while ((m = hexMapRe.exec(t))) {
  const entries = m[1].split(",").length;
  console.log("map", i++, "entries=", entries, ":", m[1].slice(0, 120));
}
const labelRe = /"static\/js\/"\+\(\{([^}]*)\}\[\w\]\|/i;
const lm = t.match(labelRe);
const labels = lm ? lm[1].split(",").map((s) => s.trim()) : [];
console.log("LABEL entries:", labels.length, labels.join(" "));