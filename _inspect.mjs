const r = await fetch("http://localhost:3000/moniqi/mirror/progressive_light_2026/mock-shim.js");
const t = await r.text();
console.log("STATUS", r.status, "LEN", t.length);
console.log("has kv interception:", t.includes("kv-frontend"));
// line 1439 context
const lines = t.split("\n");
console.log("1439:", lines[1438]);
console.log("1441:", lines[1440]);
console.log("1446:", lines[1445]);