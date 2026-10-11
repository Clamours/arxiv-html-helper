import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArxivFeed } from '../src/core/arxiv-api';
import { mergeApiMeta, mergePageMeta, type PaperMeta } from '../src/core/paper';

it('parseArxivFeed：id 去掉版本号，标题折叠空白，支持旧式 id', () => {
  const xml = readFileSync(join(__dirname, 'fixtures', 'arxiv-api.xml'), 'utf8');
  expect(parseArxivFeed(xml)).toEqual([
    {
      id: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Łukasz Kaiser'],
      published: '2017-06-12T17:57:34Z',
    },
    {
      id: 'hep-th/9901001',
      title: 'String Junctions and Their Duals in Heterotic String Theory',
      authors: ['Yosuke Imamura'],
      published: '1999-01-01T01:01:10Z',
    },
  ]);
});

describe('元数据合并', () => {
  const fromPage: PaperMeta = { id: 'x', version: 'v3', title: '注意力就是你所需要的', authors: ['Google'], lastOpenedAt: 99 };
  const api = { id: 'x', title: 'Attention Is All You Need', authors: ['A', 'B'], published: '2017-06-12T00:00:00Z' };

  it('没有 API 数据时用页面数据', () => {
    expect(mergePageMeta(null, fromPage)).toEqual({ ...fromPage, source: 'page' });
  });

  it('API 数据覆盖页面提取的标题作者，保留打开记录', () => {
    const merged = mergeApiMeta(mergePageMeta(null, fromPage), api);
    expect(merged).toMatchObject({ title: api.title, authors: ['A', 'B'], version: 'v3', lastOpenedAt: 99, source: 'api' });
  });

  it('之后再打开论文页，只更新版本和打开时间，不会被翻译过的标题覆盖', () => {
    const merged = mergePageMeta(mergeApiMeta(null, api), { ...fromPage, version: 'v4', lastOpenedAt: 200 });
    expect(merged).toMatchObject({ title: api.title, authors: ['A', 'B'], version: 'v4', lastOpenedAt: 200, source: 'api' });
  });

  it('URL 不带版本号时保留原来的版本', () => {
    const merged = mergePageMeta({ ...mergeApiMeta(null, api), version: 'v2' }, { ...fromPage, version: '' });
    expect(merged.version).toBe('v2');
  });
});
