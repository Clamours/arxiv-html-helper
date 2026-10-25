import { findGroupByName, GROUP_COLORS, type Group, type GroupColor } from '@/core/groups';
import { countViews, groupView, type LibraryEntry, type View } from '@/core/library';
import { createGroup, deleteGroup, updateGroup } from '@/core/storage';
import { GROUP_SWATCH } from '@/shared/group-picker';
import { COPY_ICON, FLAG_ICON, INBOX_ICON, LIBRARY_ICON, MORE_ICON, PENCIL_ICON, PLUS_ICON, TRASH_ICON } from '@/shared/icons';
import { closePopover, markPopoverAnchor, openPopover } from '@/shared/popover';
import { toast } from './toast';

/**
 * 论文库左侧栏：全部 / 已标记 / 未分组，以及分组列表（新建、重命名、改颜色、删除）。
 * 窄屏时变成列表上方的一行（见 style.css）。
 */

export interface NavState {
  entries: LibraryEntry[];
  groups: Group[];
  view: View;
}

export interface NavOptions {
  onSelect(view: View): void;
  onCopyGroup(group: Group): void;
}

const COLOR_NAMES: Record<GroupColor, string> = {
  yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色', purple: '紫色', gray: '灰色',
};

export function viewLabel(view: View, groups: Group[]): string {
  if (view === 'all') return '全部论文';
  if (view === 'flagged') return '已标记';
  if (view === 'ungrouped') return '未分组';
  return groups.find((g) => groupView(g.id) === view)?.name ?? '全部论文';
}

export function createNav(root: HTMLElement, opts: NavOptions): { render(state: NavState): void } {
  let state: NavState | null = null;
  /** 正在重命名的分组 id，或 'new' 表示正在新建 */
  let editing: string | null = null;

  // 扩展图标 + 名称；只建一次，重新渲染时图片不会闪
  const brand = el('div', 'nav-brand');
  const logo = el('img', 'nav-logo') as HTMLImageElement;
  logo.src = '/icon/128.png';
  logo.alt = '';
  brand.append(logo, el('span', '', '论文库'));

  function render(): void {
    if (!state || editing) return; // 输入时不重建，避免打断
    const { entries, groups, view } = state;
    const counts = countViews(entries, groups);

    const fixed = el('div', 'nav-section');
    fixed.append(
      item('all', svgIcon(LIBRARY_ICON), '全部论文', counts.get('all') ?? 0),
      item('flagged', svgIcon(FLAG_ICON, 'flag-icon'), '已标记', counts.get('flagged') ?? 0),
      item('ungrouped', svgIcon(INBOX_ICON), '未分组', counts.get('ungrouped') ?? 0),
    );

    const heading = el('div', 'nav-heading');
    heading.append(el('span', '', '分组'));
    const add = iconButton('新建分组', PLUS_ICON, () => startCreate(list));
    heading.append(add);

    const list = el('div', 'nav-section nav-groups');
    for (const g of groups) {
      const dot = el('span', 'dot');
      dot.style.setProperty('--c', GROUP_SWATCH[g.color]);
      const row = item(groupView(g.id), dot, g.name, counts.get(groupView(g.id)) ?? 0);
      row.classList.add('has-menu');
      const more = iconButton(`「${g.name}」的更多操作`, MORE_ICON, () => openMenu(more, g, counts.get(groupView(g.id)) ?? 0));
      more.classList.add('nav-more');
      markPopoverAnchor(more, menuKey(g.id));
      row.append(more);
      row.dataset.group = g.id;
      list.append(row);
    }

    root.replaceChildren(brand, fixed, heading, list);
  }

  function item(view: View, icon: Element, name: string, count: number): HTMLElement {
    const active = state!.view === view;
    const row = el('div', `nav-item${active ? ' active' : ''}`);
    const b = el('button', 'nav-main') as HTMLButtonElement;
    if (active) b.setAttribute('aria-current', 'true');
    b.append(icon, el('span', 'name', name), el('span', 'count', String(count)));
    b.title = name;
    b.addEventListener('click', () => opts.onSelect(view));
    row.append(b);
    return row;
  }

  // ---- 新建与重命名：就地输入，Enter 确认，Esc 取消，失焦时有内容就确认 ----

  function startCreate(list: HTMLElement): void {
    if (editing) return;
    editing = 'new';
    const row = el('div', 'nav-item editing');
    const input = nameInput('', '分组名称', async (name) => {
      const existed = findGroupByName(state!.groups, name);
      const g = await createGroup(name);
      if (existed) toast(`已有分组「${g.name}」`);
    });
    row.append(input);
    list.append(row);
    input.focus();
  }

  function startRename(g: Group): void {
    if (editing) return;
    const row = root.querySelector<HTMLElement>(`.nav-item[data-group="${CSS.escape(g.id)}"]`);
    if (!row) return;
    editing = g.id;
    const input = nameInput(g.name, '分组名称', async (name) => {
      if (name === g.name) return;
      const dup = findGroupByName(state!.groups, name);
      if (dup && dup.id !== g.id) {
        toast(`已有分组「${dup.name}」`);
        return;
      }
      await updateGroup(g.id, { name });
    });
    row.classList.add('editing');
    row.replaceChildren(input);
    input.focus();
    input.select();
  }

  function nameInput(value: string, placeholder: string, commit: (name: string) => Promise<void>): HTMLInputElement {
    const input = el('input', 'nav-input') as HTMLInputElement;
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = 60;
    let done = false;
    const finish = async (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      try {
        if (save && name) await commit(name);
      } finally {
        editing = null;
        render();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) void finish(true);
      else if (e.key === 'Escape') void finish(false);
    });
    input.addEventListener('blur', () => void finish(true));
    return input;
  }

  // ---- 分组菜单 ----

  const menuKey = (id: string) => `group-menu:${id}`;

  function openMenu(anchor: HTMLElement, g: Group, count: number): void {
    const box = el('div', 'menu');
    box.setAttribute('role', 'menu');
    box.append(
      menuItem(PENCIL_ICON, '重命名', () => {
        closePopover();
        startRename(g);
      }),
    );

    const swatches = el('div', 'swatches');
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', '颜色');
    for (const c of GROUP_COLORS) {
      const s = el('button', `swatch${c === g.color ? ' on' : ''}`) as HTMLButtonElement;
      s.style.setProperty('--c', GROUP_SWATCH[c]);
      s.title = COLOR_NAMES[c];
      s.setAttribute('aria-label', COLOR_NAMES[c]);
      s.setAttribute('aria-pressed', String(c === g.color));
      s.addEventListener('click', () => {
        for (const x of swatches.children) x.classList.toggle('on', x === s);
        g = { ...g, color: c };
        void updateGroup(g.id, { color: c });
      });
      swatches.append(s);
    }
    box.append(swatches);

    box.append(
      menuItem(COPY_ICON, '复制全部笔记为 Markdown', () => {
        closePopover();
        opts.onCopyGroup(g);
      }),
    );

    box.append(el('div', 'menu-sep'));
    let armed = false;
    const del = menuItem(TRASH_ICON, '删除分组', async () => {
      if (!armed) {
        armed = true;
        del.classList.add('confirm');
        del.lastChild!.textContent = count ? `确认删除？${count} 篇论文会移出该分组` : '确认删除';
        return;
      }
      closePopover();
      await deleteGroup(g.id);
      if (state?.view === groupView(g.id)) opts.onSelect('all');
      toast(`已删除分组「${g.name}」`);
    });
    del.classList.add('danger');
    box.append(del);

    openPopover(menuKey(g.id), anchor, box, { align: 'start' })?.el.querySelector<HTMLElement>('.menu-item')?.focus();
  }

  return {
    render(next) {
      state = next;
      render();
    },
  };
}

function menuItem(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'menu-item') as HTMLButtonElement;
  b.setAttribute('role', 'menuitem');
  b.innerHTML = svg;
  b.append(el('span', '', label));
  b.addEventListener('click', onClick);
  return b;
}

function svgIcon(svg: string, cls = ''): Element {
  const span = el('span', `nav-icon ${cls}`.trim());
  span.innerHTML = svg;
  return span;
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
