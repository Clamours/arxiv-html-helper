import { COLORS, type HighlightColor } from './types';

/**
 * 分组：一篇论文可以属于多个分组（相当于标签），另外可以单独"标记"和评分。
 * - `groups`：全部分组的定义。论文按 id 引用分组，重命名只改这一处
 * - `shelf:<paperId>`：这篇论文属于哪些分组、是否标记、评几星
 *
 * 浏览过的论文加入论文库时不属于任何分组。没有 shelf 记录的论文（升级前的旧数据）按 defaultShelf 处理。
 * 这里只放纯逻辑，读写 storage 在 storage.ts。
 */

export const GROUPS_KEY = 'groups';
export const SHELF_PREFIX = 'shelf:';

export type GroupColor = HighlightColor | 'gray';
export const GROUP_COLORS: GroupColor[] = [...COLORS, 'gray'];

export interface Group {
  id: string;
  name: string;
  color: GroupColor;
  /** 侧栏里的顺序，从小到大 */
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Shelf {
  /** Group.id；可能残留已删除分组的 id，展示时按现有分组过滤 */
  groups: string[];
  flagged: boolean;
  /** 1–5 星；0 表示未评分（旧数据没有这个字段） */
  rating: number;
  /** 加入论文库的时间 */
  addedAt: number;
  /** 最近一次修改分组、标记或评分的时间；0 表示从未手动改过 */
  updatedAt: number;
}

export const MAX_RATING = 5;

export function defaultShelf(addedAt: number): Shelf {
  return { groups: [], flagged: false, rating: 0, addedAt, updatedAt: 0 };
}

/** 1–5 的整数原样保留，其余视为未评分 */
export const toRating = (x: unknown): number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= MAX_RATING ? x : 0;

/** 校验、去重、排序 */
export function normalizeGroups(value: unknown): Group[] {
  const byId = new Map<string, Group>();
  if (Array.isArray(value)) {
    for (const x of value) {
      const g = toGroup(x);
      if (g && !byId.has(g.id)) byId.set(g.id, g);
    }
  }
  return [...byId.values()].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export function toGroup(x: unknown): Group | null {
  if (!isObj(x) || typeof x.id !== 'string' || !x.id || typeof x.name !== 'string' || !x.name.trim()) return null;
  return {
    id: x.id,
    name: x.name.trim(),
    color: GROUP_COLORS.includes(x.color as GroupColor) ? (x.color as GroupColor) : 'gray',
    order: num(x.order),
    createdAt: num(x.createdAt),
    updatedAt: num(x.updatedAt),
  };
}

export function toShelf(x: unknown): Shelf | null {
  if (!isObj(x) || !Array.isArray(x.groups)) return null;
  return {
    groups: [...new Set(x.groups.filter((g): g is string => typeof g === 'string' && !!g))],
    flagged: x.flagged === true,
    rating: toRating(x.rating),
    addedAt: num(x.addedAt),
    updatedAt: num(x.updatedAt),
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findGroupByName(groups: Group[], name: string): Group | undefined {
  return groups.find((g) => sameName(g.name, name));
}

/** 新建分组；同名（不区分大小写）的分组已存在时直接返回它 */
export function addGroup(groups: Group[], name: string, id: string, now: number): { groups: Group[]; group: Group } {
  const existing = findGroupByName(groups, name);
  if (existing) return { groups, group: existing };
  const group: Group = {
    id,
    name: name.trim(),
    // 依次使用划线的几种颜色，相邻分组颜色不同
    color: COLORS[groups.length % COLORS.length]!,
    order: Math.max(0, ...groups.map((g) => g.order)) + 1,
    createdAt: now,
    updatedAt: now,
  };
  return { groups: [...groups, group], group };
}

// ---------------------------------------------------------------------------
// 导入合并：只增不删
// ---------------------------------------------------------------------------

export interface GroupMerge {
  groups: Group[];
  /** 备份里的分组 id → 本地分组 id（两边各自新建了同名分组时不同） */
  idMap: Map<string, string>;
  added: number;
  changed: boolean;
}

/** 同 id 的分组取修改时间较新的一份；id 不同但同名的视为同一个分组；其余追加到末尾 */
export function mergeGroups(local: Group[], incoming: Group[]): GroupMerge {
  const out = local.map((g) => ({ ...g }));
  const idMap = new Map<string, string>();
  let added = 0;
  let changed = false;
  let nextOrder = Math.max(0, ...out.map((g) => g.order)) + 1;
  for (const g of [...incoming].sort((a, b) => a.order - b.order)) {
    const same = out.findIndex((x) => x.id === g.id);
    if (same >= 0) {
      idMap.set(g.id, g.id);
      const mine = out[same]!;
      if (g.updatedAt > mine.updatedAt && (g.name !== mine.name || g.color !== mine.color)) {
        // 顺序保持本地的
        out[same] = { ...mine, name: g.name, color: g.color, updatedAt: g.updatedAt };
        changed = true;
      }
      continue;
    }
    const named = findGroupByName(out, g.name);
    if (named) {
      idMap.set(g.id, named.id);
      continue;
    }
    out.push({ ...g, order: nextOrder++ });
    idMap.set(g.id, g.id);
    added++;
    changed = true;
  }
  return { groups: out, idMap, added, changed };
}

/** 分组取并集；标记和评分取修改时间较新的一方；加入时间取较早的 */
export function mergeShelves(local: Shelf, incoming: Shelf): Shelf {
  const newer = incoming.updatedAt > local.updatedAt ? incoming : local;
  const added = [local.addedAt, incoming.addedAt].filter(Boolean);
  return {
    groups: [...new Set([...local.groups, ...incoming.groups])],
    flagged: newer.flagged,
    rating: newer.rating,
    addedAt: added.length ? Math.min(...added) : 0,
    updatedAt: Math.max(local.updatedAt, incoming.updatedAt),
  };
}

export const sameShelf = (a: Shelf, b: Shelf) =>
  a.flagged === b.flagged &&
  a.rating === b.rating &&
  a.addedAt === b.addedAt &&
  a.updatedAt === b.updatedAt &&
  a.groups.length === b.groups.length &&
  a.groups.every((g) => b.groups.includes(g));

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
