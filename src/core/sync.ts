import { BACKUP_FORMAT, BACKUP_VERSION, toAnnotation, toMeta, type BackupFile, type ParsedBackup } from './backup';
import { GROUPS_KEY, normalizeGroups, SHELF_PREFIX, TO_READ_ID, toShelf, type Group, type Shelf } from './groups';
import { META_PREFIX, PAPER_PREFIX } from './library';
import { pickDoc, type PaperMeta } from './paper';
import {
  annotationDeleted,
  DELETED_GROUPS_KEY,
  emptyTomb,
  groupDeleted,
  isEmptyTomb,
  metaDeleted,
  shelfDeleted,
  TOMB_PREFIX,
  TOMB_TTL,
  toGroupTombs,
  toPaperTomb,
  type GroupTombs,
  type PaperTomb,
} from './tombstones';
import type { Annotation } from './types';

/**
 * 云同步的数据模型和合并规则。云端只放一个文件（备份格式 + 删除记录），每次同步：
 * 下载 → 与本地合并 → 把合并结果写回本地和云端。这里只放纯逻辑，读写 storage 和云端在 src/sync/。
 *
 * 合并规则（两边对称，合并结果与先后顺序无关）：
 * - 笔记、分组定义、论文的分组和标记：各自按修改时间，较新的一份胜出
 * - 元数据：标题作者 API 来源优先，打开时间取较晚的
 * - 删除：删除时间不早于修改时间的视为已删除，见 tombstones.ts
 * - 两台电脑各自新建的同名分组合并为一个：保留先建的，论文上的另一个 id 换成它
 */

export interface SyncPaper {
  id: string;
  meta: PaperMeta | null;
  /** 没有记录时为 null（论文库按默认值显示） */
  shelf: Shelf | null;
  annotations: Annotation[];
  tomb: PaperTomb;
}

export interface SyncData {
  groups: Group[];
  deletedGroups: GroupTombs;
  papers: Map<string, SyncPaper>;
}

export const emptySyncData = (): SyncData => ({ groups: normalizeGroups([]), deletedGroups: {}, papers: new Map() });

const PREFIXES = [PAPER_PREFIX, META_PREFIX, SHELF_PREFIX, TOMB_PREFIX];

/** 需要同步的 storage 键 */
export const isSyncedKey = (key: string) =>
  key === GROUPS_KEY || key === DELETED_GROUPS_KEY || PREFIXES.some((p) => key.startsWith(p));

/** 从 storage 的全部内容提取需要同步的数据 */
export function fromStorage(all: Record<string, unknown>): SyncData {
  const ids = new Set<string>();
  for (const key of Object.keys(all)) {
    for (const prefix of PREFIXES) if (key.startsWith(prefix) && key.length > prefix.length) ids.add(key.slice(prefix.length));
  }
  const papers = new Map<string, SyncPaper>();
  for (const id of ids) {
    const list = all[PAPER_PREFIX + id];
    const p: SyncPaper = {
      id,
      meta: toMeta(all[META_PREFIX + id], id),
      shelf: toShelf(all[SHELF_PREFIX + id]),
      annotations: Array.isArray(list) ? list.map((a) => toAnnotation(a, id)).filter((a): a is Annotation => !!a) : [],
      tomb: toPaperTomb(all[TOMB_PREFIX + id]),
    };
    if (!isEmptyPaper(p)) papers.set(id, p);
  }
  return { groups: normalizeGroups(all[GROUPS_KEY]), deletedGroups: toGroupTombs(all[DELETED_GROUPS_KEY]), papers };
}

/** 从云端文件（备份格式）提取 */
export function fromBackup(parsed: ParsedBackup): SyncData {
  const papers = new Map<string, SyncPaper>();
  const add = (p: SyncPaper) => {
    const prev = papers.get(p.id);
    papers.set(p.id, prev ? mergePaper(prev, p) : p);
  };
  for (const p of parsed.papers) add({ id: p.id, meta: p.meta, shelf: p.shelf, annotations: p.annotations, tomb: emptyTomb() });
  for (const [id, tomb] of Object.entries(parsed.deleted.papers)) add({ id, meta: null, shelf: null, annotations: [], tomb });
  return { groups: normalizeGroups(parsed.groups), deletedGroups: parsed.deleted.groups, papers };
}

/** 生成云端文件；也是合法的备份文件 */
export function toSyncFile(d: SyncData, extensionVersion: string, now = new Date()): BackupFile {
  const papers = [...d.papers.values()].sort((a, b) => a.id.localeCompare(b.id));
  const tombs: Record<string, PaperTomb> = {};
  for (const p of papers) if (!isEmptyTomb(p.tomb)) tombs[p.id] = p.tomb;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    extensionVersion,
    groups: normalizeGroups(d.groups),
    papers: papers
      .filter((p) => p.meta || p.shelf || p.annotations.length)
      .map((p) => ({ id: p.id, meta: p.meta, annotations: sortAnnotations(p.annotations), shelf: p.shelf })),
    deleted: { papers: tombs, groups: d.deletedGroups },
  };
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

export function mergeSync(a: SyncData, b: SyncData, now = Date.now()): SyncData {
  const deletedGroups: GroupTombs = { ...a.deletedGroups };
  for (const [id, t] of Object.entries(b.deletedGroups)) {
    const prev = deletedGroups[id];
    deletedGroups[id] = prev ? newer(prev, t, (x) => x.at) : t;
  }

  const byId = new Map<string, Group>();
  for (const g of [...a.groups, ...b.groups]) {
    const prev = byId.get(g.id);
    byId.set(g.id, prev ? newer(prev, g, (x) => x.updatedAt) : g);
  }
  let groups = [...byId.values()].filter((g) => !groupDeleted(deletedGroups, g));

  // 同名分组：「待读」优先，其次先建的，再按 id，保证两台电脑选出同一个
  const byName = new Map<string, Group[]>();
  for (const g of groups) {
    const name = g.name.trim().toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), g]);
  }
  const merged = new Set<string>();
  for (const same of byName.values()) {
    if (same.length < 2) continue;
    same.sort((x, y) => Number(y.id === TO_READ_ID) - Number(x.id === TO_READ_ID) || x.createdAt - y.createdAt || cmp(x.id, y.id));
    for (const loser of same.slice(1)) {
      deletedGroups[loser.id] = { at: Math.max(now, loser.updatedAt), mergedInto: same[0]!.id };
      merged.add(loser.id);
    }
  }
  groups = groups.filter((g) => !merged.has(g.id));

  const live = new Set(groups.map((g) => g.id));
  /** 论文上的分组 id → 现在对应的分组；已删除的返回 null。不认识的 id 原样保留 */
  const resolve = (id: string): string | null => {
    let cur = id;
    for (let i = 0; i < 8; i++) {
      if (live.has(cur)) return cur;
      const t = deletedGroups[cur];
      if (!t) return cur === id ? id : null;
      if (!t.mergedInto) return null;
      cur = t.mergedInto;
    }
    return null;
  };

  const papers = new Map<string, SyncPaper>();
  for (const id of new Set([...a.papers.keys(), ...b.papers.keys()])) {
    const pa = a.papers.get(id);
    const pb = b.papers.get(id);
    const p = pa && pb ? mergePaper(pa, pb) : (pa ?? pb)!;
    const annotations = p.annotations.filter((x) => !annotationDeleted(p.tomb, x));
    const meta = p.meta && !metaDeleted(p.tomb, p.meta) ? p.meta : null;
    let shelf = p.shelf && !shelfDeleted(p.tomb, p.shelf) ? p.shelf : null;
    if (shelf) {
      const ids = [...new Set(shelf.groups.map(resolve).filter((g): g is string => !!g))];
      if (!sameSet(ids, shelf.groups)) shelf = { ...shelf, groups: ids };
    }
    const next: SyncPaper = { id, meta, shelf, annotations, tomb: pruneTomb(p.tomb, now) };
    if (!isEmptyPaper(next)) papers.set(id, next);
  }

  for (const [id, t] of Object.entries(deletedGroups)) if (now - t.at > TOMB_TTL) delete deletedGroups[id];
  return { groups: normalizeGroups(groups), deletedGroups, papers };
}

/** 同一篇论文的两份数据合并（尚未按删除记录过滤） */
function mergePaper(a: SyncPaper, b: SyncPaper): SyncPaper {
  const anns = new Map(a.annotations.map((x) => [x.id, x]));
  for (const x of b.annotations) {
    const prev = anns.get(x.id);
    anns.set(x.id, prev ? newer(prev, x, (y) => y.updatedAt) : x);
  }
  const tomb: PaperTomb = { annotations: { ...a.tomb.annotations } };
  if (a.tomb.paper || b.tomb.paper) tomb.paper = Math.max(a.tomb.paper ?? 0, b.tomb.paper ?? 0);
  for (const [id, t] of Object.entries(b.tomb.annotations)) tomb.annotations[id] = Math.max(tomb.annotations[id] ?? 0, t);
  return {
    id: a.id,
    meta: mergeMeta(a.meta, b.meta),
    shelf: mergeShelf(a.shelf, b.shelf),
    annotations: sortAnnotations([...anns.values()]),
    tomb,
  };
}

/** 标题作者 API 来源优先，同来源取最近打开的；版本取最近打开的；打开时间取较晚的 */
function mergeMeta(a: PaperMeta | null, b: PaperMeta | null): PaperMeta | null {
  if (!a || !b) return a ?? b;
  const rank = (m: PaperMeta) => (m.source === 'api' ? 1 : 0);
  const opened = newer(a, b, (m) => m.lastOpenedAt);
  const base = rank(a) === rank(b) ? opened : rank(a) > rank(b) ? a : b;
  const other = base === a ? b : a;
  const published = base.published ?? other.published;
  const doc = pickDoc(a.doc, b.doc);
  return {
    ...base,
    version: opened.version || base.version,
    lastOpenedAt: Math.max(a.lastOpenedAt, b.lastOpenedAt),
    ...(published ? { published } : {}),
    ...(doc ? { doc } : {}),
  };
}

/** 修改时间较新的一份胜出；同时修改（包括都从未手动改过）时分组取并集、标记任一方即可；加入时间取较早的 */
function mergeShelf(a: Shelf | null, b: Shelf | null): Shelf | null {
  if (!a || !b) return a ?? b;
  const added = [a.addedAt, b.addedAt].filter(Boolean);
  const addedAt = added.length ? Math.min(...added) : 0;
  if (a.updatedAt !== b.updatedAt) return { ...(a.updatedAt > b.updatedAt ? a : b), addedAt };
  return {
    groups: [...new Set([...a.groups, ...b.groups])],
    flagged: a.flagged || b.flagged,
    addedAt,
    updatedAt: a.updatedAt,
  };
}

/** 去掉过期的删除记录，以及被整篇论文的删除时间覆盖的笔记删除记录 */
function pruneTomb(t: PaperTomb, now: number): PaperTomb {
  const out = emptyTomb();
  const paper = t.paper && now - t.paper <= TOMB_TTL ? t.paper : undefined;
  if (paper) out.paper = paper;
  for (const [id, at] of Object.entries(t.annotations)) {
    if (now - at <= TOMB_TTL && at > (paper ?? 0)) out.annotations[id] = at;
  }
  return out;
}

/** 按 time 取较新的；时间相同时按内容取一个确定的，保证两台电脑结果一致 */
function newer<T>(a: T, b: T, time: (x: T) => number): T {
  const d = time(a) - time(b);
  if (d) return d > 0 ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

const isEmptyPaper = (p: SyncPaper) => !p.meta && !p.shelf && !p.annotations.length && isEmptyTomb(p.tomb);

const sortAnnotations = (list: Annotation[]) => [...list].sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// 比较与写回本地
// ---------------------------------------------------------------------------

/** 规范化后的序列化结果：内容相同则相同，与数组顺序、对象键顺序无关 */
export function fingerprint(d: SyncData): string {
  return stableStringify({
    groups: [...d.groups].sort((a, b) => cmp(a.id, b.id)),
    deletedGroups: d.deletedGroups,
    papers: [...d.papers.values()].sort((a, b) => cmp(a.id, b.id)).map(canonicalPaper),
  });
}

function canonicalPaper(p: SyncPaper) {
  return {
    id: p.id,
    meta: p.meta,
    shelf: canonicalShelf(p.shelf),
    annotations: [...p.annotations].sort((a, b) => cmp(a.id, b.id)),
    tomb: p.tomb,
  };
}

const canonicalShelf = (s: Shelf | null) => (s ? { ...s, groups: [...s.groups].sort() } : null);

export interface LocalChanges {
  added: number;
  updated: number;
  removed: number;
  /** 论文库、分组、标记等其他有变化的键数 */
  other: number;
}

export interface LocalPlan {
  set: Record<string, unknown>;
  remove: string[];
  changes: LocalChanges;
}

/** 把本地改成合并结果需要的写入；只写有变化的键 */
export function planLocalWrites(all: Record<string, unknown>, merged: SyncData): LocalPlan {
  const local = fromStorage(all);
  const plan: LocalPlan = { set: {}, remove: [], changes: { added: 0, updated: 0, removed: 0, other: 0 } };
  const put = (key: string, before: unknown, after: unknown, other = true) => {
    if (stableStringify(before) === stableStringify(after)) return;
    if (after === null) {
      if (key in all) plan.remove.push(key);
    } else plan.set[key] = after;
    if (other) plan.changes.other++;
  };

  for (const id of new Set([...local.papers.keys(), ...merged.papers.keys()])) {
    const l = local.papers.get(id);
    const m = merged.papers.get(id);
    const before = new Map((l?.annotations ?? []).map((a) => [a.id, a]));
    const after = new Map((m?.annotations ?? []).map((a) => [a.id, a]));
    for (const [aid, a] of after) {
      const prev = before.get(aid);
      if (!prev) plan.changes.added++;
      else if (stableStringify(prev) !== stableStringify(a)) plan.changes.updated++;
    }
    for (const aid of before.keys()) if (!after.has(aid)) plan.changes.removed++;
    const sortedById = (x: Map<string, Annotation>) => [...x.values()].sort((a, b) => cmp(a.id, b.id));
    if (stableStringify(sortedById(before)) !== stableStringify(sortedById(after))) {
      if (after.size) plan.set[PAPER_PREFIX + id] = sortAnnotations([...after.values()]);
      else if (PAPER_PREFIX + id in all) plan.remove.push(PAPER_PREFIX + id);
    }
    put(META_PREFIX + id, l?.meta ?? null, m?.meta ?? null);
    if (stableStringify(canonicalShelf(l?.shelf ?? null)) !== stableStringify(canonicalShelf(m?.shelf ?? null))) {
      put(SHELF_PREFIX + id, l?.shelf ?? null, m?.shelf ?? null);
    }
    const tomb = (p?: SyncPaper) => (p && !isEmptyTomb(p.tomb) ? p.tomb : null);
    put(TOMB_PREFIX + id, tomb(l), tomb(m), false);
  }

  const byId = (g: Group[]) => [...g].sort((a, b) => cmp(a.id, b.id));
  if (stableStringify(byId(local.groups)) !== stableStringify(byId(merged.groups))) {
    plan.set[GROUPS_KEY] = merged.groups;
    plan.changes.other++;
  }
  const dg = (t: GroupTombs) => (Object.keys(t).length ? t : null);
  put(DELETED_GROUPS_KEY, dg(local.deletedGroups), dg(merged.deletedGroups), false);
  return plan;
}

/** JSON 序列化，对象的键排序；undefined 的属性和 JSON.stringify 一样忽略 */
export function stableStringify(x: unknown): string {
  if (x === undefined) return 'null';
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`;
  const entries = Object.entries(x as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => cmp(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
