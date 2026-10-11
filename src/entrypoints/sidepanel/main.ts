import '@/shared/theme.css';
import './style.css';
import { browser } from 'wxt/browser';
import { COLOR_SWATCH } from '@/content/highlighter';
import type { Group, Shelf } from '@/core/groups';
import { quoteOf, toMarkdown } from '@/core/library';
import type { PageState, Request } from '@/core/messages';
import { isImportedId } from '@/core/paper';
import { loadGroups, loadMeta, loadShelf, setFlagged, setSavedVisible, watchLibrary } from '@/core/storage';
import type { AnchorStatus, Annotation } from '@/core/types';
import { groupChip, openGroupPicker, pickerKey } from '@/shared/group-picker';
import { CHECK_ICON, COPY_ICON, FLAG_ICON, HIGHLIGHTER_ICON, LIBRARY_ICON, PENCIL_ICON, PLUS_ICON, TRASH_ICON } from '@/shared/icons';
import { markPopoverAnchor } from '@/shared/popover';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('list');
const titleEl = $('title');
const subEl = $('sub');
const providersEl = $('providers');
const savedEl = $('saved');
const savedText = $('saved-text');
const savedToggle = $<HTMLButtonElement>('saved-toggle');
const savedClear = $<HTMLButtonElement>('saved-clear');
const groupsEl = $('groups');
const flagBtn = $<HTMLButtonElement>('flag');
const exportBtn = $<HTMLButtonElement>('export');
const libraryBtn = $<HTMLButtonElement>('library');
flagBtn.innerHTML = FLAG_ICON;
exportBtn.innerHTML = COPY_ICON;
libraryBtn.innerHTML = LIBRARY_ICON;

let tabId: number | undefined;
let state: PageState | null = null;
let title = '';
/** 当前论文的分组和标记 */
let groups: Group[] = [];
let shelf: Shelf | null = null;
/** 正在编辑的笔记，刷新时不打断输入 */
let editing: string | null = null;

function statusLabel(status: AnchorStatus, ann: Annotation): string {
  switch (status) {
    case 'anchored':
      return '';
    case 'partial':
      return '部分定位';
    case 'waiting':
      return ann.layer === 'translation' ? '译文未显示' : '原文未显示';
    case 'orphaned':
      return '未找到原位置';
  }
}

async function send<T>(msg: Request): Promise<T | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return (await browser.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    return undefined; // 不是 arXiv HTML 页面，或内容脚本还没加载
  }
}

async function refresh(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  state = (await send<PageState>({ type: 'ahh:get-state' })) ?? null;
  // 存储里的标题来自 arXiv API，不会被翻译插件改写；没有时才用页面上的
  title = state ? ((await loadMeta(state.paper.id))?.title ?? state.pageTitle) : '';
  [groups, shelf] = state ? await Promise.all([loadGroups(), loadShelf(state.paper.id)]) : [[], null];
  if (editing) return;
  render();
}

function render(): void {
  list.replaceChildren();
  providersEl.replaceChildren();
  if (!state) {
    titleEl.textContent = 'arXiv 笔记';
    subEl.textContent = '';
    exportBtn.hidden = true;
    flagBtn.hidden = true;
    groupsEl.hidden = true;
    savedEl.hidden = true;
    list.append(empty('打开一篇 arXiv HTML 论文', '在 arxiv.org/html/… 页面上划线后，笔记会显示在这里'));
    return;
  }
  const { paper, items, providers } = state;
  const id = isImportedId(paper.id) ? '导入的 PDF' : `${paper.id}${paper.version}`;
  titleEl.textContent = title || id;
  titleEl.title = title || id;
  subEl.textContent = title && title !== id ? `${id} · ${items.length} 条划线` : `${items.length} 条划线`;

  renderShelf(paper.id);

  const active = providers.filter((p) => p.count > 0);
  if (active.length) for (const p of active) providersEl.append(chip(`${p.name} · ${p.count} 段译文`, true));
  else providersEl.append(chip('未检测到译文', false));
  renderSaved(state);

  exportBtn.hidden = items.length === 0;
  if (!items.length) {
    list.append(empty('还没有笔记', '选中页面上的文字即可划线，原文和译文都可以'));
    return;
  }
  for (const it of items) list.append(card(it.annotation, it.status));
}

/** 标题下方：论文所在的分组和"加入分组"按钮；右上角的标记按钮 */
function renderShelf(paperId: string): void {
  const flagged = shelf?.flagged ?? false;
  flagBtn.hidden = false;
  flagBtn.classList.toggle('flagged', flagged);
  flagBtn.title = flagged ? '取消标记' : '标记';
  flagBtn.setAttribute('aria-label', flagBtn.title);
  flagBtn.setAttribute('aria-pressed', String(flagged));

  groupsEl.hidden = false;
  groupsEl.replaceChildren();
  const mine = groups.filter((g) => shelf?.groups.includes(g.id));
  for (const g of mine) groupsEl.append(groupChip(g));
  const add = el('button', 'gchip add') as HTMLButtonElement;
  add.innerHTML = PLUS_ICON;
  add.append(mine.length ? '分组' : '加入分组');
  add.title = '加入或移出分组';
  markPopoverAnchor(add, pickerKey(paperId));
  add.addEventListener('click', () => void openGroupPicker(add, paperId));
  groupsEl.append(add);
}

/** 译文存档：段落数、显示开关、清除 */
function renderSaved({ saved }: PageState): void {
  savedEl.hidden = saved.total === 0;
  if (!saved.total) return;
  savedText.textContent = saved.visible
    ? `译文存档 ${saved.total} 段${saved.shown ? ` · 本页显示 ${saved.shown} 段` : ''}`
    : `译文存档 ${saved.total} 段 · 已隐藏`;
  savedText.title = '翻译插件显示过的译文会自动存档；有存档的段落始终显示存档，换电脑、重新翻译都不变';
  savedToggle.textContent = saved.visible ? '隐藏' : '显示';
  disarmClear();
}

let clearArmed: ReturnType<typeof setTimeout> | undefined;

function disarmClear(): void {
  clearTimeout(clearArmed);
  clearArmed = undefined;
  savedClear.classList.remove('armed');
  savedClear.textContent = '清除';
  savedClear.title = '清除本篇论文的译文存档；之后页面上翻译插件显示的译文会重新存档';
}

savedToggle.addEventListener('click', () => {
  if (state) void setSavedVisible(!state.saved.visible);
});

// 点两下才清除，避免误操作
savedClear.addEventListener('click', () => {
  if (!clearArmed) {
    savedClear.classList.add('armed');
    savedClear.textContent = '确认清除？';
    clearArmed = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  void send<PageState>({ type: 'ahh:saved-clear' }).then((s) => {
    if (s) state = s;
    render();
  });
});

function card(ann: Annotation, status: AnchorStatus): HTMLElement {
  const locatable = status === 'anchored' || status === 'partial';
  const c = el('article', 'card');
  c.style.setProperty('--c', COLOR_SWATCH[ann.color]);
  if (locatable) {
    c.tabIndex = 0;
    c.title = '定位到原文';
  } else {
    c.classList.add('dim');
    c.style.cursor = 'default';
  }

  const quote = el('p', 'quote');
  quote.append(el('span', 'mark', quoteOf(ann)));
  c.append(quote);

  let noteEl: HTMLElement | null = null;
  if (ann.note.trim()) {
    noteEl = el('div', 'note', ann.note);
    c.append(noteEl);
  }

  const foot = el('div', 'card-foot');
  if (ann.layer === 'translation') foot.append(el('span', 'tag', '译文'));
  const label = statusLabel(status, ann);
  if (label) foot.append(el('span', 'tag warn', label));
  const actions = el('span', 'card-actions');
  const editBtn = iconButton(ann.note ? '编辑笔记' : '添加笔记', PENCIL_ICON, () => startEdit(c, ann, noteEl, foot));
  const delBtn = iconButton('删除', TRASH_ICON, () => void send({ type: 'ahh:delete', id: ann.id }));
  delBtn.classList.add('danger');
  actions.append(editBtn, delBtn);
  foot.append(actions);
  c.append(foot);

  const locate = () => void send({ type: 'ahh:scroll-to', id: ann.id });
  c.addEventListener('click', (e) => {
    if (!locatable || (e.target as Element).closest('button, textarea')) return;
    locate();
  });
  c.addEventListener('keydown', (e) => {
    if (locatable && e.target === c && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      locate();
    }
  });
  return c;
}

function startEdit(c: HTMLElement, ann: Annotation, noteEl: HTMLElement | null, foot: HTMLElement): void {
  editing = ann.id;
  const ta = document.createElement('textarea');
  ta.className = 'note';
  ta.value = ann.note;
  ta.placeholder = '写点笔记…';
  if (noteEl) noteEl.replaceWith(ta);
  else c.insertBefore(ta, foot);
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  autosize();
  ta.addEventListener('input', autosize);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  let cancelled = false;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelled = true;
      ta.blur();
    }
  });
  ta.addEventListener(
    'blur',
    () => {
      editing = null;
      if (!cancelled && ta.value !== ann.note) void send({ type: 'ahh:update', id: ann.id, patch: { note: ta.value } });
      void refresh();
    },
    { once: true },
  );
}

exportBtn.addEventListener('click', async () => {
  if (!state) return;
  await navigator.clipboard.writeText(
    toMarkdown({ ...state.paper, title: title || undefined }, state.items.map((it) => it.annotation)),
  );
  exportBtn.innerHTML = CHECK_ICON;
  exportBtn.classList.add('done');
  exportBtn.title = '已复制';
  setTimeout(() => {
    exportBtn.innerHTML = COPY_ICON;
    exportBtn.classList.remove('done');
    exportBtn.title = '复制为 Markdown';
  }, 1500);
});

flagBtn.addEventListener('click', () => {
  if (state && shelf) void setFlagged(state.paper.id, !shelf.flagged);
});

libraryBtn.addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/library.html') });
});

function chip(text: string, on: boolean): HTMLElement {
  const c = el('span', on ? 'chip' : 'chip off');
  c.append(el('span', 'live'), text);
  return c;
}

function empty(heading: string, text: string): HTMLElement {
  const box = el('div', 'empty');
  box.innerHTML = HIGHLIGHTER_ICON;
  box.append(el('h2', '', heading), el('p', '', text));
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

browser.runtime.onMessage.addListener((msg: { type?: string }, sender) => {
  if (msg.type === 'ahh:state-changed' && sender.tab?.id === tabId) void refresh();
});
browser.tabs.onActivated.addListener(() => void refresh());
// 在论文库或其他窗口里改了分组、标记
watchLibrary(() => void refresh());
browser.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && info.status === 'complete') void refresh();
});

void refresh();
