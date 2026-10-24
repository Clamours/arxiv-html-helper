import {
  GROUPS_KEY,
  mergeGroups,
  mergeShelves,
  normalizeGroups,
  sameShelf,
  SHELF_PREFIX,
  toGroup,
  toShelf,
  type Group,
  type Shelf,
} from './groups';
import { groupLibrary, META_PREFIX, PAPER_PREFIX, shelfFor } from './library';
import type { PaperDoc, PaperMeta } from './paper';
import {
  annotationDeleted,
  DELETED_GROUPS_KEY,
  groupDeleted,
  metaDeleted,
  reviveTime,
  shelfDeleted,
  TOMB_PREFIX,
  toGroupTombs,
  toPaperTomb,
  type GroupTombs,
  type PaperTomb,
} from './tombstones';
import { COLORS, type Annotation, type Segment } from './types';

/**
 * 插件自身的备份与迁移：无损导出全部笔记（含译文层）、分组和标记为 JSON，导入时与本地合并。
 * 这里只放纯逻辑，读写 storage 和文件在调用方。
 *
 * 云同步的文件也是这个格式（多了删除记录 deleted），可以直接当备份导入。
 *
 * 版本：1 只有笔记和元数据；2 增加分组（groups）和每篇论文的 shelf，并收录没有笔记的论文；
 * 3 增加删除记录（可选，只有云同步的文件有）。
 */

export const BACKUP_FORMAT = 'arxiv-html-notes-backup';
export const BACKUP_VERSION = 3;

export interface BackupPaper {
  id: string;
  meta: PaperMeta | null;
  annotations: Annotation[];
  /** 版本 1 的备份没有 */
  shelf: Shelf | null;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** 导出时的扩展版本，仅供排查问题 */
  extensionVersion: string;
  groups: Group[];
  papers: BackupPaper[];
  /** 删除记录，见 tombstones.ts；手动导出的备份没有 */
  deleted?: BackupDeleted;
}

export interface BackupDeleted {
  /** 论文 id → 该论文的删除记录 */
  papers: Record<string, PaperTomb>;
  groups: GroupTombs;
}

export class BackupError extends Error {}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/** 从 storage 的全部内容生成备份；收录论文库里的全部论文 */
export function createBackup(all: Record<string, unknown>, extensionVersion: string, now = new Date()): BackupFile {
  const papers: BackupPaper[] = groupLibrary(all)
    .map((e) => ({ id: e.id, meta: e.meta, annotations: e.annotations, shelf: e.shelf }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    extensionVersion,
    groups: normalizeGroups(all[GROUPS_KEY]),
    papers,
  };
}

export function backupFileName(now = new Date()): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `arxiv-html-helper-backup-${d}.json`;
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

export interface ParsedBackup {
  /** 版本 1 的备份为空 */
  groups: Group[];
  papers: BackupPaper[];
  /** 备份文件的导出时间（ISO），缺失时为空串 */
  exportedAt: string;
  /** 格式不对、被跳过的笔记条数 */
  invalid: number;
  /** 版本 3 之前的备份、手动导出的备份为空 */
  deleted: BackupDeleted;
}

export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('文件不是有效的 JSON');
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT) {
    throw new BackupError('这不是 arXiv HTML Helper 的备份文件');
  }
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    throw new BackupError('备份文件来自更新版本的插件，请先升级插件');
  }
  if (!Array.isArray(data.papers)) throw new BackupError('备份文件已损坏：缺少论文列表');

  const papers: BackupPaper[] = [];
  let invalid = 0;
  for (const p of data.papers) {
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || !Array.isArray(p.annotations)) {
      invalid += isObj(p) && Array.isArray(p.annotations) ? p.annotations.length : 1;
      continue;
    }
    const id = p.id;
    const annotations: Annotation[] = [];
    for (const a of p.annotations) {
      const ok = toAnnotation(a, id);
      if (ok) annotations.push(ok);
      else invalid++;
    }
    papers.push({ id, meta: toMeta(p.meta, id), annotations, shelf: toShelf(p.shelf) });
  }
  const groups = Array.isArray(data.groups) ? data.groups.map(toGroup).filter((g): g is Group => !!g) : [];
  return {
    groups,
    papers,
    invalid,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    deleted: toDeleted(data.deleted),
  };
}

function toDeleted(x: unknown): BackupDeleted {
  const papers: Record<string, PaperTomb> = {};
  if (isObj(x) && isObj(x.papers)) {
    for (const [id, t] of Object.entries(x.papers)) if (id) papers[id] = toPaperTomb(t);
  }
  return { papers, groups: toGroupTombs(isObj(x) ? x.groups : undefined) };
}

export function toAnnotation(a: unknown, paperId: string): Annotation | null {
  if (!isObj(a)) return null;
  const { id, layer, segments, color, note, createdAt, updatedAt, paperVersion } = a;
  if (typeof id !== 'string' || !id) return null;
  if (layer !== 'source' && layer !== 'translation') return null;
  if (!Array.isArray(segments) || !segments.length || !segments.every(isSegment)) return null;
  const created = typeof createdAt === 'number' ? createdAt : 0;
  return {
    id,
    // 以所在论文为准，避免文件被手工编辑后对不上
    paperId,
    paperVersion: typeof paperVersion === 'string' ? paperVersion : '',
    layer,
    segments: segments as Segment[],
    color: COLORS.includes(color as never) ? (color as Annotation['color']) : 'yellow',
    note: typeof note === 'string' ? note : '',
    createdAt: created,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : created,
  };
}

function isSegment(s: unknown): boolean {
  if (!isObj(s) || typeof s.blockKey !== 'string') return false;
  const { position: p, quote: q } = s;
  return (
    isObj(p) && typeof p.start === 'number' && typeof p.end === 'number' &&
    isObj(q) && typeof q.exact === 'string' && typeof q.prefix === 'string' && typeof q.suffix === 'string'
  );
}

export function toMeta(m: unknown, id: string): PaperMeta | null {
  if (!isObj(m) || typeof m.title !== 'string') return null;
  return {
    id,
    version: typeof m.version === 'string' ? m.version : '',
    title: m.title,
    authors: Array.isArray(m.authors) ? m.authors.filter((x): x is string => typeof x === 'string') : [],
    lastOpenedAt: typeof m.lastOpenedAt === 'number' ? m.lastOpenedAt : 0,
    ...(typeof m.published === 'string' ? { published: m.published } : {}),
    ...(m.source === 'api' || m.source === 'page' ? { source: m.source } : {}),
    ...(toDoc(m.doc) ? { doc: toDoc(m.doc)! } : {}),
  };
}

function toDoc(d: unknown): PaperDoc | null {
  if (!isObj(d) || typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) return null;
  if (typeof d.size !== 'number' || typeof d.importedAt !== 'number') return null;
  return { sha256: d.sha256, size: d.size, importedAt: d.importedAt, fileName: typeof d.fileName === 'string' ? d.fileName : '' };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

export interface ImportSummary {
  /** 备份里涉及的论文数 */
  papers: number;
  /** 其中本地原本没有的论文数 */
  newPapers: number;
  added: number;
  updated: number;
  /** 两边完全相同 */
  unchanged: number;
  /** 本地版本更新，保留本地 */
  keptLocal: number;
  invalid: number;
  /** 新增的分组数（同名分组视为同一个，不计入） */
  newGroups: number;
  /** 分组或标记有变化的论文数 */
  shelvesChanged: number;
}

export interface ImportPlan {
  /** 需要写入 storage 的键值；为空表示无需写入 */
  writes: Record<string, unknown>;
  summary: ImportSummary;
}

/**
 * 计算导入结果；只增不删：
 * - 笔记按 id 合并，修改时间新的一方胜出
 * - 分组定义按 id 合并（同名视为同一个分组）；论文所属分组取并集，标记取修改时间较新的
 * - 本地已删除、备份里还有的内容会恢复；它的修改时间改为导入时间，否则云同步时会按删除记录再次删掉
 */
export function planImport(current: Record<string, unknown>, parsed: ParsedBackup, now = Date.now()): ImportPlan {
  const writes: Record<string, unknown> = {};
  const summary: ImportSummary = {
    papers: 0, newPapers: 0, added: 0, updated: 0, unchanged: 0, keptLocal: 0, invalid: parsed.invalid,
    newGroups: 0, shelvesChanged: 0,
  };

  const groupMerge = mergeGroups(normalizeGroups(current[GROUPS_KEY]), parsed.groups);
  const groupTombs = toGroupTombs(current[DELETED_GROUPS_KEY]);
  if (groupMerge.changed) {
    writes[GROUPS_KEY] = groupMerge.groups.map((g) =>
      groupDeleted(groupTombs, g) ? { ...g, updatedAt: reviveTime(groupTombs[g.id]!.at, now) } : g,
    );
  }
  summary.newGroups = groupMerge.added;
  const known = new Set(groupMerge.groups.map((g) => g.id));
  const mapShelf = (s: Shelf): Shelf => ({
    ...s,
    groups: [...new Set(s.groups.map((g) => groupMerge.idMap.get(g) ?? g))].filter((g) => known.has(g)),
  });

  // 同一篇论文在文件里出现多次时先合并
  const byId = new Map<string, BackupPaper>();
  for (const p of parsed.papers) {
    const prev = byId.get(p.id);
    byId.set(p.id, prev ? {
      id: p.id,
      meta: betterMeta(prev.meta, p.meta),
      annotations: [...prev.annotations, ...p.annotations],
      shelf: prev.shelf && p.shelf ? mergeShelves(prev.shelf, p.shelf) : (prev.shelf ?? p.shelf),
    } : p);
  }

  const localIds = new Set(groupLibrary(current).map((e) => e.id));
  for (const paper of byId.values()) {
    if (!paper.annotations.length && !paper.meta && !paper.shelf) continue;
    summary.papers++;
    const isNew = !localIds.has(paper.id);
    if (isNew) summary.newPapers++;

    const tomb = toPaperTomb(current[TOMB_PREFIX + paper.id]);
    const removedAt = tomb.paper ?? 0;

    // 分组：版本 1 的备份没有分组信息，不改动本地（新论文不属于任何分组）
    if (paper.shelf) {
      const shelfKey = SHELF_PREFIX + paper.id;
      const incoming = mapShelf(paper.shelf);
      const localShelf = isNew ? null : shelfFor(current, paper.id);
      const merged = localShelf ? mergeShelves(localShelf, incoming) : incoming;
      if (!localShelf || !sameShelf(merged, localShelf)) {
        writes[shelfKey] = shelfDeleted(tomb, merged) ? { ...merged, updatedAt: reviveTime(removedAt, now) } : merged;
        if (localShelf) summary.shelvesChanged++;
      }
    }

    const key = PAPER_PREFIX + paper.id;
    const local = (current[key] as Annotation[] | undefined) ?? [];

    const merged = new Map(local.map((a) => [a.id, a]));
    let changed = false;
    for (const a of paper.annotations) {
      const mine = merged.get(a.id);
      if (!mine) {
        merged.set(a.id, a);
        summary.added++;
        changed = true;
      } else if (a.updatedAt > mine.updatedAt) {
        merged.set(a.id, a);
        summary.updated++;
        changed = true;
      } else if (a.updatedAt < mine.updatedAt) {
        summary.keptLocal++;
      } else {
        summary.unchanged++;
      }
    }
    if (changed) {
      writes[key] = [...merged.values()].map((a) =>
        annotationDeleted(tomb, a)
          ? { ...a, updatedAt: reviveTime(Math.max(removedAt, tomb.annotations[a.id] ?? 0), now) }
          : a,
      );
    }

    const metaKey = META_PREFIX + paper.id;
    const localMeta = (current[metaKey] as PaperMeta | undefined) ?? null;
    const meta = betterMeta(localMeta, paper.meta);
    if (meta && JSON.stringify(meta) !== JSON.stringify(localMeta)) {
      writes[metaKey] = metaDeleted(tomb, meta) ? { ...meta, lastOpenedAt: reviveTime(removedAt, now) } : meta;
    }
  }
  return { writes, summary };
}

/** API 来源优先于页面提取；同来源时取最近打开的一份；打开时间取两者较晚者 */
function betterMeta(a: PaperMeta | null, b: PaperMeta | null): PaperMeta | null {
  if (!a || !b) return a ?? b;
  const rank = (m: PaperMeta) => (m.source === 'api' ? 1 : 0);
  const win = rank(b) > rank(a) || (rank(b) === rank(a) && b.lastOpenedAt > a.lastOpenedAt) ? b : a;
  return { ...win, lastOpenedAt: Math.max(a.lastOpenedAt, b.lastOpenedAt) };
}
