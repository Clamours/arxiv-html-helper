import { defaultShelf, SHELF_PREFIX, toShelf, type Group, type Shelf } from './groups';
import { isImportedId, paperUrl, type PaperMeta } from './paper';
import type { Annotation } from './types';

/**
 * 论文库：由 storage 里的 `paper:<id>`（笔记）、`meta:<id>`（标题等）和
 * `shelf:<id>`（分组、标记，见 groups.ts）拼成。
 * 这里只放纯逻辑，方便单测；读写 storage 在 storage.ts。
 */

export const PAPER_PREFIX = 'paper:';
export const META_PREFIX = 'meta:';

export interface LibraryEntry {
  id: string;
  /** 旧数据可能没有：论文库页会从 arXiv API 补全，打开论文页也会补上 */
  meta: PaperMeta | null;
  annotations: Annotation[];
  /** 没有 shelf 记录时为默认值（不属于任何分组） */
  shelf: Shelf;
  /** 打开论文时用的版本：最近打开的版本，否则最近一条笔记的版本 */
  version: string;
  /** 最近一次笔记改动时间；没有笔记时为 0 */
  lastNoteAt: number;
}

/** 收录浏览过（有 meta）、做过笔记或手动分过组的论文 */
export function groupLibrary(all: Record<string, unknown>): LibraryEntry[] {
  const ids = new Set<string>();
  for (const key of Object.keys(all)) {
    for (const prefix of [PAPER_PREFIX, META_PREFIX, SHELF_PREFIX]) {
      if (key.startsWith(prefix) && key.length > prefix.length) ids.add(key.slice(prefix.length));
    }
  }
  const out: LibraryEntry[] = [];
  for (const id of ids) {
    const value = all[PAPER_PREFIX + id];
    const annotations = Array.isArray(value) ? (value as Annotation[]) : [];
    const meta = (all[META_PREFIX + id] as PaperMeta | undefined) ?? null;
    const shelf = toShelf(all[SHELF_PREFIX + id]);
    if (!annotations.length && !meta && !shelf) continue;
    const latest = annotations.length ? annotations.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a)) : null;
    out.push({
      id,
      meta,
      annotations,
      shelf: shelf ?? shelfFor(all, id),
      version: meta?.version || latest?.paperVersion || '',
      lastNoteAt: latest?.updatedAt ?? 0,
    });
  }
  return out;
}

/** 论文的分组和标记；没有记录时按默认值，加入时间取最早的打开或笔记时间 */
export function shelfFor(all: Record<string, unknown>, id: string): Shelf {
  const stored = toShelf(all[SHELF_PREFIX + id]);
  if (stored) return stored;
  const meta = all[META_PREFIX + id] as PaperMeta | undefined;
  const anns = all[PAPER_PREFIX + id];
  const times = [meta?.lastOpenedAt ?? 0, ...(Array.isArray(anns) ? (anns as Annotation[]).map((a) => a.createdAt) : [])];
  const known = times.filter((t) => t > 0);
  return defaultShelf(known.length ? Math.min(...known) : 0);
}

export const titleOf = (e: LibraryEntry) => e.meta?.title ?? e.id;

export type SortKey = 'recent-note' | 'recent-open' | 'recent-added' | 'count' | 'title';

const openedAt = (e: LibraryEntry) => e.meta?.lastOpenedAt ?? 0;

export function sortLibrary(entries: LibraryEntry[], key: SortKey): LibraryEntry[] {
  const by: Record<SortKey, (a: LibraryEntry, b: LibraryEntry) => number> = {
    'recent-note': (a, b) => b.lastNoteAt - a.lastNoteAt || openedAt(b) - openedAt(a),
    'recent-open': (a, b) => openedAt(b) - openedAt(a) || b.lastNoteAt - a.lastNoteAt,
    'recent-added': (a, b) => b.shelf.addedAt - a.shelf.addedAt || openedAt(b) - openedAt(a),
    count: (a, b) => b.annotations.length - a.annotations.length || b.lastNoteAt - a.lastNoteAt,
    title: (a, b) => titleOf(a).localeCompare(titleOf(b)),
  };
  return [...entries].sort(by[key]);
}

// ---------------------------------------------------------------------------
// 侧栏视图：全部 / 已标记 / 未分组 / 某个分组
// ---------------------------------------------------------------------------

export type View = 'all' | 'flagged' | 'ungrouped' | `group:${string}`;

export const groupView = (id: string): View => `group:${id}`;

/** 论文所在的、仍然存在的分组，按侧栏顺序 */
export function groupsOf(entry: LibraryEntry, groups: Group[]): Group[] {
  return groups.filter((g) => entry.shelf.groups.includes(g.id));
}

export function inView(entry: LibraryEntry, view: View, groups: Group[]): boolean {
  if (view === 'all') return true;
  if (view === 'flagged') return entry.shelf.flagged;
  if (view === 'ungrouped') return groupsOf(entry, groups).length === 0;
  return entry.shelf.groups.includes(view.slice('group:'.length));
}

/** 侧栏每一项的论文数 */
export function countViews(entries: LibraryEntry[], groups: Group[]): Map<View, number> {
  const counts = new Map<View, number>([['all', entries.length], ['flagged', 0], ['ungrouped', 0]]);
  for (const g of groups) counts.set(groupView(g.id), 0);
  for (const e of entries) {
    if (e.shelf.flagged) counts.set('flagged', counts.get('flagged')! + 1);
    const mine = groupsOf(e, groups);
    if (!mine.length) counts.set('ungrouped', counts.get('ungrouped')! + 1);
    for (const g of mine) counts.set(groupView(g.id), counts.get(groupView(g.id))! + 1);
  }
  return counts;
}

export interface SearchResult {
  entry: LibraryEntry;
  /** 命中关键词的笔记；关键词只命中标题/作者/id 时为空 */
  matched: Annotation[];
}

/** 不区分大小写，空格分隔的多个关键词需全部命中（可分别命中不同字段） */
export function searchLibrary(entries: LibraryEntry[], query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries.map((entry) => ({ entry, matched: [] }));
  const results: SearchResult[] = [];
  for (const entry of entries) {
    const head = [entry.id, titleOf(entry), ...(entry.meta?.authors ?? [])].join('\n').toLowerCase();
    const texts = entry.annotations.map((a) => `${quoteOf(a)}\n${a.note}`.toLowerCase());
    const all = `${head}\n${texts.join('\n')}`;
    if (!terms.every((t) => all.includes(t))) continue;
    const matched = entry.annotations.filter((_, i) => terms.some((t) => texts[i]!.includes(t)));
    results.push({ entry, matched });
  }
  return results;
}

export function quoteOf(a: Annotation): string {
  return a.segments.map((s) => s.quote.exact).join(' … ');
}

/**
 * 不打开论文页时，按块 key 近似还原文档顺序：
 * 摘要等无章节前缀的 → 正文 S* → 附录 A* → 参考文献 bib*，同类内按数字自然排序。
 */
export function sortByDocumentOrder(anns: Annotation[]): Annotation[] {
  const rank = (key: string) => {
    const id = key.replace(/^#/, '');
    if (/^S\d/.test(id)) return 1;
    if (/^A\d/.test(id)) return 2;
    if (id.startsWith('bib')) return 3;
    return 0;
  };
  const cmp = (a: Annotation, b: Annotation) => {
    const ka = a.segments[0]?.blockKey ?? '';
    const kb = b.segments[0]?.blockKey ?? '';
    return (
      rank(ka) - rank(kb) ||
      ka.localeCompare(kb, 'en', { numeric: true }) ||
      (a.segments[0]?.position.start ?? 0) - (b.segments[0]?.position.start ?? 0) ||
      a.createdAt - b.createdAt
    );
  };
  return [...anns].sort(cmp);
}

export function toMarkdown(p: { id: string; version: string; title?: string }, anns: Annotation[]): string {
  const imported = isImportedId(p.id);
  const label = imported ? '导入的 PDF' : `arXiv ${p.id}${p.version}`;
  const heading = p.title ? `${p.title}（${label}）` : label;
  // 导入的论文页面只在本机，没有可分享的链接
  const lines = [`# ${heading} 笔记`, '', ...(imported ? [] : [paperUrl(p.id, p.version), ''])];
  for (const a of anns) {
    const tag = a.layer === 'translation' ? '（译文）' : '';
    lines.push(`> ${quoteOf(a).replace(/\n/g, '\n> ')}${tag}`, '');
    if (a.note) lines.push(a.note, '');
  }
  return lines.join('\n');
}

/** 多篇论文的笔记合成一份 Markdown（按传入顺序，跳过没有笔记的论文） */
export function entriesToMarkdown(entries: LibraryEntry[]): string {
  return entries
    .filter((e) => e.annotations.length)
    .map((e) => toMarkdown({ id: e.id, version: e.version, title: e.meta?.title }, sortByDocumentOrder(e.annotations)))
    .join('\n---\n\n');
}
