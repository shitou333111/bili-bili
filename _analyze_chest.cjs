const fs = require('fs');
const s = fs.readFileSync('_js_research/ling/linglong/948.3618c8ac.js', 'utf8');

// 1) chest area render loop: find where chests are iterated producing `chest_` refs
let re = /chests\b[\s\S]{0,40}\.map\(/g;
let m;
while ((m = re.exec(s)) !== null) {
  console.log('--- chests.map @' + m.index + ' ---');
  console.log(s.slice(m.index - 120, m.index + 900).replace(/\n/g, ' '));
  console.log('');
}

// 2) playOpenAnimation source (ChestItem component)
const p = s.indexOf('playOpenAnimation');
console.log('===== playOpenAnimation first =====');
console.log(s.slice(p - 300, p + 1600).replace(/\n/g, ' '));