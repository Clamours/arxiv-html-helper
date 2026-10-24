/**
 * 把解析出的论文渲染成 arXiv（LaTeXML）风格的 DOM。
 *
 * 结构、类名、id 规则都照着 arXiv HTML 来，这样块识别、锚点和翻译插件适配器可以原样复用：
 * - 节：<section id="S5.SS1" class="ltx_subsection"><h3 class="ltx_title">…</h3>…
 * - 段落：<div id="S1.p2" class="ltx_para"><p id="S1.p2.1" class="ltx_p">…
 * - 公式：<math alttext="TeX">（MathML 由 Temml 生成）
 * - 图 / 表：<figure id="S1.F1" class="ltx_figure">…<figcaption class="ltx_caption">
 * - 参考文献：<li id="bib.bib1" class="ltx_bibitem"><span class="ltx_bibblock">
 * - 文献引用：<cite class="ltx_cite">[<a href="#bib.bib1" class="ltx_ref">1</a>]</cite>
 * - 图、表、节、公式、定理的引用：<a href="#S1.F3" class="ltx_ref">Figure 3</a>
 *
 * id 只由文档结构决定，同一份 Markdown 重新导入得到的 id 不变，已有笔记仍能定位。
 * 导入的内容不可信：只通过 DOM API 创建白名单内的元素和属性，不拼接 HTML。
 */
import temml from 'temml';
import { bibLabel, Bibliography } from './citations';
import { findRefs, refKey } from './crossrefs';
import type { Block, MinerUPaper, Panel, Section } from './mineru';

export interface RenderOptions {
  /** 改写图片地址（如换成本地缓存的 blob: / data: URL）；返回 null 表示不显示该图片 */
  resolveImage?: (src: string) => string | null;
}

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** MinerU 的 TeX 每个记号之间都有空格（`N _ { v }`），去掉下标、上标、花括号两侧的空格；`\ ` 不动 */
export function tidyTex(tex: string): string {
  return tex
    .replace(/(?<!\\)\s+(?=[_^{}])/g, '')
    .replace(/(?<=[_^{])\s+/g, '')
    .trim();
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...children);
  return e;
}

export function renderMath(doc: Document, tex: string, display: boolean): Element {
  const alttext = tidyTex(tex);
  let math: Element | null = null;
  try {
    const tpl = doc.createElement('template');
    tpl.innerHTML = temml.renderToString(alttext, { displayMode: display, throwOnError: true });
    math = tpl.content.firstElementChild;
  } catch {
    // 解析失败时仍输出一个 <math>（划线时公式要作为整体），内容是原始 TeX
  }
  if (math?.localName !== 'math') {
    math = doc.createElementNS(MATHML_NS, 'math');
    const err = doc.createElementNS(MATHML_NS, 'merror');
    const t = doc.createElementNS(MATHML_NS, 'mtext');
    t.textContent = alttext;
    err.append(t);
    math.append(err);
  }
  math.setAttribute('alttext', alttext);
  math.setAttribute('display', display ? 'block' : 'inline');
  math.classList.add('ltx_Math');
  return math;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const INLINE_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
  sup: 'sup', sub: 'sub', b: 'b', strong: 'b', i: 'i', em: 'i',
};
/** MinerU 偶尔输出的排版标签：去掉标签、保留文字（其他尖括号原样作为文本） */
const DROP_TAGS = new Set(['div', 'span', 'p', 'font', 'center', 'section', 'a', 'u', 's', 'small', 'big', 'mark', 'code', 'pre', 'details', 'summary']);
// 行内记号：\$、$公式$、标签（可带属性）、<br>
const INLINE_TOKEN = /\\\$|\$([^$]+?)\$|<(\/?)([a-z][a-z0-9]*)(?:\s+[^<>]*?)?\s*\/?>/gi;

/** 文字追加到 parent，其中的文献引用换成指向参考文献的链接（title 是条目全文，悬停可见） */
function appendCited(doc: Document, parent: Element, text: string, cite: Citations): void {
  let last = 0;
  for (const span of cite.bib.find(text)) {
    parent.append(text.slice(last, span.start));
    const c = parent.appendChild(doc.createElement('cite'));
    c.className = 'ltx_cite';
    let at = span.start;
    for (const link of span.links) {
      c.append(text.slice(at, link.start));
      const a = c.appendChild(doc.createElement('a'));
      a.className = 'ltx_ref';
      a.setAttribute('href', `#bib.bib${link.ref + 1}`);
      a.setAttribute('title', cite.titles[link.ref]!);
      a.textContent = text.slice(link.start, link.end);
      at = link.end;
    }
    c.append(text.slice(at, span.end));
    last = span.end;
  }
  parent.append(text.slice(last));
}

/** 解析行内文本（公式、<sup>/<sub> 等），追加到 parent；其他尖括号原样作为文本。给了 cite 时识别文献引用 */
export function appendInline(doc: Document, parent: Element, src: string, decode = true, cite?: Citations): void {
  const stack: Element[] = [parent];
  const top = () => stack[stack.length - 1]!;
  const text = (s: string) => {
    if (!s) return;
    if (decode) s = decodeEntities(s);
    if (cite) appendCited(doc, top(), s, cite);
    else top().append(s);
  };
  let last = 0;
  for (const m of src.matchAll(INLINE_TOKEN)) {
    text(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0] === '\\$') top().append('$');
    else if (m[1] !== undefined) top().append(renderMath(doc, m[1], false));
    else {
      const name = m[3]!.toLowerCase();
      const tag = INLINE_TAGS[name];
      if (name === 'br') top().append(doc.createElement('br'));
      else if (DROP_TAGS.has(name)) continue;
      else if (!tag) text(m[0]);
      else if (!m[2]) stack.push(top().appendChild(doc.createElement(tag)));
      else if (stack.length > 1 && top().localName === tag) stack.pop();
    }
  }
  text(src.slice(last));
}

const SPAN_ATTR = /^[1-9]\d{0,2}$/;

/** MinerU 的表格 HTML → 只保留表格结构、rowspan/colspan，<eq> 换成公式 */
function renderTable(doc: Document, html: string, cite?: Citations): HTMLTableElement {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html; // template 内容是惰性的，不会加载资源或执行脚本
  const table = el(doc, 'table', { class: 'ltx_tabular ltx_centering ltx_align_middle' });
  const copy = (from: Node, to: Element): void => {
    for (const n of Array.from(from.childNodes)) {
      // 不用全局的 Node / Element：渲染器也要能在 Node.js 里配合 jsdom 的 Document 运行
      if (n.nodeType === 3) {
        appendInline(doc, to, n.textContent ?? '', false, cite); // HTML 解析时已解码过实体
        continue;
      }
      if (n.nodeType !== 1) continue;
      const name = (n as Element).localName;
      if (name === 'eq') to.append(renderMath(doc, n.textContent ?? '', false));
      else if (name === 'tr') copy(n, to.appendChild(el(doc, 'tr', { class: 'ltx_tr' })));
      else if (name === 'td' || name === 'th') {
        const cell = el(doc, name, { class: 'ltx_td ltx_align_center' });
        for (const a of ['rowspan', 'colspan']) {
          const v = (n as Element).getAttribute(a);
          if (v && SPAN_ATTR.test(v)) cell.setAttribute(a, v);
        }
        copy(n, to.appendChild(cell));
      } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') copy(n, to.appendChild(doc.createElement(name)));
      else if (name === 'br') to.append(doc.createElement('br'));
      else if (INLINE_TAGS[name]) copy(n, to.appendChild(doc.createElement(INLINE_TAGS[name]!)));
      else if (name === 'script' || name === 'style' || name === 'template') continue;
      else copy(n, to); // table 本身和其他标签：只保留内容
    }
  };
  for (const t of tpl.content.querySelectorAll('table')) {
    if (!t.parentElement?.closest('table')) copy(t, table);
  }
  return table;
}

const SAFE_SRC = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp);base64,|blob:)/i;

function imageSrc(src: string, opts: RenderOptions): string | null {
  const s = opts.resolveImage ? opts.resolveImage(src) : src;
  if (!s) return null;
  // 相对路径（MinerU zip 包里的 images/xxx.jpg）也允许
  return SAFE_SRC.test(s) || !/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : null;
}

const THEOREM = /^((?:Theorem|Lemma|Proposition|Corollary|Definition|Assumption|Remark|Example|Claim|Conjecture)\s+[A-Z]?\d+(?:\.\d+)*(?:\s*\([^)]*\))?\.)\s*/;
const PROOF = /^(Proof(?:\s+of\s+[^.]{1,80})?\.)\s*/;

/** 生成 id，并保证同一文档内不重复（MinerU 偶尔会识别出重复的编号） */
class Ids {
  private used = new Set<string>();
  take(id: string): string {
    let out = id;
    for (let n = 2; this.used.has(out); n++) out = `${id}-${n}`;
    this.used.add(out);
    return out;
  }
}

/** "5.1" → S5.SS1，"B.3" → A2.SS3（和 LaTeXML 一致） */
function sectionId(sec: Section, unnumbered: number): string {
  if (!sec.number) return `Sx${unnumbered}`;
  const [head, ...rest] = sec.number.split('.');
  const first = /^\d/.test(head!) ? `S${head}` : `A${head!.charCodeAt(0) - 64}`;
  return [first, ...rest.map((n, i) => `${'S'.repeat(i + 2)}${n}`)].join('.');
}

const SECTION_CLASS = ['ltx_section', 'ltx_subsection', 'ltx_subsubsection'];
const SECTION_TAG = ['h2', 'h3', 'h4'] as const;

/** 参考文献和每个条目的纯文本（链接的 title） */
export interface Citations {
  bib: Bibliography;
  titles: string[];
}

function citations(refs: string[]): Citations {
  const titles = refs.map((r) =>
    (bibLabel(r)?.rest ?? r)
      .replace(/<[^>]*>|\$/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return { bib: new Bibliography(refs), titles };
}

/** 已经是链接、公式的部分不再找引用 */
const SKIP_REFS = new Set(['a', 'cite', 'math']);

class Renderer {
  private ids = new Ids();
  private unnumbered = 0;
  private cite?: Citations;
  /** 可以被引用的目标：refKey → 元素 id；编号重复时用第一个 */
  private targets = new Map<string, string>();

  constructor(
    private doc: Document,
    private opts: RenderOptions,
  ) {}

  private target(kind: string, number: string | undefined, id: string): void {
    const key = number && refKey(kind, number);
    if (key && !this.targets.has(key)) this.targets.set(key, id);
  }

  /** 正文的行内文本（识别文献引用） */
  private inline(parent: Element, text: string): void {
    appendInline(this.doc, parent, text, true, this.cite);
  }

  para(scope: string, n: number, text: string): HTMLElement {
    const doc = this.doc;
    const id = this.ids.take(`${scope}.p${n}`);
    const p = el(doc, 'p', { id: `${id}.1`, class: 'ltx_p' });
    const th = THEOREM.exec(text) ?? PROOF.exec(text);
    if (th) {
      const thm = /^(\w+)\s+([A-Z]?\d+(?:\.\d+)*)/.exec(th[1]!);
      if (thm) this.target(thm[1]!.toLowerCase(), thm[2], id);
      const font = th[0].startsWith('Proof') ? 'ltx_font_italic' : 'ltx_font_bold';
      appendInline(doc, p.appendChild(el(doc, 'span', { class: `ltx_text ${font}` })), th[1]!);
      p.append(' ');
      text = text.slice(th[0].length);
    }
    this.inline(p, text);
    return el(doc, 'div', { id, class: 'ltx_para' }, p);
  }

  caption(kind: 'figure' | 'table' | 'float', tag: string, text: string): HTMLElement {
    const cap = el(this.doc, 'figcaption', { class: 'ltx_caption ltx_centering' });
    if (tag) cap.append(el(this.doc, 'span', { class: `ltx_tag ltx_tag_${kind}` }, tag));
    this.inline(cap, text);
    return cap;
  }

  image(panel: Panel): HTMLElement | null {
    const src = imageSrc(panel.src, this.opts);
    if (!src) return null;
    const alt = panel.alt === 'image' ? '' : panel.alt;
    return el(this.doc, 'img', { src, alt, class: 'ltx_graphics ltx_centering', loading: 'lazy' });
  }

  block(scope: string, b: Block, counters: Record<string, number>): HTMLElement {
    const doc = this.doc;
    const next = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);
    switch (b.kind) {
      case 'para':
        return this.para(scope, next('p'), b.text);
      case 'equation': {
        const id = this.ids.take(b.tag ? `${scope}.E${b.tag.replace(/[^\w.]/g, '')}` : `${scope}.Ex${next('Ex')}`);
        this.target('equation', b.tag, id);
        const row = el(
          doc,
          'tr',
          { class: 'ltx_equation ltx_eqn_row ltx_align_baseline' },
          el(doc, 'td', { class: 'ltx_eqn_cell ltx_eqn_center_padleft' }),
          el(doc, 'td', { class: 'ltx_eqn_cell ltx_align_center' }, renderMath(doc, b.tex, true)),
          el(doc, 'td', { class: 'ltx_eqn_cell ltx_eqn_center_padright' }),
        );
        if (b.tag) {
          const tag = el(doc, 'span', { class: 'ltx_tag ltx_tag_equation ltx_align_right' }, `(${b.tag})`);
          row.append(el(doc, 'td', { class: 'ltx_eqn_cell ltx_eqn_eqno ltx_align_middle ltx_align_right' }, tag));
        }
        return el(doc, 'table', { id, class: 'ltx_equation ltx_eqn_table' }, el(doc, 'tbody', {}, row));
      }
      case 'figure': {
        const id = this.ids.take(b.number ? `${scope}.F${b.number}` : `${scope}.Fx${next('Fx')}`);
        this.target('figure', b.number, id);
        const fig = el(doc, 'figure', { id, class: 'ltx_figure' });
        const single = b.panels.length === 1 && !b.panels[0]!.caption;
        if (!b.panels.length) {
          // 只有图注：MinerU 没有把这张图识别成图片
          fig.append(el(doc, 'div', { class: 'ltx_figure_missing notranslate', translate: 'no' }, 'MinerU 没有从 PDF 中识别出这张图'));
        } else if (single) {
          const img = this.image(b.panels[0]!);
          if (img) fig.append(img);
        } else {
          const flex = fig.appendChild(el(doc, 'div', { class: 'ltx_flex_figure' }));
          b.panels.forEach((p, i) => {
            const panel = el(doc, 'figure', { id: this.ids.take(`${id}.sf${i + 1}`), class: 'ltx_figure ltx_figure_panel' });
            if (b.number && p.label) this.target('figure', `${b.number}(${p.label})`, panel.id);
            const img = this.image(p);
            if (img) panel.append(img);
            if (p.caption !== undefined) panel.append(this.caption('figure', `(${p.label}) `, p.caption));
            flex.append(el(doc, 'div', { class: 'ltx_flex_cell' }, panel));
          });
        }
        if (b.caption !== undefined) fig.append(this.caption('figure', b.tag ?? '', b.caption));
        return fig;
      }
      case 'algorithm': {
        const id = this.ids.take(b.number ? `${scope}.alg${b.number}` : `${scope}.algx${next('algx')}`);
        this.target('algorithm', b.number, id);
        const fig = el(doc, 'figure', { id, class: 'ltx_float ltx_algorithm' });
        if (b.caption !== undefined) fig.append(this.caption('float', b.tag ?? '', b.caption));
        const listing = fig.appendChild(el(doc, 'div', { class: 'ltx_listing' }));
        b.lines.forEach((line, i) => {
          const p = el(doc, 'p', { id: this.ids.take(`${id}.l${i + 1}`), class: 'ltx_p ltx_listingline' });
          if (line.label) p.append(el(doc, 'span', { class: 'ltx_tag ltx_tag_listingline' }, `${line.label} `));
          this.inline(p, line.text);
          listing.append(p);
        });
        return fig;
      }
      case 'table': {
        const id = this.ids.take(b.number ? `${scope}.T${b.number}` : `${scope}.Tx${next('Tx')}`);
        this.target('table', b.number, id);
        const fig = el(doc, 'figure', { id, class: 'ltx_table' });
        if (b.caption !== undefined) fig.append(this.caption('table', b.tag ?? '', b.caption));
        fig.append(el(doc, 'div', { class: 'ltx_inline-block ltx_transformed_outer' }, renderTable(doc, b.html, this.cite)));
        return fig;
      }
    }
  }

  section(sec: Section): HTMLElement {
    const doc = this.doc;
    const lvl = Math.min(sec.level, 3) - 1;
    const id = this.ids.take(sectionId(sec, sec.number ? 0 : ++this.unnumbered));
    this.target('section', sec.number, id);
    const kind = sec.appendix && lvl === 0 ? 'ltx_appendix' : SECTION_CLASS[lvl]!;
    const h = el(doc, SECTION_TAG[lvl]!, { class: `ltx_title ltx_title_${kind.slice(4)}` });
    if (sec.number) h.append(el(doc, 'span', { class: `ltx_tag ltx_tag_${kind.slice(4)}` }, `${sec.number} `));
    appendInline(doc, h, sec.title);
    const out = el(doc, 'section', { id, class: kind }, h);
    const counters: Record<string, number> = {};
    for (const b of sec.blocks) out.append(this.block(id, b, counters));
    for (const c of sec.children) out.append(this.section(c));
    return out;
  }

  article(paper: MinerUPaper): HTMLElement {
    const doc = this.doc;
    if (paper.references.length) this.cite = citations(paper.references);
    const art = el(doc, 'article', { class: 'ltx_document ltx_authors_1line' });
    const title = el(doc, 'h1', { class: 'ltx_title ltx_title_document' });
    appendInline(doc, title, paper.title || 'Untitled');
    art.append(title);

    if (paper.frontMatter.length) {
      const name = el(doc, 'span', { class: 'ltx_personname' });
      paper.frontMatter.forEach((line, i) => {
        if (i) name.append(doc.createElement('br'));
        appendInline(doc, name, line);
      });
      art.append(el(doc, 'div', { class: 'ltx_authors' }, el(doc, 'span', { class: 'ltx_creator ltx_role_author' }, name)));
    }

    if (paper.abstract.length) {
      const abs = el(doc, 'div', { class: 'ltx_abstract' }, el(doc, 'h6', { class: 'ltx_title ltx_title_abstract' }, 'Abstract'));
      paper.abstract.forEach((t, i) => {
        const p = el(doc, 'p', { id: this.ids.take(`abs.p${i + 1}`), class: 'ltx_p' });
        this.inline(p, t);
        abs.append(p);
      });
      art.append(abs);
    }

    paper.sections.forEach((s, i) => {
      if (i === paper.referencesAt && paper.references.length) art.append(this.bibliography(paper.references));
      art.append(this.section(s));
    });
    if (paper.referencesAt >= paper.sections.length && paper.references.length) art.append(this.bibliography(paper.references));
    // 正文常常引用后面才出现的图表，所以全部渲染完再加链接
    this.linkRefs(art);
    return art;
  }

  /** 正文、图注、表格里对图、表、节、公式、定理的引用换成链接（不链接到引用所在的元素自身） */
  private linkRefs(root: Element): void {
    if (!this.targets.size) return;
    const texts = new Set<Text>();
    const collect = (n: Node): void => {
      for (const c of Array.from(n.childNodes)) {
        if (c.nodeType === 3) texts.add(c as Text);
        else if (c.nodeType === 1 && !SKIP_REFS.has((c as Element).localName) && !(c as Element).classList.contains('ltx_tag')) collect(c);
      }
    };
    for (const e of root.querySelectorAll('.ltx_p, figcaption, td, th')) collect(e);
    for (const t of texts) {
      const inside = (id: string) => {
        for (let e = t.parentElement; e; e = e.parentElement) if (e.id === id) return true;
        return false;
      };
      const spans = findRefs(t.data, (k) => this.targets.has(k)).filter((r) => !inside(this.targets.get(r.key)!));
      if (!spans.length) continue;
      const parts: (Node | string)[] = [];
      let last = 0;
      for (const r of spans) {
        parts.push(t.data.slice(last, r.start));
        parts.push(el(this.doc, 'a', { href: `#${this.targets.get(r.key)!}`, class: 'ltx_ref' }, t.data.slice(r.start, r.end)));
        last = r.end;
      }
      parts.push(t.data.slice(last));
      t.replaceWith(...parts.filter((p) => p !== ''));
    }
  }

  bibliography(refs: string[]): HTMLElement {
    const doc = this.doc;
    const list = el(doc, 'ul', { class: 'ltx_biblist' });
    refs.forEach((r, i) => {
      const id = this.ids.take(`bib.bib${i + 1}`);
      const block = el(doc, 'span', { class: 'ltx_bibblock' });
      const m = /^\[(\d+)\]\s*/.exec(r);
      const li = el(doc, 'li', { id, class: 'ltx_bibitem' });
      if (m) li.append(el(doc, 'span', { class: 'ltx_tag ltx_tag_bibitem' }, `[${m[1]}] `));
      appendInline(doc, block, m ? r.slice(m[0].length) : r);
      li.append(block);
      list.append(li);
    });
    const h = el(doc, 'h2', { class: 'ltx_title ltx_title_bibliography' }, 'References');
    return el(doc, 'section', { id: 'bib', class: 'ltx_bibliography' }, h, list);
  }
}

export function renderArticle(doc: Document, paper: MinerUPaper, opts: RenderOptions = {}): HTMLElement {
  return new Renderer(doc, opts).article(paper);
}
