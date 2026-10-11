import { COLOR_SWATCH } from '@/content/highlighter';
import { findGroupByName, type Group, type GroupColor, type Shelf } from '@/core/groups';
import { createGroup, loadGroups, loadShelf, setInGroup, watchLibrary } from '@/core/storage';
import { CHECK_ICON, PLUS_ICON } from './icons';
import { closePopover, isPopoverOpen, openPopover } from './popover';

/**
 * 论文库和侧边栏共用：分组的颜色、chip，以及"加入分组"弹出菜单。
 */

export const GROUP_SWATCH: Record<GroupColor, string> = { ...COLOR_SWATCH, gray: '#8e8e93' };

/** 分组 chip：色点 + 名称；传 onClick 时是按钮 */
export function groupChip(group: Group, onClick?: () => void): HTMLElement {
  const c = document.createElement(onClick ? 'button' : 'span');
  c.className = 'gchip';
  c.style.setProperty('--c', GROUP_SWATCH[group.color]);
  const dot = document.createElement('span');
  dot.className = 'dot';
  c.append(dot, group.name);
  if (onClick) {
    c.title = `查看「${group.name}」`;
    c.addEventListener('click', onClick);
  }
  return c;
}

export const pickerKey = (paperId: string) => `groups:${paperId}`;

/**
 * 打开某篇论文的分组菜单：勾选即加入或移出；输入框可搜索，输入新名字回车即新建并加入。
 * 再次点击同一个触发按钮会关闭。
 */
export async function openGroupPicker(anchor: HTMLElement, paperId: string, align: 'start' | 'end' = 'start'): Promise<void> {
  if (isPopoverOpen(pickerKey(paperId))) {
    closePopover();
    return;
  }
  let [groups, shelf] = await Promise.all([loadGroups(), loadShelf(paperId)]);

  const box = document.createElement('div');
  box.className = 'picker';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', '加入分组');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'picker-input';
  input.placeholder = '搜索或新建分组';
  input.autocomplete = 'off';
  const list = document.createElement('div');
  list.className = 'picker-list';
  list.setAttribute('role', 'menu');
  box.append(input, list);

  const items = () => Array.from(list.querySelectorAll<HTMLButtonElement>('.picker-item'));

  function render(): void {
    const q = input.value.trim().toLowerCase();
    const shown = q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups;
    list.replaceChildren();
    for (const g of shown) list.append(item(g, shelf));
    const name = input.value.trim();
    if (name && !findGroupByName(groups, name)) {
      const b = document.createElement('button');
      b.className = 'picker-item create';
      b.setAttribute('role', 'menuitem');
      b.innerHTML = PLUS_ICON;
      b.append(`新建分组「${name}」`);
      b.addEventListener('click', () => void create(name));
      list.append(b);
    }
    if (!list.childElementCount) list.append(Object.assign(document.createElement('div'), { className: 'picker-empty', textContent: '没有分组' }));
  }

  function item(g: Group, s: Shelf): HTMLButtonElement {
    const on = s.groups.includes(g.id);
    const b = document.createElement('button');
    b.className = `picker-item${on ? ' on' : ''}`;
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(on));
    b.style.setProperty('--c', GROUP_SWATCH[g.color]);
    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML = CHECK_ICON;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = g.name;
    b.append(check, dot, label);
    b.addEventListener('click', () => void toggle(g, !on));
    return b;
  }

  async function toggle(g: Group, on: boolean): Promise<void> {
    // 先更新界面，再写入；写入后 storage 变化会再同步一次
    shelf = { ...shelf, groups: on ? [...shelf.groups, g.id] : shelf.groups.filter((x) => x !== g.id) };
    const focused = items().indexOf(document.activeElement as HTMLButtonElement);
    render();
    if (focused >= 0) items()[focused]?.focus();
    await setInGroup(paperId, g.id, on);
  }

  async function create(name: string): Promise<void> {
    const g = await createGroup(name);
    if (!groups.some((x) => x.id === g.id)) groups = [...groups, g];
    input.value = '';
    await toggle(g, true);
    input.focus();
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      const hit = findGroupByName(groups, name);
      if (hit) {
        void toggle(hit, !shelf.groups.includes(hit.id));
        input.value = '';
        render();
      } else {
        void create(name);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items()[0]?.focus();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement) + (e.key === 'ArrowDown' ? 1 : -1);
    if (i < 0) input.focus();
    else all[Math.min(i, all.length - 1)]?.focus();
  });

  // 其他页面（论文库 / 侧边栏）改了分组时同步
  const unwatch = watchLibrary(async () => {
    [groups, shelf] = await Promise.all([loadGroups(), loadShelf(paperId)]);
    const focused = items().indexOf(document.activeElement as HTMLButtonElement);
    render();
    if (focused >= 0) items()[focused]?.focus();
  });

  render();
  const pop = openPopover(pickerKey(paperId), anchor, box, { align, onClose: unwatch });
  if (pop) input.focus();
  else unwatch();
}
