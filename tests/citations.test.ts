/**
 * 导入论文的文献引用：识别正文里的引用文字，链接到参考文献条目
 */
import { describe, expect, it } from 'vitest';
import { Bibliography } from '../src/import/citations';
import { renderArticle } from '../src/import/latexml';
import { parseMinerUMarkdown } from '../src/import/mineru';

/** 每处引用写成 {整体文字: [链接文字→条目下标]} */
function cites(bib: Bibliography, text: string): [string, string[]][] {
  return bib.find(text).map((s) => [text.slice(s.start, s.end), s.links.map((l) => `${text.slice(l.start, l.end)}→${l.ref}`)]);
}

describe('数字引用', () => {
  const bib = new Bibliography(['[1] A. One. Paper.', '[2] B. Two. Paper.', '[3] C. Three.', '[4] D. Four.', '[5] E. Five.']);

  it('单个、多个、范围', () => {
    expect(cites(bib, 'as in [2] and [1, 3–5].')).toEqual([
      ['[2]', ['2→1']],
      ['[1, 3–5]', ['1→0', '3→2', '5→4']],
    ]);
    expect(cites(bib, 'see [ 4 ]')).toEqual([['[ 4 ]', ['4→3']]]);
  });

  it('编号不在参考文献里、区间写法：不算引用', () => {
    expect(cites(bib, 'in [0, 1] or [6] or [5-2]')).toEqual([]);
  });

  it('参考文献没有编号时不识别数字引用', () => {
    expect(cites(new Bibliography(['A. One. Paper. 2020.']), 'see [1]')).toEqual([]);
  });
});

describe('作者-年份引用', () => {
  const bib = new Bibliography([
    'Saeed Ranjbar Alvar, Gursimran Singh, and Yong Zhang. Divprune. In CVPR, pp. 9392–9401. IEEE, 2025.',
    'Alessio Giorlandino and Sebastian Goldt. Two failure modes. In ICML, 2026.',
    'Haotian Liu, Chunyuan Li, and Yong Jae Lee. Improved baselines. In CVPR, 2024a.',
    'Nelson F Liu, Kevin Lin, and Percy Liang. Lost in the middle. TACL, 12:157–173, 2024b.',
    'Petar Veliˇ ckovi´ c, Christos Perivolaropoulos, and Razvan Pascanu. Softmax is not enough. arXiv:2410.01104, 2025.',
    'Yihe Dong, Jean-Baptiste Cordonnier, and Andreas Loukas. Attention is not all you need. In ICML, 2021.',
    'Qizhe Zhang, Aosong Cheng, and Shanghang Zhang. Beyond attention. In ICCV, 2025.',
    'Shaolei Zhang, Qingkai Fang, and Yang Feng. Llava-mini. In ICLR, 2025.',
  ]);

  it('括号里的多处引用合成一处，范围包括括号', () => {
    expect(cites(bib, 'pruning (e.g., Alvar et al., 2025; Liu et al., 2024b) works')).toEqual([
      ['(e.g., Alvar et al., 2025; Liu et al., 2024b)', ['Alvar et al., 2025→0', 'Liu et al., 2024b→3']],
    ]);
  });

  it('年份后的字母：条目里印着字母时按字母配，没印时按条目顺序', () => {
    expect(cites(bib, '(Liu et al., 2024a)')[0]![1]).toEqual(['Liu et al., 2024a→2']);
    expect(cites(bib, '(Zhang et al., 2025a;b)')[0]![1]).toEqual(['Zhang et al., 2025a→6', 'b→7']);
  });

  it('文中引用 "X et al. (2021)"、两位作者、OCR 拆开的变音符号', () => {
    expect(cites(bib, 'Following Dong et al. (2021), we')).toEqual([['Dong et al. (2021)', ['Dong et al. (2021→5']]]);
    expect(cites(bib, '(Giorlandino & Goldt, 2026)')[0]![1]).toEqual(['Giorlandino & Goldt, 2026→1']);
    expect(cites(bib, '(Velickoviˇ c et al., 2025)')[0]![1]).toEqual(['Velickoviˇ c et al., 2025→4']);
  });

  it('作者或年份对不上的不算引用', () => {
    expect(cites(bib, '(Smith et al., 2025) and (Alvar et al., 2019) and In 2025, Liu')).toEqual([]);
  });
});

describe('渲染', () => {
  const md = [
    '# T',
    '## 1 INTRO',
    'Prior work (Dong et al., 2021; Giorlandino & Goldt, 2026) and Dong et al. (2021).',
    'Table 1: Compared with (Dong et al., 2021).',
    '<table><tr><td>Giorlandino & Goldt (2026)</td></tr></table>',
    '## REFERENCES',
    'Yihe Dong, Jean-Baptiste Cordonnier, and Andreas Loukas. Attention is <i>not</i> all you need. In ICML, 2021.',
    'Alessio Giorlandino and Sebastian Goldt. Two failure modes. In ICML, 2026.',
  ].join('\n\n');
  const art = renderArticle(document, parseMinerUMarkdown(md));

  it('和 arXiv 一样：<cite class="ltx_cite"> 里的 <a class="ltx_ref" href="#bib.bibN">，文字不变', () => {
    const p = art.querySelector('.ltx_para .ltx_p')!;
    expect(p.textContent).toBe('Prior work (Dong et al., 2021; Giorlandino & Goldt, 2026) and Dong et al. (2021).');
    expect(p.innerHTML.replace(/ title="[^"]*"/g, '')).toBe(
      'Prior work <cite class="ltx_cite">(<a class="ltx_ref" href="#bib.bib1">Dong et al., 2021</a>; ' +
        '<a class="ltx_ref" href="#bib.bib2">Giorlandino &amp; Goldt, 2026</a>)</cite> and ' +
        '<cite class="ltx_cite"><a class="ltx_ref" href="#bib.bib1">Dong et al. (2021</a>)</cite>.',
    );
    expect(p.querySelector('a')!.title).toBe('Yihe Dong, Jean-Baptiste Cordonnier, and Andreas Loukas. Attention is not all you need. In ICML, 2021.');
  });

  it('图注、表格里也识别；参考文献本身不加链接', () => {
    expect(art.querySelector('.ltx_caption a.ltx_ref')?.getAttribute('href')).toBe('#bib.bib1');
    expect(art.querySelector('td a.ltx_ref')?.getAttribute('href')).toBe('#bib.bib2');
    expect(art.querySelector('.ltx_bibliography a')).toBeNull();
  });
});
