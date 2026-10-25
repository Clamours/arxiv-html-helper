import { describe, expect, it } from 'vitest';
import type { Group } from '../src/core/groups';
import { countViews, groupLibrary, inView, searchLibrary, sortLibrary } from '../src/core/library';
import { extractMeta, type PaperMeta } from '../src/core/paper';
import type { Annotation } from '../src/core/types';

function ann(over: Partial<Annotation> & { key?: string; exact?: string }): Annotation {
  const { key = '#S1.p1.1', exact = 'text', ...rest } = over;
  return {
    id: Math.random().toString(36),
    paperId: 'x',
    paperVersion: 'v1',
    layer: 'source',
    segments: [{ blockKey: key, position: { start: 0, end: exact.length }, quote: { exact, prefix: '', suffix: '' } }],
    color: 'yellow',
    note: '',
    createdAt: 0,
    updatedAt: 0,
    ...rest,
  };
}

const meta = (id: string, over: Partial<PaperMeta> = {}): PaperMeta => ({
  id, version: 'v2', title: `Title ${id}`, authors: [], lastOpenedAt: 0, ...over,
});

describe('groupLibrary', () => {
  it('合并笔记、元数据和分组；收录浏览过但没有笔记的论文，跳过空列表和无关 key', () => {
    const lib = groupLibrary({
      'paper:1706.03762': [ann({ updatedAt: 5, paperVersion: 'v5', createdAt: 4 }), ann({ updatedAt: 9, paperVersion: 'v7', createdAt: 2 })],
      'meta:1706.03762': meta('1706.03762', { version: 'v7', lastOpenedAt: 30 }),
      'paper:2401.00001': [ann({ updatedAt: 3, paperVersion: 'v3' })],
      'meta:2402.00002': meta('2402.00002', { lastOpenedAt: 40 }), // 只浏览过
      'shelf:2404.00004': { groups: [], flagged: true, addedAt: 7, updatedAt: 8 }, // 只有分组记录
      'paper:2403.00003': [],
      'shelf:': { groups: [] },
      other: 1,
    });
    expect(lib.map((e) => e.id).sort()).toEqual(['1706.03762', '2401.00001', '2402.00002', '2404.00004']);
    const a = lib.find((e) => e.id === '1706.03762')!;
    expect(a.meta?.title).toBe('Title 1706.03762');
    expect(a.lastNoteAt).toBe(9);
    // 没有分组记录：默认不属于任何分组，加入时间取最早的笔记或打开时间
    expect(a.shelf).toEqual({ groups: [], flagged: false, rating: 0, addedAt: 2, updatedAt: 0 });
    const b = lib.find((e) => e.id === '2401.00001')!;
    expect(b.meta).toBeNull();
    expect(b.version).toBe('v3'); // 没有元数据时用笔记里的版本
    const c = lib.find((e) => e.id === '2402.00002')!;
    expect(c).toMatchObject({ annotations: [], lastNoteAt: 0, version: 'v2', shelf: { addedAt: 40 } });
    expect(lib.find((e) => e.id === '2404.00004')!.shelf).toEqual({ groups: [], flagged: true, rating: 0, addedAt: 7, updatedAt: 8 });
  });

  it('论文笔记：附在论文上，算进最近笔记时间；清空的论文笔记不单独收录论文', () => {
    const lib = groupLibrary({
      'meta:A': meta('A'),
      'paper:A': [ann({ updatedAt: 5 })],
      'note:A': { text: '读后总结', updatedAt: 9 },
      'note:B': { text: '只有论文笔记', updatedAt: 3 },
      'note:C': { text: '', updatedAt: 4 },
      'note:D': { text: 1 },
    });
    expect(lib.map((e) => e.id).sort()).toEqual(['A', 'B']);
    const a = lib.find((e) => e.id === 'A')!;
    expect(a.note).toEqual({ text: '读后总结', updatedAt: 9 });
    expect(a.lastNoteAt).toBe(9);
    // 清空过的论文笔记不算"最近笔记"
    const cleared = groupLibrary({ 'meta:A': meta('A'), 'paper:A': [ann({ updatedAt: 5 })], 'note:A': { text: '', updatedAt: 9 } });
    expect(cleared[0]!.lastNoteAt).toBe(5);
  });
});

describe('排序与搜索', () => {
  const lib = groupLibrary({
    'paper:A': [ann({ updatedAt: 1, exact: 'self-attention layer', note: '关键公式' })],
    'meta:A': meta('A', { title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], lastOpenedAt: 50 }),
    'paper:B': [ann({ updatedAt: 7 }), ann({ updatedAt: 2 })],
    'meta:B': meta('B', { title: 'BERT', lastOpenedAt: 10 }),
    'shelf:B': { groups: [], flagged: false, rating: 3, addedAt: 99, updatedAt: 0 },
    'note:B': { text: 'Masked LM 预训练', updatedAt: 1 },
  });

  it.each([
    ['recent-note', ['B', 'A']],
    ['recent-open', ['A', 'B']],
    ['recent-added', ['B', 'A']],
    // A 打开得更晚，但没有评分
    ['rating', ['B', 'A']],
    ['count', ['B', 'A']],
    ['title', ['A', 'B']],
  ] as const)('%s', (key, order) => {
    expect(sortLibrary(lib, key).map((e) => e.id)).toEqual(order);
  });

  it('搜索标题、作者、划线和笔记，多个关键词需全部命中', () => {
    const ids = (q: string) => searchLibrary(lib, q).map((r) => r.entry.id);
    expect(ids('')).toHaveLength(2);
    expect(ids('bert')).toEqual(['B']);
    expect(ids('vaswani')).toEqual(['A']);
    expect(ids('关键')).toEqual(['A']);
    expect(ids('attention 公式')).toEqual(['A']);
    expect(ids('attention bert')).toEqual([]);
  });

  it('命中笔记内容时返回命中的笔记，只命中标题时不返回', () => {
    expect(searchLibrary(lib, 'self-attention')[0]!.matched).toHaveLength(1);
    expect(searchLibrary(lib, 'BERT')[0]!.matched).toHaveLength(0);
  });

  it('搜索论文笔记，并标出命中', () => {
    expect(searchLibrary(lib, 'masked').map((r) => [r.entry.id, r.noteHit])).toEqual([['B', true]]);
    expect(searchLibrary(lib, 'bert 预训练').map((r) => [r.entry.id, r.noteHit])).toEqual([['B', true]]);
    expect(searchLibrary(lib, 'bert')[0]!.noteHit).toBe(false);
  });
});

describe('extractMeta', () => {
  it('提取标题（去脚注、公式转 TeX）和作者（只取第一行）', () => {
    document.body.innerHTML = `
      <h1 class="ltx_title ltx_title_document">Scaling <math alttext="O(n^2)"></math> Attention<span class="ltx_note"><sup>†</sup>thanks</span></h1>
      <div class="ltx_authors">
        <span class="ltx_creator"><span class="ltx_personname">Albert Q. Jiang
        </span></span>
        <span class="ltx_creator"><span class="ltx_personname">Jane Doe<br class="ltx_break">Some University<br>jane@x.edu</span></span>
        <span class="ltx_creator"><span class="ltx_personname">bob@example.com</span></span>
      </div>`;
    const m = extractMeta(document, { id: '2401.04088', version: 'v1' }, 123);
    expect(m).toEqual({
      id: '2401.04088',
      version: 'v1',
      title: 'Scaling $O(n^2)$ Attention',
      authors: ['Albert Q. Jiang', 'Jane Doe'],
      lastOpenedAt: 123,
    });
  });

  it('没有标题元素时退回 document.title，再退回 id', () => {
    document.body.innerHTML = '';
    document.title = '';
    expect(extractMeta(document, { id: '2401.1', version: '' }).title).toBe('2401.1');
  });
});

describe('侧栏视图', () => {
  const g = (id: string, order: number): Group => ({ id, name: id, color: 'blue', order, createdAt: 0, updatedAt: 0 });
  const groups = [g('rl', 1), g('agent', 2)];
  const lib = groupLibrary({
    'meta:A': meta('A'), // 默认：不属于任何分组
    'shelf:B': { groups: ['rl', 'agent'], flagged: true, addedAt: 1, updatedAt: 1 },
    'shelf:C': { groups: [], flagged: false, addedAt: 1, updatedAt: 1 },
    'shelf:D': { groups: ['deleted-group'], flagged: false, addedAt: 1, updatedAt: 1 }, // 只剩已删除分组的残留 id
  });
  const ids = (view: Parameters<typeof inView>[1]) => lib.filter((e) => inView(e, view, groups)).map((e) => e.id).sort();

  it('按视图过滤', () => {
    expect(ids('all')).toEqual(['A', 'B', 'C', 'D']);
    expect(ids('flagged')).toEqual(['B']);
    expect(ids('ungrouped')).toEqual(['A', 'C', 'D']);
    expect(ids('group:rl')).toEqual(['B']);
  });

  it('计数', () => {
    expect(Object.fromEntries(countViews(lib, groups))).toEqual({
      all: 4, flagged: 1, ungrouped: 3, 'group:rl': 1, 'group:agent': 1,
    });
  });
});
