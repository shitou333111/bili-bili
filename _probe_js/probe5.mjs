import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const t = fs.readFileSync(path.join(__dirname, "index.9f43fcd4.js"), "utf8");

// JS chunk name (label) map: {366:"frame-gear",705:"activity-total"}
const labelRe = /"static\/js\/"\+\(\{([^}]*)\}\[\w\]\|/i;
const labelM = t.match(labelRe);
console.log("LABEL:", labelM ? labelM[1] : "NO");

// JS chunk hash map: {89:"e05e9410",...}
const jsHashRe = /\.\+\{([^}]*)\}\[\w\]\+"\.js"/i;
const hM = t.match(jsHashRe);
console.log("JSHASH:", hM ? hM[1] : "NO");

// CSS hash map inside miniCssF
const cssHashRe = /miniCssF=function\([^)]*\)\{[^}]*\.\+\{([^}]*)\}\[[^\]]*\]\+"\.css"/i;
const cM = t.match(cssHashRe);
console.log("CSSHASH:", cM ? cM[1] : "NO");

// CSS name label expression e.g. (705===e?"activity-total":e)
const cssLabelRe = /static\/css\/"\+\((\d+)===\w\?"([a-z0-9-]+)":\w\)/i;
const clM = t.match(cssLabelRe);
console.log("CSSLABEL:", clM ? clM[0] : "NO");