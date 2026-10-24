/**
 * 导入论文里对图、表、节、公式、定理的引用
 */
import { describe, expect, it } from 'vitest';
import { findRefs } from '../src/import/crossrefs';
import { renderArticle } from '../src/import/latexml';
import { parseMinerUMarkdown } from '../src/import/mineru';

const KEYS = new Set([
  'figure:1', 'figure:2', 'figure:2(b)', 'table:1', 'table:2', 'table:3', 'section:3', 'section:4.1', 'section:B', 'section:B.2',
  'equation:2', 'equation:3', 'algorithm:1', 'theorem:1', 'theorem:2', 'lemma:4',
]);

/** 每处引用写成 "文字→键" */
function refs(text: string): string[] {
  return findRefs(text, (k) => KEYS.has(k)).map((r) => `${text.slice(r.start, r.end)}→${r.key}`);
}

describe('识别', () => {
  it('各种关键词和缩写', () => {
    expect(refs('Figure 1, Fig. 2, Table 3, Tab. 1, Section 4.1, Sec. 3, §3, Appendix B, App. B.2, Algorithm 1, Lemma 4')).toEqual([
      'Figure 1→figure:1', 'Fig. 2→figure:2', 'Table 3→table:3', 'Tab. 1→table:1', 'Section 4.1→section:4.1', 'Sec. 3→section:3',
      '§3→section:3', 'Appendix B→section:B', 'App. B.2→section:B.2', 'Algorithm 1→algorithm:1', 'Lemma 4→lemma:4',
    ]);
  });

  it('公式：带括号、不带括号；括号只用于公式', () => {
    expect(refs('Eq. (2), Equation 3, Eq.(3), Figure (1)')).toEqual(['Eq. (2)→equation:2', 'Equation 3→equation:3', 'Eq.(3)→equation:3']);
  });

  it('子图：有这个子图时链到子图，没有时链到整个图', () => {
    expect(refs('Figure 2(b) and Figure 2(c)')).toEqual(['Figure 2(b)→figure:2(b)', 'Figure 2→figure:2']);
  });

  it('复数后面的多个编号、范围；单数不往后接', () => {
    expect(refs('Theorems 1 and 2; Tables 1–3; Eqs. (2) and (3)')).toEqual([
      'Theorems 1→theorem:1', '2→theorem:2', 'Tables 1→table:1', '3→table:3', 'Eqs. (2)→equation:2', '(3)→equation:3',
    ]);
    expect(refs('in Table 2, 3 methods')).toEqual(['Table 2→table:2']);
  });

  it('不存在的编号、单个字母（除了附录）、词的一部分：不算', () => {
    expect(refs('Figure 9, Table B, Section 7, Prefigure 1, Figure 1x, Theorem A')).toEqual([]);
  });
});

describe('渲染', () => {
  const md = [
    '# T',
    '## 1 INTRO',
    'As Figure 1 and Table 1 show, Theorem 1 holds; see Section 2 and Eq. (1).',
    'Theorem 1 (Main). By Lemma 9, $x$ is Figure 1 here.',
    '## 2 METHOD',
    '$$\nx = 1 \\tag{1}\n$$',
    '![image](https://cdn.example.com/a.jpg)',
    'Figure 1: The figure, compare with Figure 1 and Table 1.',
    'Table 1: Numbers.',
    '<table><tr><td>see Figure 1</td></tr></table>',
  ].join('\n\n');
  const art = renderArticle(document, parseMinerUMarkdown(md));
  const links = (sel: string) => [...art.querySelector(sel)!.querySelectorAll('a.ltx_ref')].map((a) => `${a.textContent}→${a.getAttribute('href')}`);

  it('链接到后面才出现的图、表、节、公式；文字不变', () => {
    const p = art.querySelector('#S1\\.p1')!;
    expect(p.textContent).toBe('As Figure 1 and Table 1 show, Theorem 1 holds; see Section 2 and Eq. (1).');
    expect(links('#S1\\.p1')).toEqual(['Figure 1→#S2.F1', 'Table 1→#S2.T1', 'Theorem 1→#S1.p2', 'Section 2→#S2', 'Eq. (1)→#S2.E1']);
  });

  it('不链接到自身：定理的标题、图注里提到自己的图', () => {
    expect(links('#S1\\.p2')).toEqual(['Figure 1→#S2.F1']);
    expect(links('#S2\\.F1 figcaption')).toEqual(['Table 1→#S2.T1']);
    expect(links('#S2\\.T1')).toEqual(['Figure 1→#S2.F1']);
  });
});
