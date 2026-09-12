// 直接加载真实的 src/lib/md5.ts（剥离类型注解后 eval），避免手抄误差
import fs from "node:fs";
import crypto from "node:crypto";

let src = fs.readFileSync("src/lib/md5.ts", "utf8");
src = src.replace(/^export /gm, "");
src = src.replace(/:\s*(string|number|boolean)(\[\])?/g, "");
const realMd5 = new Function(src + "\nreturn md5;")();

const md5node = (s) => crypto.createHash("md5").update(s).digest("hex");
for (const s of ["abc", "", "hello world", "The quick brown fox jumps over the lazy dog", "need_guard=true&roomid=12231251&web_location=444.8&wts=1789128383ea1db124af3c7062474693fa704f4ff8"]) {
  const a = realMd5(s);
  const n = md5node(s);
  console.log(`"${s.slice(0, 40)}"\n  real file md5 = ${a}\n  standard md5  = ${n}\n  ${a === n ? "一致 ✅" : "不一致 ❌"}`);
}
