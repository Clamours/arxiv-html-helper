import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArxivFeed, type ApiMeta } from '../src/core/arxiv-api';
import { mergeApiMeta, mergePageMeta, needsApiMeta, type PaperMeta } from '../src/core/paper';

it('parseArxivFeed：id 去掉版本号，标题和摘要折叠空白，支持旧式 id；作者没填的项为空串', () => {
  const xml = readFileSync(join(__dirname, 'fixtures', 'arxiv-api.xml'), 'utf8');
  expect(parseArxivFeed(xml)).toEqual([
    {
      id: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Łukasz Kaiser'],
      published: '2017-06-12T17:57:34Z',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer.',
      category: 'cs.CL',
      latestVersion: 'v7',
      updated: '2023-08-02T00:41:18Z',
      doi: '',
      journalRef: '',
      comment: '15 pages, 5 figures',
    },
    {
      id: 'hep-th/9901001',
      title: 'String Junctions and Their Duals in Heterotic String Theory',
      authors: ['Yosuke Imamura'],
      published: '1999-01-01T01:01:10Z',
      abstract:
        'We explicitly give the correspondence between spectra of heterotic string theory compactified on $T^2$ and string junctions in type IIB theory compactified on $S^2$.',
      category: 'hep-th',
      latestVersion: 'v3',
      updated: '1999-05-10T04:45:54Z',
      doi: '10.1143/PTP.101.1155',
      journalRef: 'Prog.Theor.Phys.101:1155-1164,1999',
      comment: '13 pages + 4 eps figures, PTPTeX, typographical errors corrected',
    },
  ]);
});

const apiMeta = (over: Partial<ApiMeta> = {}): ApiMeta => ({
  id: 'x',
  title: 'Attention Is All You Need',
  authors: ['A', 'B'],
  published: '2017-06-12T00:00:00Z',
  abstract: 'We propose the Transformer.',
  category: 'cs.CL',
  latestVersion: 'v7',
  updated: '2023-08-02T00:00:00Z',
  doi: '',
  journalRef: '',
  comment: '',
  ...over,
});

describe('元数据合并', () => {
  const fromPage: PaperMeta = { id: 'x', version: 'v3', title: '注意力就是你所需要的', authors: ['Google'], lastOpenedAt: 99 };
  const api = apiMeta();

  it('没有 API 数据时用页面数据', () => {
    expect(mergePageMeta(null, fromPage)).toEqual({ ...fromPage, source: 'page' });
  });

  it('API 数据覆盖页面提取的标题作者，补上摘要等，记下获取时间，保留打开记录', () => {
    const merged = mergeApiMeta(mergePageMeta(null, fromPage), api, 500);
    expect(merged).toMatchObject({
      title: api.title, authors: ['A', 'B'], version: 'v3', lastOpenedAt: 99, source: 'api', apiAt: 500,
      abstract: 'We propose the Transformer.', category: 'cs.CL', latestVersion: 'v7', updated: '2023-08-02T00:00:00Z',
    });
    // 作者没填的项不写
    expect(merged).not.toHaveProperty('doi');
  });

  it('重新获取时，作者删掉的 DOI 等不保留旧值', () => {
    const first = mergeApiMeta(null, apiMeta({ doi: '10.1/x', comment: 'NeurIPS' }), 1);
    const again = mergeApiMeta(first, apiMeta({ comment: 'ICML' }), 2);
    expect(again).not.toHaveProperty('doi');
    expect(again).toMatchObject({ comment: 'ICML', apiAt: 2 });
  });

  it('之后再打开论文页，只更新版本和打开时间，不会被翻译过的标题覆盖，摘要等保留', () => {
    const merged = mergePageMeta(mergeApiMeta(null, api), { ...fromPage, version: 'v4', lastOpenedAt: 200 });
    expect(merged).toMatchObject({ title: api.title, authors: ['A', 'B'], version: 'v4', lastOpenedAt: 200, source: 'api', abstract: api.abstract });
  });

  it('URL 不带版本号时保留原来的版本', () => {
    const merged = mergePageMeta({ ...mergeApiMeta(null, api), version: 'v2' }, { ...fromPage, version: '' });
    expect(merged.version).toBe('v2');
  });
});

describe('needsApiMeta', () => {
  const fetched = (over: Partial<PaperMeta> = {}) => ({ ...mergeApiMeta(null, apiMeta(), 1), ...over });

  it('没有获取过、旧版本获取的（没有获取时间）需要获取', () => {
    expect(needsApiMeta(null)).toBe(true);
    expect(needsApiMeta({ id: 'x', version: 'v1', title: 'T', authors: [], lastOpenedAt: 1, source: 'page' })).toBe(true);
    expect(needsApiMeta({ id: 'x', version: 'v1', title: 'T', authors: [], lastOpenedAt: 1, source: 'api' })).toBe(true);
  });

  it('打开过比已知最新版本更新的版本时重新获取，否则不用', () => {
    expect(needsApiMeta(fetched({ version: 'v7' }))).toBe(false);
    expect(needsApiMeta(fetched({ version: 'v3' }))).toBe(false);
    expect(needsApiMeta(fetched({ version: '' }))).toBe(false);
    expect(needsApiMeta(fetched({ version: 'v10' }))).toBe(true);
  });
});
