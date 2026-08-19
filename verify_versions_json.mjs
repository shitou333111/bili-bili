// 临时验证脚本：精确移植修正后的 deploy.yml versions.json 生成逻辑（version 对象独立构建避免尾逗号）
const W_VER = "1.3.4", A_VER = "1.3.3", I_VER = "1.3.4";
const W_DATE = "2026-08-19", A_DATE = "2026-08-18", I_DATE = "2026-08-19";

// --- version 对象独立构建（4 空格缩进，无尾逗号） ---
let VER_OBJ = "";
let VSEP = "";
const addVerP = (k, v) => {
  if (!v) return;
  VER_OBJ += VSEP + '    "' + k + '": "' + v + '"';
  VSEP = ",\\n";
};
addVerP("windows", W_VER);
addVerP("android", A_VER);
addVerP("ios", I_VER);

let VJSON = "{\\n";
VJSON += '  "version": {\\n';
if (VER_OBJ) VJSON += VER_OBJ + "\\n";
VJSON += "  }\\n";
VSEP = ",\\n";
const addVer = (k, v) => {
  if (!v) return;
  VJSON += VSEP + '  "' + k + '": "' + v + '"';
  VSEP = ",\\n";
};
addVer("windows", W_DATE);
addVer("android", A_DATE);
addVer("ios", I_DATE);
VJSON += VSEP + '  "downloads": {\\n';
VSEP = "";
const addDl = (k, l) => {
  if (!l) return;
  VJSON += VSEP + '    "' + k + '": "/artifacts/' + l + '"';
  VSEP = ",\\n";
};
addDl("windows", "current_exe");
addDl("android", "current_apk");
addDl("ios", "current_ipa");
VJSON += "\\n  }\\n";
VJSON += "}\\n";

const out = VJSON.replace(/\\n/g, "\n");
console.log(out);
try {
  const j = JSON.parse(out);
  console.log("--- VALID JSON ---");
  console.log("version.android =", j.version.android);
  console.log("android date =", j.android);
  console.log("downloads.android =", j.downloads.android);
} catch (e) {
  console.log("--- INVALID JSON:", e.message);
}

// 场景2：Android 未构建（A_VER/A_DATE 为空）
console.log("\n===== 场景2：Android 未构建 =====");
const W_VER2 = "1.3.4", A_VER2 = "", I_VER2 = "1.3.4";
const W_DATE2 = "2026-08-19", A_DATE2 = "", I_DATE2 = "2026-08-19";
let VO2 = "";
let S2 = "";
const avp2 = (k, v) => {
  if (!v) return;
  VO2 += S2 + '    "' + k + '": "' + v + '"';
  S2 = ",\\n";
};
avp2("windows", W_VER2);
avp2("android", A_VER2);
avp2("ios", I_VER2);
let V2 = "{\\n";
V2 += '  "version": {\\n';
if (VO2) V2 += VO2 + "\\n";
V2 += "  }\\n";
S2 = ",\\n";
const av2 = (k, v) => {
  if (!v) return;
  V2 += S2 + '  "' + k + '": "' + v + '"';
  S2 = ",\\n";
};
av2("windows", W_DATE2);
av2("android", A_DATE2);
av2("ios", I_DATE2);
V2 += S2 + '  "downloads": {\\n';
S2 = "";
const ad2 = (k, l) => {
  if (!l) return;
  V2 += S2 + '    "' + k + '": "/artifacts/' + l + '"';
  S2 = ",\\n";
};
ad2("windows", "current_exe");
ad2("android", "current_apk");
ad2("ios", "current_ipa");
V2 += "\\n  }\\n";
V2 += "}\\n";
const out2 = V2.replace(/\\n/g, "\n");
console.log(out2);
try {
  const j = JSON.parse(out2);
  console.log("--- VALID JSON (scenario2) ---");
  console.log("version keys:", Object.keys(j.version), "| version.android =", j.version.android);
} catch (e) {
  console.log("--- INVALID JSON (scenario2):", e.message);
}
