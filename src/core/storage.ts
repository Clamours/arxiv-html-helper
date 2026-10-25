import { browser } from 'wxt/browser';
import { META_PREFIX, NOTE_PREFIX, PAPER_PREFIX, shelfFor, toPaperNote, type PaperNote } from './library';
import type { ApiMeta } from './arxiv-api';
import {
  addGroup,
  defaultShelf,
  GROUPS_KEY,
  normalizeGroups,
  SHELF_PREFIX,
  toRating,
  type Group,
  type Shelf,
} from './groups';
import { mergeApiMeta, mergePageMeta, type PaperMeta } from './paper';
import { DELETED_GROUPS_KEY, TOMB_PREFIX, toGroupTombs, toPaperTomb, type PaperTomb } from './tombstones';
import type { Annotation } from './types';

const keyOf = (paperId: string) => `${PAPER_PREFIX}${paperId}`;
const metaKeyOf = (paperId: string) => `${META_PREFIX}${paperId}`;
const shelfKeyOf = (paperId: string) => `${SHELF_PREFIX}${paperId}`;
const noteKeyOf = (paperId: string) => `${NOTE_PREFIX}${paperId}`;
const tombKeyOf = (paperId: string) => `${TOMB_PREFIX}${paperId}`;

export async function loadAnnotations(paperId: string): Promise<Annotation[]> {
  const key = keyOf(paperId);
  const got = await browser.storage.local.get(key);
  return (got[key] as Annotation[] | undefined) ?? [];
}

async function save(paperId: string, list: Annotation[]): Promise<void> {
  const key = keyOf(paperId);
  if (list.length) await browser.storage.local.set({ [key]: list });
  else await browser.storage.local.remove(key);
}

// 同一页面内的写操作串行化，避免读-改-写交错
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

function mutate(paperId: string, fn: (list: Annotation[]) => Annotation[]): Promise<void> {
  return serial(async () => save(paperId, fn(await loadAnnotations(paperId))));
}

export function addAnnotation(ann: Annotation): Promise<void> {
  return mutate(ann.paperId, (list) => [...list, ann]);
}

export function updateAnnotation(
  paperId: string,
  id: string,
  patch: Partial<Pick<Annotation, 'color' | 'note'>>,
): Promise<void> {
  return mutate(paperId, (list) =>
    list.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a)),
  );
}

/** 删除笔记，并记下删除时间（云同步时据此在其他电脑上删除） */
export function deleteAnnotation(paperId: string, id: string): Promise<void> {
  return serial(async () => {
    const key = keyOf(paperId);
    const tombKey = tombKeyOf(paperId);
    const cur = await browser.storage.local.get([key, tombKey]);
    const list = ((cur[key] as Annotation[] | undefined) ?? []).filter((a) => a.id !== id);
    const tomb = toPaperTomb(cur[tombKey]);
    tomb.annotations[id] = Date.now();
    await browser.storage.local.set(list.length ? { [key]: list, [tombKey]: tomb } : { [tombKey]: tomb });
    if (!list.length) await browser.storage.local.remove(key);
  });
}

/** 监听某篇论文的笔记变化（包括其他标签页、侧边栏的修改） */
export function watchAnnotations(paperId: string, cb: (list: Annotation[]) => void): () => void {
  const key = keyOf(paperId);
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) cb((changes[key]!.newValue as Annotation[] | undefined) ?? []);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// 论文库
// ---------------------------------------------------------------------------

export async function loadMeta(paperId: string): Promise<PaperMeta | null> {
  const key = metaKeyOf(paperId);
  return ((await browser.storage.local.get(key))[key] as PaperMeta | undefined) ?? null;
}

/** 论文页打开时调用：更新元数据；第一次浏览时加入论文库（不属于任何分组） */
export function recordPageMeta(fromPage: PaperMeta): Promise<void> {
  return serial(async () => {
    const metaKey = metaKeyOf(fromPage.id);
    const shelfKey = shelfKeyOf(fromPage.id);
    const cur = await browser.storage.local.get([metaKey, shelfKey, keyOf(fromPage.id)]);
    const writes: Record<string, unknown> = {
      [metaKey]: mergePageMeta((cur[metaKey] as PaperMeta | undefined) ?? null, fromPage),
    };
    // 已有记录时不再改动
    if (!cur[shelfKey]) {
      // 升级前就做过笔记的论文，加入时间取第一条笔记的时间
      writes[shelfKey] = cur[keyOf(fromPage.id)] ? shelfFor(cur, fromPage.id) : defaultShelf(fromPage.lastOpenedAt);
    }
    await browser.storage.local.set(writes);
  });
}

/** 从 arXiv API 拿到元数据后调用 */
export async function recordApiMeta(list: ApiMeta[]): Promise<void> {
  if (!list.length) return;
  const keys = list.map((m) => metaKeyOf(m.id));
  const cur = await browser.storage.local.get(keys);
  const next: Record<string, PaperMeta> = {};
  for (const m of list) next[metaKeyOf(m.id)] = mergeApiMeta((cur[metaKeyOf(m.id)] as PaperMeta | undefined) ?? null, m);
  await browser.storage.local.set(next);
}

/** 从论文库移除：删除一篇论文的全部笔记、元数据、分组和论文笔记，并记下删除时间 */
export function deletePaper(paperId: string): Promise<void> {
  return serial(async () => {
    // 整篇论文的删除时间覆盖其中各条笔记的删除记录
    const tomb: PaperTomb = { paper: Date.now(), annotations: {} };
    await browser.storage.local.set({ [tombKeyOf(paperId)]: tomb });
    await browser.storage.local.remove([keyOf(paperId), metaKeyOf(paperId), shelfKeyOf(paperId), noteKeyOf(paperId)]);
  });
}

/** 保存论文笔记；内容没变时不写。清空也会写入（见 PaperNote） */
export function setPaperNote(paperId: string, text: string): Promise<void> {
  return serial(async () => {
    const key = noteKeyOf(paperId);
    const cur = toPaperNote((await browser.storage.local.get(key))[key]);
    if ((cur?.text ?? '') === text) return;
    const note: PaperNote = { text, updatedAt: Date.now() };
    await browser.storage.local.set({ [key]: note });
  });
}

/** 论文库、分组的任何变化 */
export function watchLibrary(cb: () => void): () => void {
  const prefixes = [PAPER_PREFIX, META_PREFIX, SHELF_PREFIX, NOTE_PREFIX];
  const listener = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && Object.keys(changes).some((k) => k === GROUPS_KEY || prefixes.some((p) => k.startsWith(p)))) cb();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// 分组与标记
// ---------------------------------------------------------------------------

export async function loadGroups(): Promise<Group[]> {
  return normalizeGroups((await browser.storage.local.get(GROUPS_KEY))[GROUPS_KEY]);
}

function mutateGroups<T>(fn: (groups: Group[]) => { groups: Group[]; result: T }): Promise<T> {
  return serial(async () => {
    const { groups, result } = fn(await loadGroups());
    await browser.storage.local.set({ [GROUPS_KEY]: groups });
    return result;
  });
}

/** 新建分组；同名分组已存在时返回已有的 */
export function createGroup(name: string): Promise<Group> {
  return mutateGroups((list) => {
    const { groups, group } = addGroup(list, name, crypto.randomUUID(), Date.now());
    return { groups, result: group };
  });
}

export function updateGroup(id: string, patch: Partial<Pick<Group, 'name' | 'color'>>): Promise<void> {
  return mutateGroups((list) => ({
    groups: list.map((g) => (g.id === id ? { ...g, ...patch, updatedAt: Date.now() } : g)),
    result: undefined,
  }));
}

/** 删除分组，并把它从所有论文上移除 */
export function deleteGroup(id: string): Promise<void> {
  return serial(async () => {
    const all = await browser.storage.local.get(null);
    const now = Date.now();
    const writes: Record<string, unknown> = {
      [GROUPS_KEY]: normalizeGroups(all[GROUPS_KEY]).filter((g) => g.id !== id),
      [DELETED_GROUPS_KEY]: { ...toGroupTombs(all[DELETED_GROUPS_KEY]), [id]: { at: now } },
    };
    for (const [key, value] of Object.entries(all)) {
      const shelf = value as Shelf;
      if (key.startsWith(SHELF_PREFIX) && Array.isArray(shelf?.groups) && shelf.groups.includes(id)) {
        writes[key] = { ...shelf, groups: shelf.groups.filter((g) => g !== id), updatedAt: now };
      }
    }
    // 一次写入，避免出现分组已删除、论文上还挂着的中间状态
    await browser.storage.local.set(writes);
  });
}

/** 论文的分组、标记和评分（没有记录时为默认值） */
export async function loadShelf(paperId: string): Promise<Shelf> {
  const all = await browser.storage.local.get([shelfKeyOf(paperId), metaKeyOf(paperId), keyOf(paperId)]);
  return shelfFor(all, paperId);
}

function mutateShelf(paperId: string, fn: (s: Shelf) => Shelf): Promise<void> {
  return serial(async () => {
    const next = fn(await loadShelf(paperId));
    await browser.storage.local.set({ [shelfKeyOf(paperId)]: { ...next, updatedAt: Date.now() } });
  });
}

export function setInGroup(paperId: string, groupId: string, on: boolean): Promise<void> {
  return mutateShelf(paperId, (s) => ({
    ...s,
    groups: on ? [...new Set([...s.groups, groupId])] : s.groups.filter((g) => g !== groupId),
  }));
}

export function setFlagged(paperId: string, flagged: boolean): Promise<void> {
  return mutateShelf(paperId, (s) => ({ ...s, flagged }));
}

/** rating 为 0 时清除评分 */
export function setRating(paperId: string, rating: number): Promise<void> {
  return mutateShelf(paperId, (s) => ({ ...s, rating: toRating(rating) }));
}

// ---------------------------------------------------------------------------
// 译文存档的显示开关（每台电脑各自设置，不同步）
// ---------------------------------------------------------------------------

export const SAVED_VISIBLE_KEY = 'saved-translations:visible';

export async function loadSavedVisible(): Promise<boolean> {
  return (await browser.storage.local.get(SAVED_VISIBLE_KEY))[SAVED_VISIBLE_KEY] !== false;
}

export async function setSavedVisible(visible: boolean): Promise<void> {
  await browser.storage.local.set({ [SAVED_VISIBLE_KEY]: visible });
}

export function watchSavedVisible(cb: (visible: boolean) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && SAVED_VISIBLE_KEY in changes) cb(changes[SAVED_VISIBLE_KEY]!.newValue !== false);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// 备份与迁移
// ---------------------------------------------------------------------------

export async function readAll(): Promise<Record<string, unknown>> {
  return browser.storage.local.get(null);
}

/** 一次写入多个键（一次 set 调用，要么全部写入要么全部失败） */
export async function writeMany(items: Record<string, unknown>): Promise<void> {
  if (Object.keys(items).length) await browser.storage.local.set(items);
}
