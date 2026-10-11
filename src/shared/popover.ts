/**
 * 轻量弹出层：一次只开一个，固定定位在触发元素下方（放不下时在上方）。
 * 点击外部、Esc、页面滚动或窗口大小变化时关闭。
 */

export interface Popover {
  el: HTMLElement;
  close(): void;
}

let current: (Popover & { key: string }) | null = null;

export function isPopoverOpen(key: string): boolean {
  return current?.key === key;
}

/**
 * 同一个 key 的弹出层已打开时再次调用会关闭它（触发按钮的开关语义），返回 null。
 * 列表重新渲染后触发元素会被替换，所以用 key 而不是元素本身判断；
 * 重新渲染时给新的触发元素也设上 data-popover=key（见 markPopoverAnchor）。
 */
export function openPopover(
  key: string,
  anchor: HTMLElement,
  content: HTMLElement,
  opts: { align?: 'start' | 'end'; onClose?: () => void } = {},
): Popover | null {
  if (current?.key === key) {
    current.close();
    return null;
  }
  current?.close();

  const el = document.createElement('div');
  el.className = 'popover';
  el.append(content);
  document.body.append(el);

  const r = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = el;
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8 && r.top - 6 - h >= 8) top = r.top - 6 - h;
  let left = opts.align === 'end' ? r.right - w : r.left;
  left = Math.min(Math.max(8, left), innerWidth - w - 8);
  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${left}px`;

  // 点在触发元素上时交给它的 click 处理（关闭）；触发元素可能已被重新渲染替换，按 data-popover 识别
  anchor.dataset.popover = key;
  const onPointer = (e: PointerEvent) => {
    const t = e.target as Element;
    if (!el.contains(t) && !t.closest?.(`[data-popover="${CSS.escape(key)}"]`)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
    if (anchor.isConnected) anchor.focus();
  };
  const onScroll = (e: Event) => {
    if (!el.contains(e.target as Node)) close();
  };
  const close = () => {
    if (current?.el !== el) return;
    current = null;
    el.remove();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', close);
    for (const a of document.querySelectorAll(`[data-popover="${CSS.escape(key)}"]`)) a.classList.remove('open');
    opts.onClose?.();
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('resize', close);
  anchor.classList.add('open');

  current = { key, el, close };
  return current;
}

/** 重新渲染触发元素时调用，保持开关语义和"已打开"样式 */
export function markPopoverAnchor(anchor: HTMLElement, key: string): void {
  anchor.dataset.popover = key;
  anchor.classList.toggle('open', current?.key === key);
}

export function closePopover(): void {
  current?.close();
}
