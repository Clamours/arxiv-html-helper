/**
 * 识别正文里对图、表、节、公式、算法、定理的引用（不依赖 DOM）。
 *
 * "Figure 3"、"Figs. 2 and 4"、"Figure 9(b)"、"Table 1–3"、"Section 4.1"、"§3"、"Appendix B"、
 * "Eq. (2)"、"Algorithm 1"、"Theorems 1 and 2"。编号要在文档里存在（由调用方判断），否则不算引用。
 */

export interface RefSpan {
  start: number;
  end: number;
  /** 引用目标，形如 "figure:3"、"figure:9(b)"、"section:B.2"、"lemma:1"；同 refKey */
  key: string;
}

const THEOREMS = ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'assumption', 'remark', 'example', 'claim', 'conjecture'];

/** 关键词 → 目标的种类 */
function kindOf(word: string): string | null {
  const w = word.toLowerCase().replace(/[.~\s]/g, '');
  if (/^fig(ure)?s?$/.test(w)) return 'figure';
  if (/^tab(le)?s?$/.test(w)) return 'table';
  if (/^(sec(tion)?s?|§§?|app(endix|endices)?)$/.test(w)) return 'section';
  if (/^eq(uation)?s?$/.test(w)) return 'equation';
  if (/^alg(orithm)?s?$/.test(w)) return 'algorithm';
  const t = w.replace(/s$/, '');
  return THEOREMS.includes(t) ? t : null;
}

/** 目标的键：种类 + 编号 */
export function refKey(kind: string, number: string): string {
  return `${kind}:${number.replace(/\s+/g, '')}`;
}

const KEYWORD = new RegExp(
  String.raw`(?<![\p{L}\d])(?:Fig(?:ure)?s?\.?|Tab(?:le)?s?\.?|Sec(?:tion)?s?\.?|§§?|App(?:endix|endices|\.)|Eq(?:uation)?s?\.?|Alg(?:orithm)?s?\.?|` +
    String.raw`(?:${THEOREMS.join('|')})s?)\s*~?\s*`,
  'giu',
);
// 编号："3"、"4.1"、"A.2"、"B"（单个大写字母只用于附录）；公式编号可以带括号、带字母后缀 "(2a)"
const NUM = String.raw`(?:[A-Z]\.?)?\d+(?:\.\d+)*|[A-Z](?:\.\d+)*`;
const REF = new RegExp(String.raw`(?:\(\s*(?<pn>${NUM}[a-z]?)\s*\)|(?<n>${NUM})(?<sub>\([a-z]\))?)(?![\p{L}\d])`, 'uy');
const SEP = /(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|&)\s+|\s*[–—-]\s*|\s+to\s+)/y;

/** 文字里的所有引用；exists 判断目标在文档里是否存在 */
export function findRefs(text: string, exists: (key: string) => boolean): RefSpan[] {
  const out: RefSpan[] = [];
  for (const m of text.matchAll(KEYWORD)) {
    const kind = kindOf(m[0]);
    if (!kind) continue;
    // 复数（"Figures 3 and 4"、"Tables 1–3"、"§§2–3"）才往后接着认编号，免得 "Table 2, 3 methods" 认错
    const plural = /(s|§§)\.?[\s~]*$/i.test(m[0]);
    let at = m.index + m[0].length;
    for (let first = true; ; first = false) {
      REF.lastIndex = at;
      const r = REF.exec(text);
      if (!r) break;
      const num = r.groups!.pn ?? r.groups!.n!;
      // 只有公式编号写在括号里；只有附录的编号是单个字母
      if ((r.groups!.pn !== undefined && kind !== 'equation') || (kind !== 'section' && /^[A-Z](?:\.\d+)*$/.test(num))) break;
      const start = first ? m.index : r.index;
      const sub = kind === 'figure' && r.groups!.sub ? refKey(kind, num + r.groups!.sub) : null;
      if (sub && exists(sub)) out.push({ start, end: REF.lastIndex, key: sub });
      else if (exists(refKey(kind, num))) out.push({ start, end: REF.lastIndex - (r.groups!.sub?.length ?? 0), key: refKey(kind, num) });
      at = REF.lastIndex;
      if (!plural) break;
      SEP.lastIndex = at;
      if (!SEP.exec(text)) break;
      at = SEP.lastIndex;
    }
  }
  return out;
}
