import '@/shared/theme.css';
import './style.css';
import { fetchArxivMeta } from '@/core/arxiv-api';
import { GROUPS_KEY, normalizeGroups, type Group } from '@/core/groups';
import {
  entriesToMarkdown,
  groupLibrary,
  groupsOf,
  groupView,
  inView,
  searchLibrary,
  sortByDocumentOrder,
  sortLibrary,
  titleOf,
  toMarkdown,
  type LibraryEntry,
  type SearchResult,
  type SortKey,
  type View,
} from '@/core/library';
import { isImportedId, paperUrl } from '@/core/paper';
import { deletePaper, readAll, recordApiMeta, setFlagged, watchLibrary } from '@/core/storage';
import { initBackupUi } from './backup-ui';
import { initImportUi } from './import-ui';
import { initSyncUi } from './sync-ui';
import { createNav, viewLabel } from './nav';
import { toast } from './toast';
import type { Annotation } from '@/core/types';
import { groupChip, openGroupPicker, pickerKey } from '@/shared/group-picker';
import {
  CHECK_ICON,
  CHEVRON_ICON,
  COPY_ICON,
  FLAG_ICON,
  HIGHLIGHTER_ICON,
  INBOX_ICON,
  PLUS_ICON,
  SEARCH_ICON,
  TAG_ICON,
  TRASH_ICON,
} from '@/shared/icons';
import { markPopoverAnchor } from '@/shared/popover';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('list');
const stats = $('stats');
const viewTitle = $('view-title');
const search = $<HTMLInputElement>('search');
const sort = $<HTMLSelectElement>('sort');
$('search-icon').innerHTML = SEARCH_ICON;
$('sort-icon').innerHTML = CHEVRON_ICON;
const backupUi = initBackupUi();
const importUi = initImportUi();
initSyncUi();
const nav = createNav($('nav'), { onSelect: setView, onCopyGroup: copyGroup });

const SORT_STORAGE_KEY = 'library-sort';
const VIEW_STORAGE_KEY = 'library-view';
let entries: LibraryEntry[] = [];
let groups: Group[] = [];
let view: View = 'all';

try {
  const saved = localStorage.getItem(SORT_STORAGE_KEY);
  if (saved && [...sort.options].some((o) => o.value === saved)) sort.value = saved;
  view = (localStorage.getItem(VIEW_STORAGE_KEY) as View | null) ?? 'all';
} catch {
  // 无痕模式等场景下 localStorage 不可用，用默认排序
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 忽略
  }
}

async function refresh(): Promise<void> {
  const all = await readAll();
  entries = groupLibrary(all);
  groups = normalizeGroups(all[GROUPS_KEY]);
  render();
  void backfillMeta();
}

function setView(next: View): void {
  view = next;
  remember(VIEW_STORAGE_KEY, next);
  render();
  scrollTo({ top: 0 });
}

async function copyGroup(group: Group): Promise<void> {
  const inGroup = sortLibrary(entries, sort.value as SortKey).filter((e) => inView(e, groupView(group.id), groups));
  const withNotes = inGroup.filter((e) => e.annotations.length);
  if (!withNotes.length) {
    toast(`「${group.name}」里的论文还没有划线`);
    return;
  }
  await navigator.clipboard.writeText(entriesToMarkdown(withNotes));
  toast(`已复制「${group.name}」中 ${withNotes.length} 篇论文的笔记`);
}

// ---- 从 arXiv API 补全标题和作者 ----
/** 本次打开页面已经尝试过的 id，避免 API 查不到的论文反复请求 */
const attempted = new Set<string>();
let fetchStatus = '';

async function backfillMeta(): Promise<void> {
  const ids = entries.filter((e) => e.meta?.source !== 'api' && !isImportedId(e.id) && !attempted.has(e.id)).map((e) => e.id);
  if (!ids.length) return;
  ids.forEach((id) => attempted.add(id));
  fetchStatus = `正在从 arXiv 获取 ${ids.length} 篇论文的信息…`;
  render();
  const { found, failed } = await fetchArxivMeta(ids);
  fetchStatus = failed ? '部分论文信息获取失败，刷新页面可重试' : '';
  // 写入后 watchLibrary 会触发 refresh 重新渲染
  if (found.length) await recordApiMeta(found);
  else render();
}

function render(): void {
  // 分组被删除（包括在其他标签页里）时回到全部论文
  const fixed: View[] = ['all', 'flagged', 'ungrouped'];
  if (!fixed.includes(view) && !groups.some((g) => groupView(g.id) === view)) view = 'all';
  nav.render({ entries, groups, view });

  const shown = entries.filter((e) => inView(e, view, groups));
  const label = viewLabel(view, groups);
  viewTitle.textContent = label;
  document.title = view === 'all' ? '论文库 · arXiv HTML Helper' : `${label} · 论文库`;
  const total = shown.reduce((n, e) => n + e.annotations.length, 0);
  const notes = shown.reduce((n, e) => n + e.annotations.filter((a) => a.note.trim()).length, 0);
  stats.textContent = [
    shown.length ? `${shown.length} 篇论文 · ${total} 条划线 · ${notes} 条笔记` : '',
    fetchStatus,
  ]
    .filter(Boolean)
    .join(' · ');

  backupUi.setHasData(entries.length > 0);

  const query = search.value.trim();
  const results = searchLibrary(sortLibrary(shown, sort.value as SortKey), query);
  list.replaceChildren();
  if (!entries.length) {
    list.append(empty(HIGHLIGHTER_ICON, '论文库还是空的', '打开 arxiv.org/html/… 的论文会自动加入论文库，选中文字即可划线'));
    return;
  }
  if (!shown.length) {
    list.append(emptyView());
    return;
  }
  if (!results.length) {
    list.append(empty(SEARCH_ICON, '没有找到相关论文', `${view === 'all' ? '' : `「${label}」中`}没有标题、作者、划线或笔记包含"${query}"`));
    return;
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const box = el('div', 'papers');
  for (const r of results) box.append(paperRow(r, terms));
  list.append(box);
}

function emptyView(): HTMLElement {
  if (view === 'flagged') return empty(FLAG_ICON, '还没有标记的论文', '把鼠标移到论文上，点右侧的旗帜即可标记');
  if (view === 'ungrouped') return empty(INBOX_ICON, '所有论文都已分组', '');
  return empty(TAG_ICON, '这个分组还没有论文', '把鼠标移到论文上，点"+"加入分组，或在论文页的侧边栏里添加');
}

/** 列表中的一项：标题，作者和元信息，最后一行是分组；操作按钮悬停时显示 */
function paperRow({ entry, matched }: SearchResult, terms: string[]): HTMLElement {
  const row = el('article', 'paper');
  const all = sortByDocumentOrder(entry.annotations);

  const text = el('div', 'paper-text');
  const h2 = el('h2', '');
  // 标题最多显示两行，完整标题放在悬停提示里
  h2.title = titleOf(entry);
  const link = el('a', '') as HTMLAnchorElement;
  const imported = isImportedId(entry.id);
  if (imported) {
    // 导入的论文：页面保存在本机，以本地文件打开
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      void importUi.open(entry.id, titleOf(entry));
    });
  } else {
    link.href = paperUrl(entry.id, entry.version);
    link.target = '_blank';
  }
  link.append(highlight(titleOf(entry), terms));
  h2.append(link);
  text.append(h2);

  const meta = el('div', 'meta');
  const authors = entry.meta?.authors ?? [];
  if (authors.length) {
    const a = el('span', 'authors');
    a.title = authors.join(', ');
    a.append(highlight(authorsLine(authors), terms));
    meta.append(a);
  }
  // 导入的 PDF 文件名可能很长，过长时截断
  const idSpan = el('span', imported ? 'file' : '');
  if (imported) idSpan.title = entry.meta?.doc?.fileName ?? '';
  idSpan.append(highlight(imported ? `PDF · ${entry.meta?.doc?.fileName || '导入'}` : `${entry.id}${entry.version}`, terms));
  meta.append(idSpan);
  if (entry.meta?.published) meta.append(el('span', '', entry.meta.published.slice(0, 4)));
  const withNote = entry.annotations.filter((a) => a.note.trim()).length;
  meta.append(el('span', '', all.length ? `${all.length} 条划线` : '未划线'));
  if (withNote) meta.append(el('span', '', `${withNote} 条笔记`));
  const opened = entry.meta?.lastOpenedAt ?? 0;
  const [whenLabel, at] = entry.lastNoteAt ? ['更新于', entry.lastNoteAt] : opened ? ['打开于', opened] : ['', 0];
  if (at) {
    const when = el('span', '', `${whenLabel} ${relativeTime(at)}`);
    when.title = new Date(at).toLocaleString('zh-CN');
    meta.append(when);
  }
  // 关键词命中划线或笔记时，说明这篇论文为什么被搜出来
  if (matched.length) meta.append(el('span', 'hit-count', `${matched.length} 条划线匹配`));
  text.append(meta, groupChips(entry));

  const actions = el('div', 'paper-actions');
  actions.append(flagButton(entry));
  if (all.length) actions.append(copyButton(entry, all));
  actions.append(deleteButton(entry));
  row.append(text, actions);
  return row;
}

/** 最后一行：所属分组（点击查看该分组）和"加入分组"按钮 */
function groupChips(entry: LibraryEntry): HTMLElement {
  const box = el('div', 'paper-groups');
  const mine = groupsOf(entry, groups);
  for (const g of mine) box.append(groupChip(g, () => setView(groupView(g.id))));
  const add = el('button', 'gchip add') as HTMLButtonElement;
  add.innerHTML = PLUS_ICON;
  if (!mine.length) add.append('加入分组');
  add.title = '加入或移出分组';
  add.setAttribute('aria-label', '加入或移出分组');
  markPopoverAnchor(add, pickerKey(entry.id));
  add.addEventListener('click', () => void openGroupPicker(add, entry.id));
  box.append(add);
  return box;
}

function flagButton(entry: LibraryEntry): HTMLButtonElement {
  const on = entry.shelf.flagged;
  const b = iconButton(on ? '取消标记' : '标记', FLAG_ICON, () => void setFlagged(entry.id, !on));
  b.setAttribute('aria-pressed', String(on));
  if (on) b.classList.add('flagged');
  return b;
}

function copyButton(entry: LibraryEntry, all: Annotation[]): HTMLButtonElement {
  const b = iconButton('复制为 Markdown', COPY_ICON, async () => {
    await navigator.clipboard.writeText(toMarkdown({ id: entry.id, version: entry.version, title: entry.meta?.title }, all));
    b.innerHTML = CHECK_ICON;
    b.classList.add('done');
    b.title = '已复制';
    setTimeout(() => {
      b.innerHTML = COPY_ICON;
      b.classList.remove('done');
      b.title = '复制为 Markdown';
    }, 1500);
  });
  return b;
}

/** 两步删除：第一次点击变成"确认删除"，3 秒内再点才真正删除 */
function deleteButton(entry: LibraryEntry): HTMLButtonElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const n = entry.annotations.length;
  const imported = isImportedId(entry.id);
  const what = [imported && '论文页面', n && `全部 ${n} 条划线`].filter(Boolean).join('和');
  const b = iconButton(what ? `从论文库移除，并删除${what}` : '从论文库移除', TRASH_ICON, () => {
    if (b.classList.contains('confirm')) {
      clearTimeout(timer);
      void deletePaper(entry.id);
      if (imported) void importUi.remove(entry.id);
      return;
    }
    b.classList.add('confirm');
    b.textContent = what ? '确认删除' : '确认移除';
    timer = setTimeout(() => {
      b.classList.remove('confirm');
      b.innerHTML = TRASH_ICON;
    }, 3000);
  });
  b.classList.add('danger');
  return b;
}

function authorsLine(authors: string[]): string {
  return authors.length > 3 ? `${authors.slice(0, 3).join(', ')} 等 ${authors.length} 人` : authors.join(', ');
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
function relativeTime(t: number): string {
  const diff = (t - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
  ];
  for (const [unit, sec] of units) if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit);
  return '刚刚';
}

/** 把搜索词标出来 */
function highlight(text: string, terms: string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!terms.length) {
    frag.append(text);
    return frag;
  }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let best: { at: number; len: number } | null = null;
    for (const t of terms) {
      const at = lower.indexOf(t, i);
      if (at >= 0 && (!best || at < best.at)) best = { at, len: t.length };
    }
    if (!best) break;
    frag.append(text.slice(i, best.at));
    frag.append(el('span', 'hit', text.slice(best.at, best.at + best.len)));
    i = best.at + best.len;
  }
  frag.append(text.slice(i));
  return frag;
}

function empty(icon: string, heading: string, text: string): HTMLElement {
  const box = el('div', 'empty');
  box.innerHTML = icon;
  box.append(el('h2', '', heading));
  if (text) box.append(el('p', '', text));
  return box;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function iconButton(label: string, svg: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-btn') as HTMLButtonElement;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

search.addEventListener('input', render);
sort.addEventListener('change', () => {
  remember(SORT_STORAGE_KEY, sort.value);
  render();
});
watchLibrary(() => void refresh());
void refresh();
