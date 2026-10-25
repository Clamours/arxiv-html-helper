import type { Group } from '@/core/groups';
import { groupsOf, groupView, titleOf, type LibraryEntry, type View } from '@/core/library';
import { absUrl, isImportedId, paperUrl } from '@/core/paper';
import { setPaperNote } from '@/core/storage';
import { groupChip, openGroupPicker, pickerKey } from '@/shared/group-picker';
import { ARROW_UP_RIGHT_ICON, PLUS_ICON, X_ICON } from '@/shared/icons';
import { markPopoverAnchor } from '@/shared/popover';
import { ratingStars } from '@/shared/rating';

/**
 * 论文库右侧的详情面板：点列表里的论文打开。显示摘要、arXiv API 的主分类、DOI 等信息，以及论文笔记。
 * 宽屏时和列表并排，窄屏时浮在列表上方（见 style.css）。
 *
 * 论文笔记边写边保存：停顿片刻、失焦、切换论文、关闭页面时写入。正在输入或写入时，
 * 库里的变化（包括自己这次写入触发的重新渲染）不覆盖输入框。
 */

export interface DetailState {
  entry: LibraryEntry;
  groups: Group[];
  /** 摘要；没有时为空串 */
  abstract: string;
  /** 还没有摘要时的说明（正在获取、获取失败）；没有时为空串 */
  abstractStatus: string;
}

export interface DetailOptions {
  onClose(): void;
  /** 打开导入的论文（在点击事件里调用：可能需要申请权限）；arXiv 论文是普通链接 */
  onOpenImported(entry: LibraryEntry): void;
  onSelectView(view: View): void;
  /** 和列表里的按钮相同：复制引用、标记 */
  citeButton(entry: LibraryEntry): HTMLButtonElement;
  flagButton(entry: LibraryEntry): HTMLButtonElement;
}

const SAVE_DELAY_MS = 600;
/** 作者多于这么多位时先显示前几位，点"展开"看全部（大模型的论文常有上百位作者） */
const AUTHORS_SHOWN = 10;

export function createDetail(root: HTMLElement, opts: DetailOptions): { render(state: DetailState | null): void } {
  const bar = el('div', 'detail-bar');
  const head = el('div', 'detail-head');
  const noteBox = el('section', 'detail-section');
  const abstractBox = el('section', 'detail-section');
  root.append(bar, head, noteBox, abstractBox);

  // ---- 论文笔记：输入框只建一次，重新渲染时不替换，输入不会被打断 ----
  const noteState = el('span', 'save-state');
  const noteHead = el('div', 'section-head');
  noteHead.append(el('h3', '', '论文笔记'), noteState);
  const ta = document.createElement('textarea');
  ta.className = 'paper-note';
  ta.placeholder = '写下对整篇论文的总结、想法、待办…';
  ta.setAttribute('aria-label', '论文笔记');
  noteBox.append(noteHead, ta);

  /** 输入框对应的论文；面板关闭时为 null */
  let noteFor: string | null = null;
  /** 存储里的内容，或最近一次写入的内容 */
  let saved = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 正在写入的次数 */
  let writing = 0;
  /** 展开了全部作者的论文；切换论文后收起 */
  let authorsOpen: string | null = null;

  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    const text = ta.value.trim() ? ta.value : '';
    if (!noteFor || text === saved) return;
    saved = text;
    const id = noteFor;
    writing++;
    void setPaperNote(id, text)
      .then(() => {
        if (noteFor === id && !timer) noteState.textContent = '已保存';
      })
      .catch(() => {
        if (noteFor === id) noteState.textContent = '保存失败';
      })
      .finally(() => writing--);
  }

  ta.addEventListener('input', () => {
    autosize();
    noteState.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  });
  ta.addEventListener('blur', flush);
  // Esc 只退出输入，再按一次才关闭面板
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    ta.blur();
  });
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flush();
  });

  function render(state: DetailState | null): void {
    if (!state) {
      flush();
      noteFor = null;
      root.hidden = true;
      return;
    }
    const { entry } = state;
    root.hidden = false;
    const text = entry.note?.text ?? '';
    if (noteFor !== entry.id) {
      flush();
      noteFor = entry.id;
      saved = ta.value = text;
      noteState.textContent = '';
      authorsOpen = null;
      root.scrollTop = 0;
    } else if (document.activeElement !== ta && !timer && !writing && text !== saved) {
      // 其他标签页或其他电脑（云同步）改了论文笔记
      saved = ta.value = text;
    }
    bar.replaceChildren(...barItems(entry));
    head.replaceChildren(...headItems(state));
    abstractBox.replaceChildren(...abstractItems(state));
    abstractBox.hidden = !abstractBox.childElementCount;
    autosize();
  }

  /** 顶部：打开论文；靠右是复制引用、标记、关闭 */
  function barItems(entry: LibraryEntry): HTMLElement[] {
    const imported = isImportedId(entry.id);
    let open: HTMLElement;
    if (imported) {
      open = el('button', 'btn primary');
      open.addEventListener('click', () => opts.onOpenImported(entry));
    } else {
      const a = el('a', 'btn primary') as HTMLAnchorElement;
      a.href = paperUrl(entry.id, entry.version);
      a.target = '_blank';
      a.rel = 'noopener';
      open = a;
    }
    open.innerHTML = ARROW_UP_RIGHT_ICON;
    open.append(el('span', '', '打开论文'));
    const close = iconButton('关闭（Esc）', X_ICON, opts.onClose);
    return [open, el('span', 'spacer'), ...(imported ? [] : [opts.citeButton(entry)]), opts.flagButton(entry), close];
  }

  /** 标题、作者，以及属性列表 */
  function headItems({ entry, groups }: DetailState): HTMLElement[] {
    const meta = entry.meta;
    const out = [el('h2', 'detail-title', titleOf(entry))];
    if (meta?.authors.length) out.push(authorsLine(entry.id, meta.authors));

    const props = el('dl', 'props');
    const row = (label: string, value: string | Node) => {
      const dd = el('dd', '');
      dd.append(value);
      props.append(el('dt', '', label), dd);
    };
    if (isImportedId(entry.id)) {
      if (meta?.doc) {
        row('文件', meta.doc.fileName || '导入的 PDF');
        row('导入', localDate(meta.doc.importedAt));
      }
    } else {
      row('arXiv', link(absUrl(entry.id), entry.id));
      if (meta?.category) row('主分类', meta.category);
      if (meta?.published) row('发布', meta.published.slice(0, 10));
      if (meta?.updated) {
        const latest = meta.latestVersion;
        // 最近打开的不是最新版本时提一句
        const read = entry.version && latest && entry.version !== latest ? ` · 上次读的是 ${entry.version}` : '';
        row('更新', `${meta.updated.slice(0, 10)}${latest ? ` · ${latest}` : ''}${read}`);
      }
      if (meta?.doi) row('DOI', link(`https://doi.org/${meta.doi}`, meta.doi));
      if (meta?.journalRef) row('发表于', meta.journalRef);
      if (meta?.comment) row('备注', meta.comment);
    }
    row('分组', groupsValue(entry, groups));
    row('评分', ratingStars(entry.id, entry.shelf.rating));
    const n = entry.annotations.length;
    const withNote = entry.annotations.filter((a) => a.note.trim()).length;
    row('划线', n ? `${n} 条划线${withNote ? ` · ${withNote} 条笔记` : ''}` : '未划线');
    out.push(props);
    return out;
  }

  function authorsLine(id: string, authors: string[]): HTMLElement {
    const p = el('p', 'detail-authors');
    if (authors.length <= AUTHORS_SHOWN || authorsOpen === id) {
      p.textContent = authors.join(', ');
      return p;
    }
    p.textContent = `${authors.slice(0, AUTHORS_SHOWN).join(', ')} `;
    const more = el('button', 'link-btn', `等 ${authors.length} 人`) as HTMLButtonElement;
    more.title = '展开全部作者';
    more.addEventListener('click', () => {
      authorsOpen = id;
      p.replaceWith(authorsLine(id, authors));
    });
    p.append(more);
    return p;
  }

  function groupsValue(entry: LibraryEntry, groups: Group[]): HTMLElement {
    const box = el('div', 'detail-groups');
    const mine = groupsOf(entry, groups);
    for (const g of mine) box.append(groupChip(g, () => opts.onSelectView(groupView(g.id))));
    const add = el('button', 'gchip add') as HTMLButtonElement;
    add.innerHTML = PLUS_ICON;
    add.append(mine.length ? '分组' : '加入分组');
    add.title = '加入或移出分组';
    markPopoverAnchor(add, pickerKey(entry.id));
    add.addEventListener('click', () => void openGroupPicker(add, entry.id));
    box.append(add);
    return box;
  }

  /** 摘要；还没拿到时显示获取状态，都没有时不显示 */
  function abstractItems({ abstract, abstractStatus }: DetailState): HTMLElement[] {
    if (!abstract && !abstractStatus) return [];
    const h = el('div', 'section-head');
    h.append(el('h3', '', '摘要'));
    return [h, el('p', abstract ? 'abstract' : 'abstract pending', abstract || abstractStatus)];
  }

  return { render };
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el('a', 'ext') as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function localDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function iconButton(label: string, svg: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'icon-btn') as HTMLButtonElement;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg;
  b.addEventListener('click', onClick);
  return b;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
