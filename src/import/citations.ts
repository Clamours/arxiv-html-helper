/**
 * 识别正文里的文献引用，对应到参考文献条目（不依赖 DOM）。
 *
 * MinerU 输出的引用只是普通文字，要从文字里认出来，再按参考文献的内容配对：
 * - 数字：`[3]`、`[1, 4–6]`，只认参考文献里带 `[N]` / `N.` 编号的条目
 * - 作者-年份：`(Liu et al., 2024a)`、`(Chen et al., 2024; Zhang et al., 2025a;c)`、`Chen et al. (2026)`、
 *   `(Giorlandino & Goldt, 2026)`。第一作者的姓出现在条目开头（第一个逗号 / and 之前），年份出现在条目里；
 *   同一作者同一年有多篇时按年份后的字母（natbib 的 2024a、2024b）区分，条目里一般也印着这个字母
 *
 * 配不上任何条目的不算引用，原样作为文字。
 */

export interface CiteLink {
  start: number;
  end: number;
  /** 参考文献的下标（从 0 开始） */
  ref: number;
}

/** 一处引用：整体范围（数字引用含方括号，括号里的作者-年份引用含圆括号）和其中链接到条目的部分 */
export interface CiteSpan {
  start: number;
  end: number;
  links: CiteLink[];
}

/** 参考文献条目开头的编号："[12] …"、"12. …" */
export function bibLabel(ref: string): { label: string; rest: string } | null {
  const m = /^\[(\d{1,4})\]\s*/.exec(ref) ?? /^(\d{1,4})\.\s+(?=\p{Lu})/u.exec(ref);
  return m ? { label: m[1]!, rest: ref.slice(m[0].length) } : null;
}

/** 比较人名用：去掉变音符号（含 OCR 拆出来的 "Veliˇ ckovi´ c"）、大小写，只留字母数字，按空白分词 */
function words(s: string): string[] {
  return s
    .replace(/\s*[ˇ´`¨˜˘˙˚˛˝¸¯]\s*/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const BIB_YEAR = /(?<![\d.:/-])((?:19|20)\d{2})([a-z]?)(?![\p{L}\d]|\.\d)/gu;

interface Entry {
  /** 第一作者（条目开头到第一个逗号 / and / & 之前）的词 */
  first: Set<string>;
  /** 条目开头一段（作者列表大致在这里）的词，用来核对 "X and Y" 的第二作者 */
  head: Set<string>;
  /** 条目里出现的年份 → 年份后的字母（没有字母时为空串） */
  years: Map<string, Set<string>>;
}

export class Bibliography {
  private entries: Entry[];
  private labels = new Map<string, number>();

  constructor(refs: string[]) {
    this.entries = refs.map((raw, i) => {
      const lab = bibLabel(raw);
      if (lab && !this.labels.has(lab.label)) this.labels.set(lab.label, i);
      const text = (lab ? lab.rest : raw).replace(/<[^>]*>/g, ' ');
      const years = new Map<string, Set<string>>();
      for (const m of text.matchAll(BIB_YEAR)) {
        if (!years.has(m[1]!)) years.set(m[1]!, new Set());
        years.get(m[1]!)!.add(m[2]!);
      }
      const first = text.split(/,|;|\s(?:and|&)\s/)[0]!;
      return { first: new Set(words(first)), head: new Set(words(text.slice(0, 300))), years };
    });
  }

  get size(): number {
    return this.entries.length;
  }

  /** 作者-年份引用对应的条目；surname 是第一作者的姓，second 是 "X and Y" 里的 Y */
  lookup(surname: string, year: string, suffix: string, second?: string): number | null {
    const name = words(surname);
    if (!name.length) return null;
    let cands: number[] = [];
    this.entries.forEach((e, i) => {
      if (e.years.has(year) && name.every((w) => e.first.has(w))) cands.push(i);
    });
    if (second && cands.length > 1) {
      const w2 = words(second);
      const both = cands.filter((i) => w2.every((w) => this.entries[i]!.head.has(w)));
      if (both.length) cands = both;
    }
    if (!cands.length) return null;
    const exact = cands.find((i) => this.entries[i]!.years.get(year)!.has(suffix));
    if (exact !== undefined) return exact;
    if (!suffix) return cands[0]!;
    // 条目里没印字母：按同一作者同一年的条目在参考文献里的顺序，a 是第一篇
    if (cands.some((i) => !this.entries[i]!.years.get(year)!.has(''))) return null;
    return cands[suffix.charCodeAt(0) - 97] ?? null;
  }

  /** 数字引用 "[12]" 对应的条目 */
  numbered(label: string): number | null {
    return this.labels.get(String(Number(label))) ?? null;
  }

  /** 文字里的所有引用，按位置排列、互不重叠 */
  find(text: string): CiteSpan[] {
    const spans = [...this.findNumeric(text), ...this.findAuthorYear(text)];
    spans.sort((a, b) => a.start - b.start);
    return spans.filter((s, i) => i === 0 || s.start >= spans[i - 1]!.end);
  }

  private findNumeric(text: string): CiteSpan[] {
    if (!this.labels.size) return [];
    const out: CiteSpan[] = [];
    for (const m of text.matchAll(NUMERIC)) {
      const links: CiteLink[] = [];
      const base = m.index + m[0].indexOf(m[1]!);
      let ok = true;
      for (const part of m[1]!.matchAll(/(\d+)(?:\s*[-–—]\s*(\d+))?/g)) {
        const at = base + part.index;
        const a = this.numbered(part[1]!);
        if (a === null || (part[2] && (Number(part[2]) <= Number(part[1]) || this.numbered(part[2]) === null))) {
          ok = false;
          break;
        }
        links.push({ start: at, end: at + part[1]!.length, ref: a });
        if (part[2]) {
          const end = at + part[0].length;
          links.push({ start: end - part[2].length, end, ref: this.numbered(part[2])! });
        }
      }
      if (ok) out.push({ start: m.index, end: m.index + m[0].length, links });
    }
    return out;
  }

  private findAuthorYear(text: string): CiteSpan[] {
    // 每个 "作者, 年份" 单元单独配对
    const units: (CiteSpan & { textual: boolean })[] = [];
    for (const m of text.matchAll(AUTHOR_YEAR)) {
      const g = m.groups!;
      const ref = this.lookup(g.name!, g.year!, g.suffix ?? '', g.second);
      if (ref === null) continue;
      const start = m.index;
      const yearEnd = m.index + m[0].length - g.more!.length;
      const links: CiteLink[] = [{ start, end: yearEnd, ref }];
      // 同一作者的其他年份 / 字母："2025a;c"、"2024, 2025"
      let year = g.year!;
      for (const c of g.more!.matchAll(/(?:((?:19|20)\d{2})([a-z]?)|([a-z]))(?![\p{L}\d])/gu)) {
        if (c[1]) year = c[1];
        const r = this.lookup(g.name!, year, c[2] ?? c[3] ?? '', g.second);
        if (r !== null) links.push({ start: yearEnd + c.index, end: yearEnd + c.index + c[0].length, ref: r });
      }
      let end = m.index + m[0].length;
      // "Chen et al. (2026)"：右括号算在这处引用里
      const close = g.open ? /^\s*\)/.exec(text.slice(end)) : null;
      if (close) end += close[0].length;
      units.push({ start, end, links, textual: !!g.open });
    }
    // 括号里的引用（"(e.g., A et al., 2024; B, 2025)"）合成一处，范围包括括号
    const out: CiteSpan[] = [];
    for (let i = 0; i < units.length; ) {
      const { textual, ...u } = units[i]!;
      const open = text.lastIndexOf('(', u.start);
      const close = text.indexOf(')', u.end);
      const inParens = !textual && open >= 0 && close >= 0 && !text.slice(open + 1, u.start).includes(')') && !text.slice(u.end, close).includes('(');
      if (!inParens) {
        out.push(u);
        i++;
        continue;
      }
      const group: CiteSpan = { start: open, end: close + 1, links: [] };
      for (; i < units.length && units[i]!.end <= close; i++) group.links.push(...units[i]!.links);
      out.push(group);
    }
    return out;
  }
}

const NUMERIC = /\[\s*(\d{1,4}(?:\s*[-–—]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*)\s*\]/g;

// 姓：可带 van / de 等小写前缀；允许连字符、撇号，以及 OCR 拆开的变音符号（"Velickoviˇ c"）
const SURNAME = String.raw`(?:(?:van|von|der|den|de|da|di|del|du|le|la|dos|das|ter|ten)\s+)*\p{Lu}(?:[\p{L}\p{M}'’-]|\s?[ˇ´¨˜˘˙˚˛˝¸¯]\s?)*`;
/** "Liu et al., 2024a;c"、"Giorlandino & Goldt, 2026"、"Chen et al. (2026"（右括号由调用方处理） */
const AUTHOR_YEAR = new RegExp(
  String.raw`(?<![\p{L}\p{M}])(?<name>${SURNAME})(?:\s+et\s+al\.?|\s+(?:and|&)\s+(?<second>${SURNAME}))?` +
    String.raw`(?:,?\s+|(?<open>\s+\(\s*))(?<year>(?:19|20)\d{2})(?<suffix>[a-z])?(?![\p{L}\d])` +
    String.raw`(?<more>(?:\s*[,;]\s*(?:(?:19|20)\d{2}[a-z]?|[a-z])(?![\p{L}\d]))*)`,
  'gu',
);
