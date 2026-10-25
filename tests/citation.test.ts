import { describe, expect, it } from 'vitest';
import { citeKey, toBibtex } from '../src/core/citation';
import type { PaperMeta } from '../src/core/paper';

const meta = (over: Partial<PaperMeta> = {}): PaperMeta => ({
  id: '1706.03762',
  version: 'v7',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Łukasz Kaiser'],
  lastOpenedAt: 0,
  published: '2017-06-12T17:57:34Z',
  source: 'api',
  apiAt: 1,
  category: 'cs.CL',
  ...over,
});

describe('toBibtex', () => {
  it('arXiv 的 @misc 格式：年份取首个版本，网址不带版本号', () => {
    expect(toBibtex(meta())).toBe(
      [
        '@misc{vaswani2017attention,',
        '  title         = {Attention Is All You Need},',
        '  author        = {Ashish Vaswani and Noam Shazeer and Łukasz Kaiser},',
        '  year          = {2017},',
        '  eprint        = {1706.03762},',
        '  archivePrefix = {arXiv},',
        '  primaryClass  = {cs.CL},',
        '  url           = {https://arxiv.org/abs/1706.03762},',
        '}',
      ].join('\n'),
    );
  });

  it('有 DOI 时带上；没有分类时省略；旧式 id', () => {
    const bib = toBibtex(meta({ id: 'hep-th/9901001', category: undefined, doi: '10.1143/PTP.101.1155' }));
    expect(bib).toContain('  doi           = {10.1143/PTP.101.1155},');
    expect(bib).toContain('  eprint        = {hep-th/9901001},');
    expect(bib).toContain('  url           = {https://arxiv.org/abs/hep-th/9901001},');
    expect(bib).not.toContain('primaryClass');
  });

  it('转义 & % #，公式和已转义的不动', () => {
    const bib = toBibtex(meta({ title: 'Q&A at 100% for $O(n^2)$ \\& #1' }));
    expect(bib).toContain('title         = {Q\\&A at 100\\% for $O(n^2)$ \\& \\#1},');
  });
});

describe('citeKey', () => {
  it('第一作者的姓 + 年份 + 标题第一个实词', () => {
    expect(citeKey(meta())).toBe('vaswani2017attention');
    expect(citeKey(meta({ title: 'On the Opportunities and Risks of Foundation Models', authors: ['Rishi Bommasani'] }))).toBe(
      'bommasani2017opportunities',
    );
  });

  it('去掉重音和符号，跳过公式；缺作者或年份时退回', () => {
    expect(citeKey(meta({ authors: ['José Muñoz-García'] }))).toBe('munozgarcia2017attention');
    expect(citeKey(meta({ title: '$O(n)$ Attention' }))).toBe('vaswani2017attention');
    expect(citeKey(meta({ authors: [], published: undefined }))).toBe('arxivattention');
  });
});
