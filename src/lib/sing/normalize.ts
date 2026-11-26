/**
 * 点歌听 · 文本归一化与相似度
 *
 * 目标：把 "(Live)""【现场版】""- Remastered 2011""feat. XXX" 之类的噪声剥掉，
 * 让「晴天」「晴天 (Live)」「晴天 - Live」落到同一个归一化结果上。
 */

/** 需要剥离的噪声词（小写、不含标点）；出现在括号外也去掉 */
const NOISE_TOKENS = [
  "live",
  "现场版",
  "现场",
  "演唱会",
  "concert",
  "纯享版",
  "纯享",
  "伴奏版",
  "伴奏",
  "remastered",
  "remaster",
  "feat",
  "ft",
  "remix",
  "dj版",
  "dj",
  "cover",
  "翻唱",
  "抖音",
  "无损",
  "高音质",
  "完整版",
  "片段",
  "副歌",
  "铃声",
  "official",
  "mv版",
  "mv",
  "高清",
  "原唱",
  "女声版",
  "男声版",
];

/** NFKC + 小写（用于包含判断、歌手匹配） */
export function fold(input: string): string {
  return (input || "").normalize("NFKC").toLowerCase();
}

/** 去括号及其内容（中英文圆括号、方括号、书名号、花括号） */
function stripBrackets(s: string): string {
  return s.replace(/[（(\[【{｛<《][^）)\]】}｝>》]*[）)\]】}｝>》]/g, " ");
}

/** 去标点与空白，只保留字母数字（含中文） */
function compact(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * 歌名归一化：NFKC → 小写 → 去括号 → 去噪声词 → 去标点空格。
 * 结果为空时回退到「仅去标点空格」的版本，避免整首歌名都是括号内容。
 */
export function normalizeTitle(input: string): string {
  if (!input) return "";
  let s = fold(input);
  s = stripBrackets(s);
  for (const token of NOISE_TOKENS) {
    if (!s.includes(token)) continue;
    s = s.split(token).join(" ");
  }
  const out = compact(s);
  if (out) return out;
  return compact(stripBrackets(fold(input)));
}

/** 歌手名归一化：去掉 feat./ft. 及其后内容、标点空格 */
export function normalizeArtist(input: string): string {
  if (!input) return "";
  let s = fold(input);
  s = s.replace(/\b(feat|ft|featuring)\.?\s.*$/u, " ");
  return compact(s);
}

/** 字二元组 */
export function bigrams(s: string): string[] {
  if (!s) return [];
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Dice 系数（0–1）；两边为空返回 0 */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const counter = new Map<string, number>();
  for (const g of A) counter.set(g, (counter.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of B) {
    const n = counter.get(g) || 0;
    if (n > 0) {
      overlap++;
      counter.set(g, n - 1);
    }
  }
  return (2 * overlap) / (A.length + B.length);
}
