import { describe, expect, it } from 'vitest';
import { addGroup, mergeGroups, mergeShelves, normalizeGroups, toShelf, type Group } from '../src/core/groups';

const g = (id: string, over: Partial<Group> = {}): Group => ({
  id, name: id, color: 'blue', order: 1, createdAt: 0, updatedAt: 0, ...over,
});

describe('normalizeGroups', () => {
  it('没有数据时只有「待读」', () => {
    expect(normalizeGroups(undefined)).toEqual([
      { id: 'to-read', name: '待读', color: 'blue', order: 0, createdAt: 0, updatedAt: 0 },
    ]);
  });

  it('补上「待读」，丢弃无效项，按 id 去重，按顺序排列，未知颜色退回灰色', () => {
    const list = normalizeGroups([
      g('b', { order: 2 }),
      g('a', { order: 1, color: 'orange' as never }),
      g('a', { name: '重复' }),
      { id: 'x', name: '   ' },
      'garbage',
    ]);
    expect(list.map((x) => x.id)).toEqual(['to-read', 'a', 'b']);
    expect(list[1]).toMatchObject({ name: 'a', color: 'gray' });
  });

  it('保留改过名的「待读」', () => {
    expect(normalizeGroups([g('to-read', { name: 'Inbox', order: 0 })])[0]!.name).toBe('Inbox');
  });
});

describe('addGroup', () => {
  it('新分组排在最后，颜色依次轮换', () => {
    const base = normalizeGroups(undefined);
    const { groups, group } = addGroup(base, '  RL  ', 'id1', 5);
    expect(group).toEqual({ id: 'id1', name: 'RL', color: 'green', order: 1, createdAt: 5, updatedAt: 5 });
    expect(groups).toHaveLength(2);
    expect(addGroup(groups, 'Agent', 'id2', 6).group).toMatchObject({ color: 'blue', order: 2 });
  });

  it('同名（不区分大小写）时返回已有分组', () => {
    const { groups } = addGroup(normalizeGroups(undefined), 'RL', 'id1', 5);
    const again = addGroup(groups, 'rl', 'id2', 6);
    expect(again.group.id).toBe('id1');
    expect(again.groups).toBe(groups);
  });
});

describe('mergeGroups', () => {
  it('同 id 取较新的名称和颜色；同名不同 id 视为同一个；其余追加', () => {
    const local = [g('to-read', { order: 0 }), g('a', { name: 'A', updatedAt: 5 }), g('b', { name: 'Shared', order: 2 })];
    const incoming = [
      g('a', { name: 'A2', color: 'pink', updatedAt: 9, order: 7 }),
      g('b2', { name: 'shared' }),
      g('c', { name: 'New' }),
    ];
    const m = mergeGroups(local, incoming);
    expect(m.groups.map((x) => [x.id, x.name, x.order])).toEqual([
      ['to-read', 'to-read', 0], ['a', 'A2', 1], ['b', 'Shared', 2], ['c', 'New', 3],
    ]);
    expect(m.idMap.get('b2')).toBe('b');
    expect(m.added).toBe(1);
    expect(m.changed).toBe(true);
  });

  it('备份里较旧的改名不覆盖本地；完全相同时不算变化', () => {
    const local = [g('to-read', { order: 0 }), g('a', { name: 'Mine', updatedAt: 9 })];
    const m = mergeGroups(local, [g('a', { name: 'Theirs', updatedAt: 3 }), g('to-read', { order: 0 })]);
    expect(m.groups[1]!.name).toBe('Mine');
    expect(m.changed).toBe(false);
  });
});

it('mergeShelves：分组取并集，标记取较新的，加入时间取较早的', () => {
  const local = { groups: ['a', 'to-read'], flagged: false, addedAt: 50, updatedAt: 5 };
  const incoming = { groups: ['b', 'a'], flagged: true, addedAt: 20, updatedAt: 9 };
  expect(mergeShelves(local, incoming)).toEqual({ groups: ['a', 'to-read', 'b'], flagged: true, addedAt: 20, updatedAt: 9 });
  // 本地较新：标记保留本地；没有加入时间的一方不参与
  expect(mergeShelves({ ...local, updatedAt: 10 }, { ...incoming, addedAt: 0 })).toMatchObject({ flagged: false, addedAt: 50 });
});

it('toShelf 校验并去重', () => {
  expect(toShelf({ groups: ['a', 'a', 3, ''], flagged: 'yes' })).toEqual({ groups: ['a'], flagged: false, addedAt: 0, updatedAt: 0 });
  expect(toShelf({ flagged: true })).toBeNull();
});
