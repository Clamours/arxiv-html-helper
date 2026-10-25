import { describe, expect, it } from 'vitest';
import { BackupError, backupFileName, createBackup, parseBackup, planImport } from '../src/core/backup';
import type { Group, Shelf } from '../src/core/groups';
import type { PaperMeta } from '../src/core/paper';
import type { Annotation } from '../src/core/types';

function ann(id: string, paperId: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id, paperId, paperVersion: 'v1', layer: 'source', color: 'yellow', note: '', createdAt: 1, updatedAt: 1,
    segments: [{ blockKey: '#S1.p1.1', position: { start: 0, end: 5 }, quote: { exact: 'Hello', prefix: '', suffix: ' world' } }],
    ...over,
  };
}
const meta = (id: string, over: Partial<PaperMeta> = {}): PaperMeta => ({
  id, version: 'v1', title: `T ${id}`, authors: ['A'], lastOpenedAt: 10, source: 'page', ...over,
});
const roundtrip = (all: Record<string, unknown>) => parseBackup(JSON.stringify(createBackup(all, '0.1.0')));
const group = (id: string, name: string, over: Partial<Group> = {}): Group => ({
  id, name, color: 'green', order: 1, createdAt: 1, updatedAt: 1, ...over,
});
const shelf = (groups: string[], over: Partial<Shelf> = {}): Shelf => ({ groups, flagged: false, rating: 0, addedAt: 1, updatedAt: 1, ...over });

describe('createBackup / parseBackup', () => {
  it('无损往返，包含译文层、元数据和分组；收录只浏览过的论文，跳过无关键和空列表', () => {
    const tr = ann('t', 'B', {
      layer: 'translation',
      note: '译文笔记',
      segments: [{ blockKey: '#S2.p1.1', position: { start: 1, end: 3 }, quote: { exact: '注意', prefix: '', suffix: '' }, translation: { provider: 'read-frog', snapshot: '注意力机制' } }],
    });
    const all = {
      'paper:B': [tr],
      'meta:B': meta('B', { source: 'api', published: '2017-06-12T00:00:00Z' }),
      'paper:A': [ann('a1', 'A'), ann('a2', 'A', { color: 'pink', note: 'x' })],
      'paper:C': [],
      'meta:D': meta('D'),
      'shelf:B': { groups: ['g1'], flagged: true, addedAt: 3, updatedAt: 4 },
      groups: [group('g1', 'RL')],
      other: 1,
    };
    const b = createBackup(all, '0.1.0', new Date('2026-09-28T10:00:00Z'));
    expect(b).toMatchObject({ format: 'arxiv-html-notes-backup', version: 3, exportedAt: '2026-09-28T10:00:00.000Z', extensionVersion: '0.1.0' });
    expect(b.papers.map((p) => p.id)).toEqual(['A', 'B', 'D']);
    expect(b.groups.map((g) => g.id)).toEqual(['g1']);
    // 没有分组记录的论文导出默认值（不属于任何分组）
    expect(b.papers[0]!.shelf).toEqual({ groups: [], flagged: false, rating: 0, addedAt: 1, updatedAt: 0 });
    const parsed = parseBackup(JSON.stringify(b));
    expect(parsed.invalid).toBe(0);
    expect(parsed.papers).toEqual(b.papers);
    expect(parsed.groups).toEqual(b.groups);
  });

  it('兼容版本 1：没有分组信息', () => {
    const v1 = { format: 'arxiv-html-notes-backup', version: 1, papers: [{ id: 'A', meta: null, annotations: [ann('a', 'A')] }] };
    const p = parseBackup(JSON.stringify(v1));
    expect(p.groups).toEqual([]);
    expect(p.papers[0]!.shelf).toBeNull();
  });

  it.each([
    ['不是 JSON', 'not json', '文件不是有效的 JSON'],
    ['别的 JSON', '{"foo":1}', '这不是 arXiv HTML Helper 的备份文件'],
    ['更新版本', '{"format":"arxiv-html-notes-backup","version":99,"papers":[]}', '更新版本'],
    ['缺少列表', '{"format":"arxiv-html-notes-backup","version":1}', '缺少论文列表'],
  ])('%s → 报错', (_, text, msg) => {
    expect(() => parseBackup(text)).toThrow(BackupError);
    expect(() => parseBackup(text)).toThrow(msg);
  });

  it('损坏的条目跳过并计数，其余照常导入；paperId 以所在论文为准；未知颜色退回黄色', () => {
    const text = JSON.stringify({
      format: 'arxiv-html-notes-backup',
      version: 1,
      papers: [
        {
          id: 'A',
          meta: null,
          annotations: [
            { ...ann('ok', 'WRONG'), color: 'orange' },
            { id: 'bad-layer', layer: 'x', segments: [] },
            { ...ann('bad-seg', 'A'), segments: [{ blockKey: 1 }] },
            'garbage',
          ],
        },
        { annotations: [ann('no-paper-id', '')] },
      ],
    });
    const p = parseBackup(text);
    expect(p.invalid).toBe(4);
    expect(p.papers).toHaveLength(1);
    expect(p.papers[0]!.annotations).toHaveLength(1);
    expect(p.papers[0]!.annotations[0]).toMatchObject({ id: 'ok', paperId: 'A', color: 'yellow' });
  });
});

describe('planImport', () => {
  it('导入到空的插件：全部新增', () => {
    const src = { 'paper:A': [ann('a1', 'A'), ann('a2', 'A')], 'meta:A': meta('A') };
    const plan = planImport({}, roundtrip(src));
    expect(plan.summary).toMatchObject({ papers: 1, newPapers: 1, added: 2, updated: 0, unchanged: 0, keptLocal: 0, newGroups: 0 });
    expect(plan.writes).toEqual({ ...src, 'shelf:A': { groups: [], flagged: false, rating: 0, addedAt: 1, updatedAt: 0 } });
  });

  it('按 id 合并：新增、更新、保留本地较新的、相同的不写', () => {
    const local = {
      'paper:A': [ann('same', 'A'), ann('older', 'A', { note: '旧', updatedAt: 1 }), ann('newer', 'A', { note: '本地新', updatedAt: 9 }), ann('localOnly', 'A')],
    };
    const backup = {
      'paper:A': [ann('same', 'A'), ann('older', 'A', { note: '备份新', updatedAt: 5 }), ann('newer', 'A', { note: '备份旧', updatedAt: 3 }), ann('fresh', 'A')],
    };
    const plan = planImport(local, roundtrip(backup));
    expect(plan.summary).toMatchObject({ papers: 1, newPapers: 0, added: 1, updated: 1, unchanged: 1, keptLocal: 1 });
    const merged = plan.writes['paper:A'] as Annotation[];
    const byId = Object.fromEntries(merged.map((a) => [a.id, a.note]));
    expect(byId).toEqual({ same: '', older: '备份新', newer: '本地新', localOnly: '', fresh: '' });
  });

  it('只增不删：本地有而备份没有的论文和笔记保持不动', () => {
    const local = { 'paper:A': [ann('a', 'A')], 'paper:B': [ann('b', 'B')] };
    const plan = planImport(local, roundtrip({ 'paper:A': [ann('a', 'A')] }));
    expect(plan.writes).toEqual({});
    expect(plan.summary).toMatchObject({ unchanged: 1, added: 0 });
  });

  it('重复导入同一个文件不产生变化', () => {
    const src = { 'paper:A': [ann('a', 'A')], 'meta:A': meta('A') };
    const once = planImport({}, roundtrip(src));
    const twice = planImport(once.writes, roundtrip(src));
    expect(twice.writes).toEqual({});
    expect(twice.summary.unchanged).toBe(1);
  });

  it('元数据：API 来源优先，打开时间取较晚者', () => {
    const local = { 'paper:A': [ann('a', 'A')], 'meta:A': meta('A', { title: '页面标题', lastOpenedAt: 50 }) };
    const backup = { 'paper:A': [ann('a', 'A')], 'meta:A': meta('A', { title: 'API 标题', source: 'api', lastOpenedAt: 20 }) };
    const m = planImport(local, roundtrip(backup)).writes['meta:A'] as PaperMeta;
    expect(m).toMatchObject({ title: 'API 标题', source: 'api', lastOpenedAt: 50 });

    // 反过来：本地是 API 数据，备份是页面数据 → 保留本地标题
    const m2 = planImport(backup, roundtrip(local)).writes['meta:A'] as PaperMeta;
    expect(m2).toMatchObject({ title: 'API 标题', lastOpenedAt: 50 });
  });

  it('元数据：摘要等 arXiv 信息原样往返；都来自 API 时取后获取的一份', () => {
    const details = { apiAt: 9, abstract: '摘要', category: 'cs.CL', latestVersion: 'v7', updated: '2023-08-02T00:00:00Z', doi: '10.1/x', journalRef: 'NeurIPS', comment: '15 pages' };
    const fetched = { 'meta:A': meta('A', { source: 'api', lastOpenedAt: 10, ...details }) };
    expect(roundtrip(fetched).papers[0]!.meta).toEqual(fetched['meta:A']);
    const old = { 'meta:A': meta('A', { source: 'api', lastOpenedAt: 50 }) };
    expect(planImport(old, roundtrip(fetched)).writes['meta:A']).toMatchObject({ ...details, lastOpenedAt: 50 });
    expect(planImport(fetched, roundtrip(old)).writes['meta:A']).toMatchObject({ ...details, lastOpenedAt: 50 });
  });
});

describe('planImport：论文笔记', () => {
  it('往返不变；取修改时间较新的一份，内容相同时不写', () => {
    const backup = { 'meta:A': meta('A'), 'note:A': { text: '备份', updatedAt: 5 }, 'note:B': { text: '只有论文笔记', updatedAt: 2 } };
    const parsed = roundtrip(backup);
    expect(parsed.papers.map((p) => [p.id, p.note])).toEqual([['A', { text: '备份', updatedAt: 5 }], ['B', { text: '只有论文笔记', updatedAt: 2 }]]);

    const fresh = planImport({}, parsed);
    expect(fresh.writes['note:A']).toEqual({ text: '备份', updatedAt: 5 });
    expect(fresh.summary.paperNotes).toBe(2);
    expect(planImport({ 'meta:A': meta('A'), 'note:A': { text: '本地', updatedAt: 9 } }, parsed).writes['note:A']).toBeUndefined();
    expect(planImport({ 'meta:A': meta('A'), 'note:A': { text: '本地', updatedAt: 1 } }, parsed).writes['note:A']).toEqual({ text: '备份', updatedAt: 5 });
    expect(planImport({ 'meta:A': meta('A'), 'note:A': { text: '备份', updatedAt: 1 } }, parsed).writes['note:A']).toBeUndefined();
  });
});

describe('planImport：分组', () => {
  it('论文的分组取并集，标记取较新的；同名分组合并为同一个', () => {
    const local = {
      groups: [group('rl', 'RL'), group('mine', 'Agent', { order: 2 })],
      'paper:A': [ann('a', 'A')],
      'shelf:A': shelf(['mine'], { updatedAt: 5 }),
    };
    const backup = {
      groups: [group('theirs', 'agent'), group('new', 'Vision')],
      'paper:A': [ann('a', 'A')],
      'shelf:A': shelf(['theirs', 'new'], { flagged: true, updatedAt: 9 }),
    };
    const plan = planImport(local, roundtrip(backup));
    expect(plan.summary).toMatchObject({ newGroups: 1, shelvesChanged: 1, unchanged: 1 });
    expect((plan.writes.groups as Group[]).map((g) => g.name)).toEqual(['RL', 'Agent', 'Vision']);
    expect(plan.writes['shelf:A']).toEqual({ groups: ['mine', 'new'], flagged: true, rating: 0, addedAt: 1, updatedAt: 9 });
  });

  it('本地已有分组记录的论文：备份里没有 shelf（版本 1）时不改动', () => {
    const local = { 'paper:A': [ann('a', 'A')], 'shelf:A': shelf([]) };
    const v1 = { format: 'arxiv-html-notes-backup', version: 1, papers: [{ id: 'A', meta: null, annotations: [ann('a', 'A')] }] };
    const plan = planImport(local, parseBackup(JSON.stringify(v1)));
    expect(plan.writes).toEqual({});
  });

  it('只浏览过、没有笔记的论文也会导入；备份里残留的已删除分组 id 被丢弃', () => {
    const backup = { groups: [group('g', 'RL')], 'meta:B': meta('B'), 'shelf:B': shelf(['g', 'gone'], { flagged: true }) };
    const plan = planImport({}, roundtrip(backup));
    expect(plan.summary).toMatchObject({ papers: 1, newPapers: 1, added: 0 });
    expect(plan.writes['meta:B']).toEqual(meta('B'));
    expect(plan.writes['shelf:B']).toEqual(shelf(['g'], { flagged: true }));
    expect(planImport(plan.writes, roundtrip(backup)).writes).toEqual({});
  });
});

it('backupFileName 使用本地日期', () => {
  expect(backupFileName(new Date(2026, 8, 28, 23, 30))).toBe('arxiv-html-helper-backup-2026-09-28.json');
});

describe('planImport：恢复已删除的内容', () => {
  it('本地删除过、备份里还有的笔记、论文和分组会恢复，修改时间改为导入时间以免同步时再被删掉', () => {
    const backup = {
      groups: [group('g', 'RL', { updatedAt: 5 })],
      'paper:A': [ann('a', 'A', { updatedAt: 5 })],
      'meta:A': meta('A', { lastOpenedAt: 5 }),
      'shelf:A': shelf(['g'], { addedAt: 5, updatedAt: 5 }),
      'note:A': { text: '总结', updatedAt: 5 },
      'paper:B': [ann('b', 'B', { updatedAt: 5 }), ann('b2', 'B', { updatedAt: 5 })],
    };
    const local = {
      'tomb:A': { paper: 100, annotations: {} },
      'paper:B': [ann('b2', 'B', { updatedAt: 5 })],
      'tomb:B': { annotations: { b: 100 } },
      'groups-deleted': { g: { at: 100 } },
    };
    const w = planImport(local, roundtrip(backup), 1000).writes;
    expect((w['paper:A'] as Annotation[])[0]!.updatedAt).toBe(1000);
    expect((w['meta:A'] as PaperMeta).lastOpenedAt).toBe(1000);
    expect((w['shelf:A'] as Shelf).updatedAt).toBe(1000);
    expect(w['note:A']).toEqual({ text: '总结', updatedAt: 1000 });
    expect(Object.fromEntries((w['paper:B'] as Annotation[]).map((a) => [a.id, a.updatedAt]))).toEqual({ b: 1000, b2: 5 });
    expect((w.groups as Group[]).find((g) => g.id === 'g')!.updatedAt).toBe(1000);
  });
});

describe('导入论文的页面', () => {
  const X = 'pdf-0123456789abcdef0123';
  const Y = 'pdf-fedcba9876543210fedc';
  const doc = (id: string, c: string) => ({ id, html: `<p>${id}</p>`, sha256: c.repeat(64) });

  it('导出时带上论文库里论文的页面；已移除论文的页面不带，没有页面时不写 docs', () => {
    const all = { [`meta:${X}`]: meta(X), 'meta:A': meta('A') };
    const kept = doc(X, 'a');
    const b = createBackup(all, '0.1.0', new Date(), [doc(Y, 'b'), kept]);
    expect(b.docs).toEqual([kept]);
    expect(parseBackup(JSON.stringify(b)).docs).toEqual([kept]);
    expect(createBackup(all, '0.1.0')).not.toHaveProperty('docs');
    expect(roundtrip(all).docs).toEqual([]);
  });

  it('解析时跳过格式不对的页面，以及文件里没有这篇论文的页面', () => {
    const ok = doc(X, 'a');
    const text = JSON.stringify({
      format: 'arxiv-html-notes-backup',
      version: 3,
      papers: [{ id: X, meta: meta(X), annotations: [] }],
      docs: [ok, { ...ok, sha256: 'xyz' }, { ...ok, html: '' }, { ...ok, id: '2401.00001' }, doc(Y, 'b'), 'junk'],
    });
    expect(parseBackup(text).docs).toEqual([ok]);
  });
});
