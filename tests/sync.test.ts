import { describe, expect, it } from 'vitest';
import { parseBackup } from '../src/core/backup';
import type { Group, Shelf } from '../src/core/groups';
import type { PaperMeta } from '../src/core/paper';
import {
  fingerprint,
  fromBackup,
  fromStorage,
  mergeSync,
  planLocalWrites,
  stableStringify,
  toSyncFile,
  type SyncData,
} from '../src/core/sync';
import { TOMB_TTL } from '../src/core/tombstones';
import type { Annotation } from '../src/core/types';
import { syncOnce, type LocalStore } from '../src/sync/engine';
import { SyncError, type SyncProvider } from '../src/sync/provider';

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
const group = (id: string, name: string, over: Partial<Group> = {}): Group => ({
  id, name, color: 'green', order: 1, createdAt: 1, updatedAt: 1, ...over,
});
const shelf = (groups: string[], over: Partial<Shelf> = {}): Shelf => ({ groups, flagged: false, addedAt: 1, updatedAt: 1, ...over });

const NOW = 1_000_000;
const data = (all: Record<string, unknown>) => fromStorage(all);
const merge = (a: Record<string, unknown>, b: Record<string, unknown>, now = NOW) => mergeSync(data(a), data(b), now);
const notes = (d: SyncData, id: string) => Object.fromEntries((d.papers.get(id)?.annotations ?? []).map((a) => [a.id, a.note]));

describe('同步文件', () => {
  it('本地数据 → 同步文件 → 解析，内容不变；同步文件可以当备份导入', () => {
    const all = {
      'paper:A': [ann('a1', 'A', { note: 'x' }), ann('a2', 'A', { layer: 'translation' })],
      'meta:A': meta('A', { source: 'api', published: '2017' }),
      'shelf:A': shelf(['g']),
      'tomb:A': { annotations: { gone: 5 } },
      'tomb:B': { paper: 7, annotations: {} },
      'meta:C': meta('C'),
      groups: [group('g', 'RL')],
      'groups-deleted': { old: { at: 3 } },
      'sync:config': { secret: 1 },
    };
    const d = data(all);
    const file = toSyncFile(d, '0.1.0');
    expect(file.papers.map((p) => p.id)).toEqual(['A', 'C']);
    expect(file.deleted).toEqual({ papers: { A: { annotations: { gone: 5 } }, B: { paper: 7, annotations: {} } }, groups: { old: { at: 3 } } });
    expect(JSON.stringify(file)).not.toContain('secret');
    const back = fromBackup(parseBackup(JSON.stringify(file)));
    expect(fingerprint(back)).toBe(fingerprint(d));
  });

  it('fingerprint 与数组顺序、对象键顺序无关', () => {
    const a = data({ 'paper:A': [ann('x', 'A'), ann('y', 'A')], 'shelf:A': shelf(['g', 'h']) });
    const b = data({ 'shelf:A': { updatedAt: 1, addedAt: 1, flagged: false, groups: ['h', 'g'] }, 'paper:A': [ann('y', 'A'), ann('x', 'A')] });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(stableStringify({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}');
  });
});

describe('mergeSync：笔记', () => {
  it('两边各自新增的都保留；同一条取修改时间较新的', () => {
    const a = { 'paper:A': [ann('x', 'A', { note: 'A 改', updatedAt: 9 }), ann('onlyA', 'A')] };
    const b = { 'paper:A': [ann('x', 'A', { note: 'B 改', updatedAt: 5 }), ann('onlyB', 'A')], 'paper:B': [ann('b', 'B')] };
    const m = merge(a, b);
    expect(notes(m, 'A')).toEqual({ x: 'A 改', onlyA: '', onlyB: '' });
    expect(notes(m, 'B')).toEqual({ b: '' });
  });

  it('删除会同步：删除时间晚于修改时间的被删掉，删除记录保留', () => {
    const a = { 'paper:A': [ann('keep', 'A')], 'tomb:A': { annotations: { x: 20 } } };
    const b = { 'paper:A': [ann('keep', 'A'), ann('x', 'A', { updatedAt: 10 })] };
    const m = merge(a, b);
    expect(notes(m, 'A')).toEqual({ keep: '' });
    expect(m.papers.get('A')!.tomb.annotations).toEqual({ x: 20 });
  });

  it('一边删除之后另一边又改过的，保留修改', () => {
    const m = merge({ 'tomb:A': { annotations: { x: 20 } } }, { 'paper:A': [ann('x', 'A', { note: '后改的', updatedAt: 30 })] });
    expect(notes(m, 'A')).toEqual({ x: '后改的' });
  });

  it('同时修改（修改时间相同）时两边选出同一个结果', () => {
    const a = { 'paper:A': [ann('x', 'A', { note: '甲', updatedAt: 5 })] };
    const b = { 'paper:A': [ann('x', 'A', { note: '乙', updatedAt: 5 })] };
    expect(fingerprint(merge(a, b))).toBe(fingerprint(merge(b, a)));
  });
});

describe('mergeSync：论文', () => {
  it('从论文库移除会同步：移除前的笔记、元数据、分组都删掉', () => {
    const a = { 'tomb:A': { paper: 50, annotations: {} } };
    const b = { 'paper:A': [ann('x', 'A', { updatedAt: 40 })], 'meta:A': meta('A', { lastOpenedAt: 45 }), 'shelf:A': shelf([]) };
    const m = merge(a, b);
    expect(m.papers.get('A')).toEqual({ id: 'A', meta: null, shelf: null, annotations: [], tomb: { paper: 50, annotations: {} } });
  });

  it('移除之后重新打开的论文：新的元数据、分组和笔记保留', () => {
    const a = { 'tomb:A': { paper: 50, annotations: { old: 30 } } };
    const b = {
      'paper:A': [ann('old', 'A', { updatedAt: 10 }), ann('new', 'A', { createdAt: 60, updatedAt: 60 })],
      'meta:A': meta('A', { lastOpenedAt: 60 }),
      'shelf:A': shelf([], { addedAt: 60, updatedAt: 0 }),
    };
    const p = merge(a, b).papers.get('A')!;
    expect(p.annotations.map((x) => x.id)).toEqual(['new']);
    expect(p.meta?.lastOpenedAt).toBe(60);
    expect(p.shelf?.addedAt).toBe(60);
    // 被整篇删除覆盖的笔记删除记录不再单独保留
    expect(p.tomb).toEqual({ paper: 50, annotations: {} });
  });

  it('元数据：API 来源优先，版本取最近打开的，打开时间取较晚的', () => {
    const a = { 'meta:A': meta('A', { title: 'API', source: 'api', version: 'v1', lastOpenedAt: 10, published: '2017' }) };
    const b = { 'meta:A': meta('A', { title: '页面', version: 'v3', lastOpenedAt: 20 }) };
    expect(merge(a, b).papers.get('A')!.meta).toEqual({ ...meta('A'), title: 'API', source: 'api', version: 'v3', lastOpenedAt: 20, published: '2017' });
  });

  it('分组和标记取修改时间较新的一份：移出分组也能同步', () => {
    const a = { 'shelf:A': shelf(['h', 'g'], { flagged: true, updatedAt: 5 }) };
    const b = { 'shelf:A': shelf(['g'], { updatedAt: 9, addedAt: 3 }), groups: [group('g', 'RL')] };
    expect(merge(a, b).papers.get('A')!.shelf).toEqual(shelf(['g'], { updatedAt: 9, addedAt: 1 }));
  });

  it('两边都没手动改过分组时加入时间取较早的', () => {
    const a = { 'shelf:A': shelf([], { updatedAt: 0, addedAt: 5 }) };
    const b = { 'shelf:A': shelf([], { updatedAt: 0, addedAt: 3 }) };
    expect(merge(a, b).papers.get('A')!.shelf).toEqual(shelf([], { updatedAt: 0, addedAt: 3 }));
  });

  it('删除记录超过保留期后清除', () => {
    const now = TOMB_TTL + 1000;
    const m = merge({ 'tomb:A': { paper: 10, annotations: {} }, 'tomb:B': { annotations: { x: 999 } }, 'paper:B': [ann('y', 'B')] }, {}, now);
    expect(m.papers.has('A')).toBe(false);
    expect(m.papers.get('B')!.tomb).toEqual({ annotations: {} });
  });
});

describe('mergeSync：分组', () => {
  it('改名、改颜色取较新的；删除会同步（包括旧版本的「待读」）', () => {
    const a = { groups: [group('g', 'RL 新名', { updatedAt: 9 }), group('h', 'Vision')], 'groups-deleted': { 'to-read': { at: 99 } } };
    const b = { groups: [group('g', 'RL', { updatedAt: 5 }), group('h', 'Vision')], 'groups-deleted': { h: { at: 50 } } };
    const m = merge(a, b);
    expect(m.groups.map((g) => g.name)).toEqual(['RL 新名']);
    expect(m.deletedGroups).toEqual({ 'to-read': { at: 99 }, h: { at: 50 } });
  });

  it('两台电脑各自新建的同名分组合并为先建的那个，论文上的 id 跟着换', () => {
    const a = { groups: [group('ga', 'Agent', { createdAt: 5 })], 'shelf:A': shelf(['ga'], { updatedAt: 5 }) };
    const b = { groups: [group('gb', 'agent', { createdAt: 3 })], 'shelf:B': shelf(['gb'], { updatedAt: 5 }) };
    const m = merge(a, b);
    expect(m.groups.map((g) => g.id)).toEqual(['gb']);
    expect(m.deletedGroups.ga).toEqual({ at: NOW, mergedInto: 'gb' });
    expect(m.papers.get('A')!.shelf!.groups).toEqual(['gb']);
    expect(fingerprint(m)).toBe(fingerprint(merge(b, a)));
    // 之后同步到还在用旧 id 的电脑上，也会换掉
    expect(mergeSync(m, data(a), NOW + 1).papers.get('A')!.shelf!.groups).toEqual(['gb']);
  });

  it('已删除分组的 id 从论文上去掉', () => {
    const m = merge({ 'groups-deleted': { g: { at: 9 } } }, { groups: [group('g', 'RL'), group('h', 'Vision')], 'shelf:A': shelf(['g', 'h']) });
    expect(m.papers.get('A')!.shelf!.groups).toEqual(['h']);
  });
});

describe('mergeSync 的性质', () => {
  const a = {
    'paper:A': [ann('x', 'A', { note: '1', updatedAt: 3 }), ann('y', 'A')],
    'meta:A': meta('A'),
    'shelf:A': shelf(['g'], { updatedAt: 4 }),
    groups: [group('g', 'RL'), group('k', 'Same', { createdAt: 9 })],
    'tomb:B': { annotations: { b1: 5 } },
  };
  const b = {
    'paper:A': [ann('x', 'A', { note: '2', updatedAt: 4 })],
    'paper:B': [ann('b1', 'B', { updatedAt: 2 }), ann('b2', 'B')],
    'meta:B': meta('B', { source: 'api' }),
    groups: [group('g', 'RL2', { updatedAt: 3 }), group('j', 'same', { createdAt: 2 })],
    'groups-deleted': { z: { at: 1 } },
  };

  it('与顺序无关、重复合并不变', () => {
    const ab = merge(a, b);
    expect(fingerprint(ab)).toBe(fingerprint(merge(b, a)));
    expect(fingerprint(mergeSync(ab, ab, NOW))).toBe(fingerprint(ab));
    expect(fingerprint(mergeSync(ab, data(a), NOW))).toBe(fingerprint(ab));
  });
});

describe('planLocalWrites', () => {
  it('没有变化时不写；只写有变化的键，并统计笔记的增删改', () => {
    const local = {
      'paper:A': [ann('x', 'A'), ann('gone', 'A')],
      'meta:A': meta('A'),
      'paper:B': [ann('b', 'B')],
    };
    expect(planLocalWrites(local, data(local))).toEqual({ set: {}, remove: [], changes: { added: 0, updated: 0, removed: 0, other: 0 } });

    const remote = {
      'paper:A': [ann('x', 'A', { note: '改', updatedAt: 9 }), ann('new', 'A')],
      'tomb:A': { annotations: { gone: 5 } },
      'meta:A': meta('A'),
      'tomb:B': { paper: 5, annotations: {} },
    };
    const plan = planLocalWrites(local, merge(local, remote));
    expect(plan.changes).toEqual({ added: 1, updated: 1, removed: 2, other: 0 });
    expect(Object.keys(plan.set).sort()).toEqual(['paper:A', 'tomb:A', 'tomb:B']);
    expect(plan.remove).toEqual(['paper:B']);
  });
});

// ---------------------------------------------------------------------------
// 两台电脑通过假的云端同步
// ---------------------------------------------------------------------------

function memoryStore(init: Record<string, unknown> = {}): LocalStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = structuredClone(init);
  return {
    data,
    getAll: async () => structuredClone(data),
    get: async (keys) => structuredClone(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))),
    set: async (items) => void Object.assign(data, structuredClone(items)),
    remove: async (keys) => keys.forEach((k) => delete data[k]),
  };
}

interface FakeCloud {
  text: string | null;
  version: number;
  writes: number;
  /** 下一次读取之后、写入之前，模拟另一台电脑写入 */
  interfere: (() => Promise<unknown>) | null;
  provider: SyncProvider;
}

function fakeCloud(): FakeCloud {
  const cloud: FakeCloud = {
    text: null,
    version: 0,
    writes: 0,
    interfere: null,
    provider: {
      async read() {
        const file = { texts: cloud.text ? [cloud.text] : [], version: cloud.version };
        const interfere = cloud.interfere;
        cloud.interfere = null;
        await interfere?.();
        return file;
      },
      async write(text, prev, conditional) {
        if (conditional && prev.version !== cloud.version) throw new SyncError('conflict', 'conflict');
        cloud.text = text;
        cloud.version++;
        cloud.writes++;
      },
    },
  };
  return cloud;
}

describe('syncOnce', () => {
  it('两台电脑之间同步新增、修改和删除', async () => {
    const cloud = fakeCloud();
    const pcA = memoryStore({ 'paper:A': [ann('x', 'A')], 'meta:A': meta('A') });
    const pcB = memoryStore({ 'paper:B': [ann('y', 'B')] });

    const first = await syncOnce(cloud.provider, pcA, '0.1.0', () => NOW);
    expect(first.uploaded).toBe(true);
    const r = await syncOnce(cloud.provider, pcB, '0.1.0', () => NOW);
    expect(r.changes.added).toBe(1);
    expect(Object.keys(pcB.data).sort()).toEqual(['meta:A', 'paper:A', 'paper:B']);

    // B 删除 x、修改 y；A 同步后跟上
    delete pcB.data['paper:A'];
    pcB.data['tomb:A'] = { annotations: { x: NOW + 1 } };
    pcB.data['paper:B'] = [ann('y', 'B', { note: 'B 改', updatedAt: NOW + 1 })];
    await syncOnce(cloud.provider, pcB, '0.1.0', () => NOW + 2);
    const back = await syncOnce(cloud.provider, pcA, '0.1.0', () => NOW + 3);
    expect(back.changes).toMatchObject({ added: 1, removed: 1 });
    expect(pcA.data['paper:A']).toBeUndefined();
    expect((pcA.data['paper:B'] as Annotation[])[0]!.note).toBe('B 改');

    // 都已是最新：不写本地也不上传
    const writes = cloud.writes;
    const idle = await syncOnce(cloud.provider, pcA, '0.1.0', () => NOW + 4);
    expect(idle).toMatchObject({ uploaded: false, changes: { added: 0, updated: 0, removed: 0, other: 0 } });
    expect(cloud.writes).toBe(writes);
    expect(idle.fingerprint).toBe(fingerprint(fromStorage(pcA.data)));
  });

  it('上传时云端刚被另一台电脑改过：重新合并，两边的改动都在', async () => {
    const cloud = fakeCloud();
    const pcB = memoryStore({ 'paper:B': [ann('b', 'B')] });
    await syncOnce(cloud.provider, pcB, '0.1.0', () => NOW);
    const pcA = memoryStore({ 'paper:A': [ann('a', 'A')] });
    pcB.data['paper:B'] = [ann('b', 'B'), ann('b2', 'B')];
    cloud.interfere = () => syncOnce(cloud.provider, pcB, '0.1.0', () => NOW);
    const before = cloud.writes;
    await syncOnce(cloud.provider, pcA, '0.1.0', () => NOW);
    // B 写了一次，A 第一次写入冲突、重新合并后写了一次
    expect(cloud.writes).toBe(before + 2);
    const final = fromBackup(parseBackup(cloud.text!));
    expect(notes(final, 'A')).toEqual({ a: '' });
    expect(notes(final, 'B')).toEqual({ b: '', b2: '' });
  });

  it('云端文件损坏时报错，不覆盖', async () => {
    const cloud = fakeCloud();
    cloud.text = '{"format":"arxiv-html-notes-backup","version":99,"papers":[]}';
    await expect(syncOnce(cloud.provider, memoryStore({ 'paper:A': [ann('a', 'A')] }), '0.1.0')).rejects.toThrow('已暂停同步');
    expect(cloud.writes).toBe(0);
  });

  it('合并期间本地又有改动时不覆盖它，重新来过', async () => {
    const cloud = fakeCloud();
    const other = memoryStore({ 'paper:A': [ann('x', 'A', { note: '云端', updatedAt: 5 })] });
    await syncOnce(cloud.provider, other, '0.1.0', () => NOW);
    const pc = memoryStore({ 'paper:A': [ann('x', 'A', { note: '旧', updatedAt: 1 })] });
    const getAll = pc.getAll;
    let first = true;
    pc.getAll = async () => {
      const snapshot = await getAll();
      if (first) {
        first = false;
        // 读取之后用户新增了一条笔记
        pc.data['paper:A'] = [ann('x', 'A', { note: '旧', updatedAt: 1 }), ann('typing', 'A', { updatedAt: 6 })];
      }
      return snapshot;
    };
    await syncOnce(cloud.provider, pc, '0.1.0', () => NOW);
    expect(notes(fromStorage(pc.data), 'A')).toEqual({ x: '云端', typing: '' });
  });
});
