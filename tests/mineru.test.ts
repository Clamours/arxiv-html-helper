/**
 * MinerU Markdown 导入。真实论文的往返测试（文件不入库）：
 *   MINERU_MD=/path/to/MinerU_markdown_xxx.md npm test
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { anchorSegment, describeRange } from '../src/core/anchor';
import { extractAbstract, extractMeta } from '../src/core/paper';
import { renderArticle, tidyTex } from '../src/import/latexml';
import { allBlocks, parseAlgorithm, parseMinerUMarkdown } from '../src/import/mineru';
import { detectLang, mineruToHtml } from '../src/import/page';
import { $, injectTranslation, makeCtx, rangeBetween, roundTripRandomSelections } from './helpers';

const SAMPLE = `# A TITLE WITH $x^2$

Jane Doe, John Roe

University of Somewhere

## ABSTRACT

We study $N _ { v }$ tokens.

## 1 INTRODUCTION

First paragraph with H<sub>2</sub>O and a<sup>2</sup>.

![image](https://cdn.example.com/a.jpg)



(a) Left panel.


![image](https://cdn.example.com/b.jpg)



(b) Right panel with $\\alpha$.



Figure 1: Two panels.

Theorem 1 (Main result). Let $x > 0$. Then

$$
x ^ { 2 } > 0 . \\tag{1}
$$

Proof. Obvious.

## 1.1 DETAILS

Table 1: Numbers.


<table><tr><td><eq>N_v</eq></td><td rowspan="2" onclick="alert(1)">v</td></tr><tr><td>1 &amp; 2</td></tr></table>

$$
y = 1
$$

## 2 CONCLUSION

![image](javascript:void0)

Figure 2: Unsafe image.

## REFERENCES

Alice. A paper. 2024.

Bob. <script>alert(1)</script> Another paper.

## APPENDIX

## A NOTATION

Symbols.

## A.1 MORE

More.
`;

describe('解析', () => {
  const paper = parseMinerUMarkdown(SAMPLE);

  it('标题、作者、摘要、参考文献', () => {
    expect(paper.title).toBe('A TITLE WITH $x^2$');
    expect(paper.frontMatter).toEqual(['Jane Doe, John Roe', 'University of Somewhere']);
    expect(paper.abstract).toEqual(['We study $N _ { v }$ tokens.']);
    expect(paper.references).toHaveLength(2);
  });

  it('按编号推断层级；单字母编号只在参考文献之后算附录', () => {
    const outline = (secs = paper.sections, d = 0): string[] =>
      secs.flatMap((s) => [`${'  '.repeat(d)}${s.number ?? '-'} ${s.title}`, ...outline(s.children, d + 1)]);
    expect(outline()).toEqual(['1 INTRODUCTION', '  1.1 DETAILS', '2 CONCLUSION', '- APPENDIX', 'A NOTATION', '  A.1 MORE']);
    expect(paper.referencesAt).toBe(2);
    expect(parseMinerUMarkdown('# T\n\n## A SIMPLE BASELINE\n\nx').sections[0]!.number).toBeUndefined();
  });

  it('图片和子图注、图注组成一个图', () => {
    const fig = paper.sections[0]!.blocks.find((b) => b.kind === 'figure');
    expect(fig).toEqual({
      kind: 'figure',
      number: '1',
      tag: 'Figure 1: ',
      caption: 'Two panels.',
      panels: [
        { src: 'https://cdn.example.com/a.jpg', alt: 'image', label: 'a', caption: 'Left panel.' },
        { src: 'https://cdn.example.com/b.jpg', alt: 'image', label: 'b', caption: 'Right panel with $\\alpha$.' },
      ],
    });
  });

  it('表注在表格上方；公式的 \\tag 拆成编号', () => {
    const blocks = paper.sections[0]!.children[0]!.blocks;
    expect(blocks.map((b) => b.kind)).toEqual(['table', 'equation']);
    expect(blocks[0]).toMatchObject({ number: '1', caption: 'Numbers.' });
    const eq = paper.sections[0]!.blocks.find((b) => b.kind === 'equation');
    expect(eq).toEqual({ kind: 'equation', tex: 'x ^ { 2 } > 0 .', tag: '1' });
  });

  it('找不到图片的 "Figure N:" 图注：作为只有图注的图，不混在正文里', () => {
    const p = parseMinerUMarkdown('# T\n\n## 1 X\n\nText (1) label in figure\n\nFigure 1: Comparison.\n\nMore text.');
    expect(p.sections[0]!.blocks).toEqual([
      { kind: 'para', text: 'Text (1) label in figure' },
      { kind: 'figure', panels: [], number: '1', tag: 'Figure 1: ', caption: 'Comparison.' },
      { kind: 'para', text: 'More text.' },
    ]);
    // 正文里提到图（没有冒号）不受影响
    expect(parseMinerUMarkdown('# T\n\n## 1 X\n\nFigure 3 shows the result.').sections[0]!.blocks[0]!.kind).toBe('para');
  });

  it('MinerU 的算法块：标题 + 按行号分行（有换行、整段一行两种写法）', () => {
    const multi = [
      '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">',
      'Algorithm 1: Standard Per-Sample DUE Computation',
      '1: Input: Training samples $\\{x_{i}\\}_{i=1}^{N}$ , target $\\nu$',
      '2: Output: DUE scores',
      '',
      '3: for i = 1 to N do',
      '4: end for',
      '</div>',
    ].join('\n');
    const single =
      '<div class="mineru-algorithm" style="white-space: pre-wrap;"> Algorithm 1: Standard Per-Sample DUE Computation 1: Input: Training samples $\\{x_{i}\\}_{i=1}^{N}$ , target $\\nu$ 2: Output: DUE scores 3: for i = 1 to N do 4: end for </div>';
    const expected = {
      kind: 'algorithm',
      number: '1',
      tag: 'Algorithm 1: ',
      caption: 'Standard Per-Sample DUE Computation',
      lines: [
        { label: '1:', text: 'Input: Training samples $\\{x_{i}\\}_{i=1}^{N}$ , target $\\nu$' },
        { label: '2:', text: 'Output: DUE scores' },
        { label: '3:', text: 'for i = 1 to N do' },
        { label: '4:', text: 'end for' },
      ],
    };
    for (const md of [multi, single]) {
      const blocks = parseMinerUMarkdown(`# T\n\n## 1 X\n\nBefore.\n\n${md}\n\nAfter.`).sections[0]!.blocks;
      expect(blocks.map((b) => b.kind)).toEqual(['para', 'algorithm', 'para']);
      expect(blocks[1]).toEqual(expected);
    }
    // 公式里的 "2:" 不算行号；没有行号时按换行分行
    expect(parseAlgorithm('Algorithm 2: T\n1: a $x 2: y$ b\n2: c').lines).toEqual([
      { label: '1:', text: 'a $x 2: y$ b' },
      { label: '2:', text: 'c' },
    ]);
    expect(parseAlgorithm('Algorithm 3: T\nrepeat\nuntil done').lines).toEqual([{ text: 'repeat' }, { text: 'until done' }]);
  });

  it('IEEE 风格的 "Abstract—" 段落', () => {
    const p = parseMinerUMarkdown('# T\n\nAuthor\n\nAbstract—We do things.\n\n## 1 X\n\ny');
    expect(p.frontMatter).toEqual(['Author']);
    expect(p.abstract).toEqual(['We do things.']);
  });

  it('语言检测', () => {
    expect(detectLang(paper)).toBe('en');
    expect(detectLang(parseMinerUMarkdown('# 标题\n\n## 1 引言\n\n本文研究视觉令牌的稀释问题，并给出统计理论。'))).toBe('zh');
  });

  it('allBlocks 包含子节', () => {
    expect(allBlocks(paper).filter((b) => b.kind === 'table')).toHaveLength(1);
  });
});

describe('渲染', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = renderArticle(document, parseMinerUMarkdown(SAMPLE));
    document.body.replaceChildren(root);
  });

  it('LaTeXML 风格的 id 和类名', () => {
    expect($('S1').className).toBe('ltx_section');
    expect($('S1.SS1').className).toBe('ltx_subsection');
    expect($('S1.p1').className).toBe('ltx_para');
    expect($('S1.p1.1').tagName).toBe('P');
    expect($('S1.F1').querySelectorAll('.ltx_figure_panel')).toHaveLength(2);
    expect($('S1.E1').querySelector('.ltx_tag_equation')!.textContent).toBe('(1)');
    expect($('S1.SS1.T1').querySelector('figcaption')!.textContent).toBe('Table 1: Numbers.');
    expect($('S1.SS1.Ex1')).toBeTruthy();
    expect($('A1').className).toBe('ltx_appendix');
    expect($('A1.SS1')).toBeTruthy();
    expect($('bib.bib2').querySelector('.ltx_bibblock')).toBeTruthy();
    // 参考文献在 "APPENDIX" 之前
    const order = Array.from(root.children, (e) => e.id || e.className);
    expect(order.indexOf('bib')).toBe(order.indexOf('Sx1') - 1);
  });

  it('公式是带 alttext 的 <math>，TeX 去掉多余空格', () => {
    const m = $('abs.p1').querySelector('math')!;
    expect(m.namespaceURI).toBe('http://www.w3.org/1998/Math/MathML');
    expect(m.getAttribute('alttext')).toBe('N_{v}');
    expect(tidyTex('\\left\\{ { s } _ { i } \\right\\} \\ { a }')).toBe('\\left\\{{s}_{i} \\right\\} \\ {a}');
    // 解析失败也输出 <math>
    const bad = renderArticle(document, parseMinerUMarkdown('# T\n\n## 1 X\n\nBad $\\frac{a$ here.'));
    const merr = bad.querySelector('math merror');
    expect(merr?.textContent).toBe('\\frac{a');
  });

  it('不可信内容：脚本、事件属性、javascript: 图片都被去掉', () => {
    const html = root.outerHTML;
    expect(root.querySelector('script, [onclick]')).toBeNull();
    expect(html).not.toContain('javascript:');
    expect($('bib.bib2').textContent).toContain('<script>alert(1)</script>'); // 作为文本保留
    const td = $('S1.SS1.T1').querySelectorAll('td');
    expect(td[1]!.getAttribute('rowspan')).toBe('2');
    expect(td[2]!.textContent).toBe('1 & 2');
    expect(td[0]!.querySelector('math')!.getAttribute('alttext')).toBe('N_v');
  });

  it('算法块、缺图的图注、排版标签', () => {
    const md = [
      '# T', '', '## 1 X', '',
      'A <span style="color:red">red</span> word and a < b > c.', '',
      'Figure 1: Missing image.', '',
      '<div class="mineru-algorithm">', 'Algorithm 1: Train', '1: init $x$', '2: return', '</div>',
    ].join('\n');
    const art = renderArticle(document, parseMinerUMarkdown(md));
    document.body.replaceChildren(art);
    expect($('S1.p1.1').textContent).toBe('A red word and a < b > c.');
    expect($('S1.F1').querySelector('.ltx_figure_missing')!.getAttribute('translate')).toBe('no');
    expect($('S1.F1').querySelector('figcaption')!.textContent).toBe('Figure 1: Missing image.');
    const alg = $('S1.alg1');
    expect(alg.className).toBe('ltx_float ltx_algorithm');
    expect(alg.querySelector('figcaption')!.textContent).toBe('Algorithm 1: Train');
    expect(Array.from(alg.querySelectorAll('.ltx_listingline'), (p) => [p.id, p.textContent])).toEqual([
      ['S1.alg1.l1', '1: init x'],
      ['S1.alg1.l2', '2: return'],
    ]);
    expect(alg.querySelector('math')!.getAttribute('alttext')).toBe('x');
    expect(roundTripRandomSelections(art)).toBeGreaterThan(2);
  });

  it('定理标签加粗，证明斜体', () => {
    const ps = Array.from($('S1').querySelectorAll(':scope > .ltx_para p'));
    expect(ps[1]!.querySelector('.ltx_font_bold')!.textContent).toBe('Theorem 1 (Main result).');
    expect(ps[2]!.querySelector('.ltx_font_italic')!.textContent).toBe('Proof.');
  });

  it('论文库元数据可以从页面提取', () => {
    const meta = extractMeta(document, { id: 'x', version: '' }, 0);
    expect(meta.title).toBe('A TITLE WITH $x^2$');
    expect(meta.authors).toEqual(['Jane Doe, John Roe']);
  });

  it('摘要可以从页面提取：公式换成 TeX，多段之间空一行；没有摘要时为空串', () => {
    expect(extractAbstract(document)).toBe('We study $N_{v}$ tokens.');
    document.body.replaceChildren(renderArticle(document, parseMinerUMarkdown('# T\n\nAbstract—First 10<sup>6</sup>.\n\nSecond.\n\n## 1 Intro\n\nBody.')));
    expect(extractAbstract(document)).toBe('First 10^6.\n\nSecond.');
    document.body.replaceChildren(renderArticle(document, parseMinerUMarkdown('# T\n\n## 1 Intro\n\nBody.')));
    expect(extractAbstract(document)).toBe('');
  });

  it('每个块内随机选区都能按偏移找回', () => {
    expect(roundTripRandomSelections(root)).toBeGreaterThan(10);
  });

  it('翻译插件插入译文后，原文层和译文层划线都能定位', () => {
    const ctx = makeCtx(root);
    const p = $('S1.p1.1');
    const src = describeRange(rangeBetween(p, 'First paragraph'), ctx)!;
    injectTranslation(p, '第一段');
    const cap = $('S1.F1').querySelector('figcaption')!;
    injectTranslation(cap, '左侧面板', 'read-frog');
    ctx.resetCache();
    expect(anchorSegment(src.segments[0]!, 'source', ctx).status).toBe('anchored');
    const tr = describeRange(rangeBetween(cap, '左侧'), ctx)!;
    expect(tr.layer).toBe('translation');
    expect(anchorSegment(tr.segments[0]!, 'translation', ctx).status).toBe('anchored');
    expect(ctx.textMap(cap, 'source').text).toBe('(a) Left panel.');
  });

  it('完整页面带 lang 和标题', () => {
    const html = mineruToHtml(document, SAMPLE);
    expect(html).toMatch(/^<!DOCTYPE html>\n<html lang="en">/);
    expect(html).toContain('<title>A TITLE WITH x^2</title>');
  });
});

const file = process.env.MINERU_MD;

describe.skipIf(!file)('真实 MinerU 论文', () => {
  it('转换后每个块内随机选区 describe → anchor 结果一致', () => {
    const paper = parseMinerUMarkdown(readFileSync(file!, 'utf8'));
    const root = renderArticle(document, paper);
    document.body.replaceChildren(root);
    const ids = Array.from(root.querySelectorAll('[id]'), (e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    console.log(
      `sections ${root.querySelectorAll('section').length}, figures ${root.querySelectorAll('figure.ltx_figure:not(.ltx_figure_panel)').length}, ` +
        `tables ${root.querySelectorAll('figure.ltx_table').length}, math ${root.querySelectorAll('math').length} ` +
        `(${root.querySelectorAll('merror').length} failed), refs ${paper.references.length}`,
    );
    const checked = roundTripRandomSelections(root);
    console.log(`checked ${checked} segments`);
    expect(checked).toBeGreaterThan(100);
  });
});
