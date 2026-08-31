import { promises as fs } from "fs";
const p = "public/moniqi/mirror/progressive_light_2026/s1.hdslb.com/bfs/live-activity/nuwa/the_road_to_fame_template/static/js/947.c7bdd032.js";
let t = await fs.readFile(p, "utf8");
let i = t.indexOf("general/chengming");
let seg = t.slice(i - 20, i + 2200).replace(/\\n/g, " ").replace(/\s+/g, " ");
console.log(seg.slice(0, 3400));