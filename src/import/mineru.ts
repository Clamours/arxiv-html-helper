/**
 * 解析 MinerU 导出的 Markdown，得到论文的结构（不依赖 DOM）。
 *
 * MinerU 的 Markdown 已经做好了阅读顺序、跨页合并和断字处理，但结构信息很少：
 * - 除了论文标题，所有标题都是 `##`，层级只能从编号推断（"5.1" → 小节，"B.3" → 附录小节）
 * - 图注、子图注、表注都是普通段落，要按 "Figure 1:"、"(a) …"、"Table 1:" 和相邻的图片 / 表格配对
 * - 行内公式 `$…$`、行间公式 `$$…$$`（编号写成 `\tag{1}`），表格是 HTML，单元格里的公式用 `<eq>` 包着
 *
 * 行内文本（段落、图注、参考文献）保留原样，由渲染器负责解析其中的公式和 <sup>/<sub>。
 */

export interface Panel {
  src: string;
  alt: string;
  /** 子图标签，如 "a"；没有子图注时为空 */
  label?: string;
  caption?: string;
}

export type Block =
  | { kind: 'para'; text: string }
  | { kind: 'equation'; tex: string; tag?: string }
  | { kind: 'figure'; panels: Panel[]; number?: string; tag?: string; caption?: string }
  | { kind: 'table'; html: string; number?: string; tag?: string; caption?: string }
  | { kind: 'algorithm'; number?: string; tag?: string; caption?: string; lines: AlgorithmLine[] };

/** 伪代码的一行；label 是行号（"3:"），没有行号的行为空 */
export interface AlgorithmLine {
  label?: string;
  text: string;
}

export interface Section {
  title: string;
  /** "1"、"5.1"、"B.3"；无编号的节（如 "AI Use Statement"）为空 */
  number?: string;
  /** 1 = section，2 = subsection，3 = subsubsection */
  level: number;
  appendix: boolean;
  blocks: Block[];
  children: Section[];
}

export interface MinerUPaper {
  title: string;
  /** 标题和摘要之间的段落（作者、单位等） */
  frontMatter: string[];
  abstract: string[];
  sections: Section[];
  references: string[];
  /** 参考文献在原文中的位置：排在 sections[referencesAt] 之前 */
  referencesAt: number;
}

type Raw =
  | { t: 'heading'; hashes: number; text: string }
  | { t: 'para'; text: string }
  | { t: 'math'; tex: string }
  | { t: 'image'; src: string; alt: string }
  | { t: 'table'; html: string }
  | { t: 'algorithm'; body: string };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const IMAGE = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)$/;

/** 按行切成原始块：标题、段落、行间公式、图片、表格 */
function tokenize(md: string): Raw[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Raw[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'para', text: para.join(' ').trim() });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      out.push({ t: 'heading', hashes: h[1]!.length, text: h[2]! });
      continue;
    }
    const img = IMAGE.exec(line);
    if (img) {
      flush();
      out.push({ t: 'image', alt: img[1]!, src: img[2]! });
      continue;
    }
    if (line.startsWith('$$')) {
      flush();
      // 单行 $$…$$，或者跨多行直到下一个 $$
      let body = line.slice(2);
      let end = body.indexOf('$$');
      while (end < 0 && i + 1 < lines.length) {
        body += '\n' + lines[++i]!;
        end = body.indexOf('$$');
      }
      out.push({ t: 'math', tex: (end < 0 ? body : body.slice(0, end)).trim() });
      continue;
    }
    // MinerU 把算法（伪代码）输出成 <div class="mineru-algorithm" style="white-space: pre-wrap; …">…</div>
    if (/^<div\b[^>]*\bmineru-algorithm\b/i.test(line)) {
      flush();
      let html = line;
      while (!/<\/div>/i.test(html) && i + 1 < lines.length) html += '\n' + lines[++i]!;
      out.push({ t: 'algorithm', body: html.replace(/^<div\b[^>]*>/i, '').replace(/<\/div>[\s\S]*$/i, '') });
      continue;
    }
    if (/^<table[\s>]/i.test(line)) {
      flush();
      let html = line;
      while (!/<\/table>/i.test(html) && i + 1 < lines.length) html += '\n' + lines[++i]!;
      out.push({ t: 'table', html });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

const FIG_CAPTION = /^(?:Figure|Fig\.?)\s*([A-Z]?\.?\d+)\s*[:.|]\s*|^图\s*([A-Z]?\.?\d+)\s*[:：.]?\s*/i;
const TAB_CAPTION = /^Table\s*([A-Z]?\.?\d+)\s*[:.|]\s*|^表\s*([A-Z]?\.?\d+)\s*[:：.]?\s*/i;
const SUB_CAPTION = /^\(([a-z]|[ivx]{1,4})\)\s*/;

/** 图注 / 表注：编号、原文的前缀（"Figure 1: "、"图 1 "），以及正文 */
function matchCaption(raw: Raw | undefined, re: RegExp): { number: string; tag: string; caption: string } | null {
  if (raw?.t !== 'para') return null;
  const m = re.exec(raw.text);
  return m ? { number: (m[1] ?? m[2])!, tag: m[0], caption: raw.text.slice(m[0].length) } : null;
}

const ALG_CAPTION = /^Algorithm\s+([A-Z]?\d+(?:\.\d+)*)\s*[:.]?\s*/i;

/**
 * 伪代码块：开头的 "Algorithm 1: 标题" 作为标题，其余按行号 "1: … 2: …" 分行。
 * 按连续的行号切分，而不是按换行：MinerU 输出里的换行不总是可靠，有时整段在一行里。
 * 行号只在公式（$…$）之外匹配
 */
export function parseAlgorithm(body: string): Extract<Block, { kind: 'algorithm' }> {
  let text = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  const out: Extract<Block, { kind: 'algorithm' }> = { kind: 'algorithm', lines: [] };
  const cap = ALG_CAPTION.exec(text);
  if (cap) {
    out.number = cap[1]!;
    out.tag = cap[0];
    text = text.slice(cap[0].length);
  }
  const masked = text.replace(/\$[^$]*\$/g, (m) => ' '.repeat(m.length));
  const starts: number[] = [];
  for (let k = 1, from = 0; ; k++) {
    const re = new RegExp(String.raw`(^|\s)${k}:(?=\s|$)`, 'g');
    re.lastIndex = from;
    const m = re.exec(masked);
    if (!m) break;
    const at = m.index + m[1]!.length;
    starts.push(at);
    from = at + String(k).length + 1;
  }
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (starts.length) {
    const head = text.slice(0, starts[0]);
    if (cap) out.caption = oneLine(head);
    else if (oneLine(head)) out.lines.push({ text: oneLine(head) });
    starts.forEach((at, i) => {
      const seg = text.slice(at, starts[i + 1] ?? text.length);
      const label = `${i + 1}:`;
      out.lines.push({ label, text: oneLine(seg.slice(label.length)) });
    });
  } else {
    const rows = text.split('\n');
    if (cap) out.caption = oneLine(rows.shift() ?? '');
    out.lines.push(...rows.map((r) => ({ text: oneLine(r) })).filter((l) => l.text));
  }
  return out;
}

/** `\tag{1}` 拿出来作为编号，和 LaTeXML 一样放在公式旁边单独一格 */
function splitTag(tex: string): { tex: string; tag?: string } {
  let tag: string | undefined;
  const rest = tex.replace(/\\tag\*?\s*\{([^{}]*)\}/g, (_, t: string) => ((tag = t.trim()), ''));
  return { tex: rest.trim(), tag };
}

/** 把原始块组装成图、表、公式、段落 */
function group(raws: Raw[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i]!;
    switch (r.t) {
      case 'heading':
        break; // 调用方已按标题切分
      case 'para':
        out.push({ kind: 'para', text: r.text });
        break;
      case 'math':
        out.push({ kind: 'equation', ...splitTag(r.tex) });
        break;
      case 'algorithm':
        out.push(parseAlgorithm(r.body));
        break;
      case 'table': {
        // 表注一般在表格上方；上方没有时再看下方
        const prev = out[out.length - 1];
        const above = prev?.kind === 'para' ? matchCaption({ t: 'para', text: prev.text }, TAB_CAPTION) : null;
        const below = above ? null : matchCaption(raws[i + 1], TAB_CAPTION);
        if (above) out.pop();
        if (below) i++;
        out.push({ kind: 'table', html: r.html, ...(above ?? below) });
        break;
      }
      case 'image': {
        // 连续的图片（每张后面可能跟着 "(a) …" 子图注）组成一个图，遇到 "Figure N:" 为止
        const panels: Panel[] = [];
        let j = i;
        while (raws[j]?.t === 'image') {
          const img = raws[j] as Extract<Raw, { t: 'image' }>;
          const panel: Panel = { src: img.src, alt: img.alt };
          const next = raws[j + 1];
          const sub = next?.t === 'para' ? SUB_CAPTION.exec(next.text) : null;
          if (sub) {
            panel.label = sub[1]!;
            panel.caption = (next as { text: string }).text.slice(sub[0].length);
            j++;
          }
          panels.push(panel);
          j++;
        }
        let cap = matchCaption(raws[j], FIG_CAPTION);
        if (cap) j++;
        else {
          // 图注在图片上方的情况
          const prev = out[out.length - 1];
          cap = prev?.kind === 'para' ? matchCaption({ t: 'para', text: prev.text }, FIG_CAPTION) : null;
          if (cap) out.pop();
        }
        out.push({ kind: 'figure', panels, ...cap });
        i = j - 1;
        break;
      }
    }
  }
  // 找不到图片的图注：MinerU 没把这张图识别成图片（比如把矢量图里的文字当成了正文）。
  // 仍然作为图（只有图注）显示，不混在正文段落里
  return out.map((b) => {
    const cap = b.kind === 'para' ? matchCaption({ t: 'para', text: b.text }, FIG_CAPTION) : null;
    return cap ? { kind: 'figure', panels: [], ...cap } : b;
  });
}

const ABSTRACT = /^(abstract|摘\s*要)$/i;
const REFERENCES = /^(references|bibliography|参考文献)$/i;
const APPENDIX = /^(appendix|appendices|附录)$/i;
/** 内联在段落开头的摘要，如 IEEE 模板的 "Abstract—…" */
const INLINE_ABSTRACT = /^(?:abstract|摘\s*要)\s*[-—–.:：]\s*/i;
const SECTION_NUMBER = /^((?:\d{1,2}|[A-Z])(?:\.\d{1,2})*)\.?\s+(\S.*)$/;

function parseHeading(text: string, lettersAllowed: boolean): { number?: string; title: string; level: number } {
  const m = SECTION_NUMBER.exec(text);
  // 单个字母开头（"A NOTATION"）只在参考文献 / 附录之后才视为附录编号
  if (m && (/^\d/.test(m[1]!) || lettersAllowed || m[1]!.includes('.'))) {
    return { number: m[1]!, title: m[2]!, level: Math.min(3, m[1]!.split('.').length) };
  }
  return { title: text, level: 1 };
}

export function parseMinerUMarkdown(md: string): MinerUPaper {
  const raws = tokenize(md);
  const paper: MinerUPaper = { title: '', frontMatter: [], abstract: [], sections: [], references: [], referencesAt: 0 };

  // 按标题切分
  const chunks: { heading: Extract<Raw, { t: 'heading' }> | null; body: Raw[] }[] = [{ heading: null, body: [] }];
  for (const r of raws) {
    if (r.t === 'heading') chunks.push({ heading: r, body: [] });
    else chunks[chunks.length - 1]!.body.push(r);
  }

  // 第一个标题是论文标题；它之前的内容（极少见）并入前置部分
  const first = chunks.findIndex((c) => c.heading);
  const preamble = chunks.slice(0, first < 0 ? chunks.length : first + 1).flatMap((c) => c.body);
  if (first >= 0) paper.title = chunks[first]!.heading!.text;
  for (const r of preamble) {
    if (r.t !== 'para') continue;
    const m = INLINE_ABSTRACT.exec(r.text);
    if (m || paper.abstract.length) paper.abstract.push(m ? r.text.slice(m[0].length) : r.text);
    else paper.frontMatter.push(r.text);
  }

  let lettersAllowed = false;
  const stack: Section[] = [];
  for (const { heading, body } of first < 0 ? [] : chunks.slice(first + 1)) {
    const text = heading!.text;
    if (ABSTRACT.test(text)) {
      paper.abstract.push(...body.filter((r) => r.t === 'para').map((r) => (r as { text: string }).text));
      continue;
    }
    if (REFERENCES.test(text)) {
      if (!paper.references.length) paper.referencesAt = paper.sections.length;
      stack.length = 0;
      paper.references.push(...body.filter((r) => r.t === 'para').map((r) => (r as { text: string }).text));
      lettersAllowed = true;
      continue;
    }
    if (APPENDIX.test(text)) lettersAllowed = true;

    const h = parseHeading(text, lettersAllowed);
    const sec: Section = {
      ...h,
      appendix: !!h.number && /^[A-Z]/.test(h.number),
      blocks: group(body),
      children: [],
    };
    while (stack.length && stack[stack.length - 1]!.level >= sec.level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(sec);
    else paper.sections.push(sec);
    stack.push(sec);
  }
  return paper;
}

/** 全部正文块（含各级子节），按文档顺序 */
export function allBlocks(paper: MinerUPaper): Block[] {
  const walk = (s: Section): Block[] => [...s.blocks, ...s.children.flatMap(walk)];
  return paper.sections.flatMap(walk);
}
