import { TO_READ_ID, type Group, type Shelf } from './groups';
import type { PaperMeta } from './paper';

/**
 * 删除记录（tombstone）：云同步时靠它把"删除"传到其他电脑，否则对方的副本会把删掉的内容合并回来。
 * 只记 id 和删除时间；合并时，删除时间不早于内容最后修改时间的，视为已删除。
 *
 * - `tomb:<paperId>`：整篇论文从论文库移除的时间，以及其中各条笔记的删除时间
 * - `groups-deleted`：分组的删除时间。两台电脑各自新建了同名分组时，合并掉的那个记下 mergedInto，
 *   论文上残留的旧 id 据此换成保留下来的分组
 *
 * 这里只放纯逻辑，读写 storage 在 storage.ts。
 */

export const TOMB_PREFIX = 'tomb:';
export const DELETED_GROUPS_KEY = 'groups-deleted';
/** 删除记录保留半年；超过半年没同步过的电脑上，已删除的内容可能会被同步回来 */
export const TOMB_TTL = 180 * 24 * 3600 * 1000;

export interface PaperTomb {
  /** 整篇论文从论文库移除的时间 */
  paper?: number;
  /** 笔记 id → 删除时间 */
  annotations: Record<string, number>;
}

export interface GroupTomb {
  at: number;
  /** 因同名被合并时，保留下来的分组 id */
  mergedInto?: string;
}

export type GroupTombs = Record<string, GroupTomb>;

export const emptyTomb = (): PaperTomb => ({ annotations: {} });

export const isEmptyTomb = (t: PaperTomb) => !t.paper && !Object.keys(t.annotations).length;

export function toPaperTomb(x: unknown): PaperTomb {
  const out = emptyTomb();
  if (!isObj(x)) return out;
  if (isTime(x.paper)) out.paper = x.paper;
  if (isObj(x.annotations)) {
    for (const [id, t] of Object.entries(x.annotations)) if (id && isTime(t)) out.annotations[id] = t;
  }
  return out;
}

export function toGroupTombs(x: unknown): GroupTombs {
  const out: GroupTombs = {};
  if (!isObj(x)) return out;
  for (const [id, t] of Object.entries(x)) {
    if (!id || id === TO_READ_ID || !isObj(t) || !isTime(t.at)) continue;
    out[id] = typeof t.mergedInto === 'string' && t.mergedInto ? { at: t.at, mergedInto: t.mergedInto } : { at: t.at };
  }
  return out;
}

const paperAt = (t: PaperTomb) => t.paper ?? -1;

export const annotationDeleted = (t: PaperTomb, a: { id: string; updatedAt: number }) =>
  paperAt(t) >= a.updatedAt || (t.annotations[a.id] ?? -1) >= a.updatedAt;

/** 移除论文之后又打开过的，元数据保留 */
export const metaDeleted = (t: PaperTomb, m: PaperMeta) => paperAt(t) >= m.lastOpenedAt;

/** 移除论文之后重新加入或改过分组的，保留 */
export const shelfDeleted = (t: PaperTomb, s: Shelf) => paperAt(t) >= Math.max(s.addedAt, s.updatedAt);

/** 「待读」不可删除 */
export const groupDeleted = (tombs: GroupTombs, g: Group) =>
  g.id !== TO_READ_ID && (tombs[g.id]?.at ?? -1) >= g.updatedAt;

/** 内容被删除后又手动恢复（如导入备份）时用的修改时间：晚于删除时间，保证同步时不会再被删掉 */
export const reviveTime = (deletedAt: number, now: number) => Math.max(now, deletedAt + 1);

const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
