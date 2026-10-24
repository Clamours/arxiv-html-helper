/**
 * 导入论文页面左侧的目录（arXiv HTML 自带目录，导入的页面没有）。
 *
 * 运行时由内容脚本从页面的节结构生成，不写进页面文件：已导入的论文也能用上，页面本身保持不变。
 * 目录挂在 <html> 下、<article> 之外，放在 Shadow DOM 里并标记 notranslate，
 * 不影响划线定位（块 key 按 <article> 内的元素计算）和翻译插件。
 *
 * - 宽屏：停靠在左侧，正文往右让出位置；可以收起，收起状态记在 localStorage
 * - 窄屏：收成左上角的按钮，点开后浮在页面上，选了条目或点页面其他地方时关闭
 * - 跟随滚动高亮当前所在的节，并展开它的子节
 */

export interface TocEntry {
  /** 跳转目标（节的 <section>、摘要） */
  target: Element;
  /** 编号（"5.1"、"A"），没有时为空串 */
  number: string;
  /** 标题：<h*> 里除编号外的内容（公式保留为 <math>） */
  title: DocumentFragment;
  children: TocEntry[];
}

/** 标题的内容：跳过编号和 skip() 为 true 的节点（译文），公式整体复制，其他标签只保留文字 */
function headingContent(h: Element, skip: (n: Node) => boolean): DocumentFragment {
  const doc = h.ownerDocument;
  const out = doc.createDocumentFragment();
  const visit = (n: Node): void => {
    for (const c of Array.from(n.childNodes)) {
      if (skip(c)) continue;
      if (c.nodeType === 3) out.append(c.textContent ?? '');
      else if (c.nodeType !== 1) continue;
      else if ((c as Element).localName === 'math') out.append(c.cloneNode(true));
      else if (!(c as Element).classList.contains('ltx_tag')) visit(c);
    }
  };
  visit(h);
  return out;
}

/** 节的编号（标题里的 .ltx_tag），折叠空白 */
function headingNumber(h: Element, skip: (n: Node) => boolean): string {
  const tag = h.querySelector(':scope > .ltx_tag');
  return tag && !skip(tag) ? (tag.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
}

/** 从 <article> 的节结构生成目录：摘要 + 各级节（含附录、参考文献） */
export function collectToc(article: Element, skip: (n: Node) => boolean = () => false): TocEntry[] {
  const doc = article.ownerDocument;
  const sections = (parent: Element): TocEntry[] =>
    Array.from(parent.querySelectorAll(':scope > section')).flatMap((s) => {
      const h = s.firstElementChild;
      if (!h?.classList.contains('ltx_title')) return [];
      return [{ target: s, number: headingNumber(h, skip), title: headingContent(h, skip), children: sections(s) }];
    });
  const out: TocEntry[] = [];
  const abs = article.querySelector(':scope > .ltx_abstract');
  if (abs) {
    const title = doc.createDocumentFragment();
    title.append('Abstract');
    out.push({ target: abs, number: '', title, children: [] });
  }
  out.push(...sections(article));
  return out;
}

const WIDTH = 270;
/** 正文（.ltx_page_main 最宽 52em × 17px，加左右内边距）加上目录的宽度 */
const DOCK_QUERY = `(min-width: ${WIDTH + 950}px)`;
const STORE_KEY = 'ahh-toc-closed';
const DOCKED_CLASS = 'ahh-toc-docked';
/** 节标题滚到视口上方这个位置以内时，算作当前所在的节 */
const ACTIVE_OFFSET = 96;

const PAGE_CSS = `html.${DOCKED_CLASS} body { padding-left: ${WIDTH}px; }`;

const CSS = `
:host { all: initial; }
.panel {
  position: fixed; z-index: 2147483646; top: 0; left: 0; bottom: 0;
  width: ${WIDTH}px; box-sizing: border-box; display: flex; flex-direction: column;
  font: 13px/1.45 system-ui, -apple-system, "PingFang SC", sans-serif;
  color: #1d1d1f; background: #f7f7f8; border-right: 1px solid rgba(0,0,0,.1);
}
.panel[hidden] { display: none; }
.panel.overlay { width: min(${WIDTH + 30}px, 85vw); box-shadow: 0 0 32px rgba(0,0,0,.25); }
.head { display: flex; align-items: center; gap: 6px; padding: 10px 8px 8px 16px; font-weight: 600; }
.head span { flex: 1; }
.list { flex: 1; overflow-y: auto; padding: 0 8px 24px; overscroll-behavior: contain; }
ul { list-style: none; margin: 0; padding: 0; }
ul ul { padding-left: 14px; }
li > ul { display: none; }
li.open > ul { display: block; }
.row { display: flex; align-items: flex-start; }
.caret, .spacer { flex: none; width: 18px; height: 24px; }
.caret {
  padding: 0; border: 0; background: transparent; color: #86868b; cursor: pointer;
  display: grid; place-items: center; border-radius: 4px;
}
.caret::before { content: ""; border: 4px solid transparent; border-left: 5px solid currentColor; margin-left: 4px; transition: transform .12s ease; }
li.open > .row > .caret::before { transform: rotate(90deg); margin: 4px 0 0 2px; }
.caret:hover { color: inherit; background: rgba(0,0,0,.06); }
a {
  flex: 1; min-width: 0; display: flex; gap: 6px; padding: 3px 6px; border-radius: 6px;
  color: inherit; text-decoration: none; cursor: pointer;
}
a:hover { background: rgba(0,0,0,.06); }
a.active { background: rgba(10,132,255,.12); color: #0a64d6; font-weight: 600; }
.num { flex: none; color: #86868b; font-variant-numeric: tabular-nums; }
a.active .num { color: inherit; }
.title { min-width: 0; overflow-wrap: anywhere; }
math { font-family: "Latin Modern Math", "STIX Two Math", "Cambria Math", math; }
.icon-btn {
  flex: none; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px;
  display: grid; place-items: center; background: transparent; color: inherit; cursor: pointer;
}
.icon-btn:hover { background: rgba(0,0,0,.06); }
.icon-btn svg { width: 18px; height: 18px; }
.open-btn {
  position: fixed; z-index: 2147483646; top: 12px; left: 12px;
  background: #fff; color: #1d1d1f; border: 1px solid rgba(0,0,0,.12); box-shadow: 0 2px 8px rgba(0,0,0,.12);
}
.open-btn[hidden] { display: none; }
.open-btn:hover { background: #f2f2f4; }
button:focus-visible, a:focus-visible { outline: 2px solid #0a84ff; outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
  .panel { color: #f5f5f7; background: #232325; border-color: rgba(255,255,255,.1); }
  .caret:hover, a:hover, .icon-btn:hover { background: rgba(255,255,255,.08); }
  a.active { background: rgba(10,132,255,.22); color: #6cb2ff; }
  .open-btn { background: #2c2c2e; color: #f5f5f7; border-color: rgba(255,255,255,.12); }
  .open-btn:hover { background: #3a3a3c; }
}
@media print { .panel, .open-btn { display: none; } }
`;

const LIST_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>';

function readClosed(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeClosed(closed: boolean): void {
  try {
    if (closed) localStorage.setItem(STORE_KEY, '1');
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // 本地文件页面禁用了存储时，只在本次打开有效
  }
}

interface Item {
  entry: TocEntry;
  li: HTMLLIElement;
  link: HTMLAnchorElement;
  parent: Item | null;
  /** 手动展开 / 收起；undefined 时跟随当前所在的节 */
  open?: boolean;
}

export class Toc {
  readonly host: HTMLElement;
  private panel: HTMLElement;
  private list: HTMLElement;
  private openBtn: HTMLButtonElement;
  private items: Item[] = [];
  private active: Item | null = null;
  private pageStyle: HTMLStyleElement;
  private dockQuery: MediaQueryList | null;
  /** 停靠模式下用户收起了目录 */
  private closed = readClosed();
  /** 浮层模式下目录是否展开 */
  private overlayOpen = false;
  private frame = 0;

  constructor(entries: TocEntry[]) {
    this.host = document.createElement('arxiv-notes-toc');
    this.host.className = 'notranslate';
    this.host.setAttribute('translate', 'no');
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    this.panel = document.createElement('nav');
    this.panel.className = 'panel';
    this.panel.setAttribute('aria-label', '目录');
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    label.textContent = '目录';
    head.append(label, this.iconButton('收起目录', CLOSE_ICON, () => this.setOpen(false)));
    this.list = document.createElement('div');
    this.list.className = 'list';
    this.list.append(this.renderList(entries, null));
    this.panel.append(head, this.list);

    this.openBtn = this.iconButton('目录', LIST_ICON, () => this.setOpen(true));
    this.openBtn.classList.add('open-btn');
    shadow.append(style, this.panel, this.openBtn);

    // 页面里的点击、划词处理（高亮编辑框、划词工具栏）不应响应目录里的操作
    for (const type of ['click', 'mouseup', 'mousedown'] as const) this.host.addEventListener(type, (e) => e.stopPropagation());

    this.pageStyle = document.createElement('style');
    this.pageStyle.textContent = PAGE_CSS;
    (document.head ?? document.documentElement).append(this.pageStyle);
    document.documentElement.append(this.host);

    this.dockQuery = typeof window.matchMedia === 'function' ? window.matchMedia(DOCK_QUERY) : null;
    this.dockQuery?.addEventListener('change', () => {
      this.overlayOpen = false;
      this.layout();
    });
    // 浮层模式下点页面其他地方时关闭
    document.addEventListener('click', (e) => {
      if (this.overlayOpen && !e.composedPath().includes(this.host)) this.setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlayOpen) this.setOpen(false);
    });
    window.addEventListener('scroll', () => this.schedule(), { passive: true });
    window.addEventListener('resize', () => this.schedule());
    this.layout();
    this.updateActive();
  }

  private get docked(): boolean {
    return this.dockQuery?.matches ?? false;
  }

  private setOpen(open: boolean): void {
    if (this.docked) {
      this.closed = !open;
      writeClosed(this.closed);
    } else {
      this.overlayOpen = open;
    }
    this.layout();
    if (open) this.revealActive();
  }

  private layout(): void {
    const docked = this.docked;
    const visible = docked ? !this.closed : this.overlayOpen;
    this.panel.hidden = !visible;
    this.openBtn.hidden = visible;
    this.panel.classList.toggle('overlay', !docked);
    document.documentElement.classList.toggle(DOCKED_CLASS, docked && visible);
  }

  private renderList(entries: TocEntry[], parent: Item | null): HTMLUListElement {
    const ul = document.createElement('ul');
    for (const entry of entries) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      const link = document.createElement('a');
      if (entry.target.id) link.href = `#${entry.target.id}`;
      if (entry.number) {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = entry.number;
        link.append(num);
      }
      const title = document.createElement('span');
      title.className = 'title';
      title.append(entry.title.cloneNode(true));
      link.append(title);
      const item: Item = { entry, li, link, parent };
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.jump(item);
      });
      if (entry.children.length) {
        const caret = document.createElement('button');
        caret.className = 'caret';
        caret.setAttribute('aria-label', '展开 / 收起');
        caret.addEventListener('click', () => {
          item.open = !li.classList.contains('open');
          this.applyOpen();
        });
        row.append(caret, link);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'spacer';
        row.append(spacer, link);
      }
      li.append(row);
      this.items.push(item);
      if (entry.children.length) li.append(this.renderList(entry.children, item));
      ul.append(li);
    }
    return ul;
  }

  private jump(item: Item): void {
    const { target } = item.entry;
    if (target.id) history.pushState(null, '', `#${target.id}`);
    target.scrollIntoView({ block: 'start' });
    this.setActive(item);
    if (!this.docked) this.setOpen(false);
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.updateActive();
    });
  }

  /** 当前所在的节：标题已经滚到视口顶部附近的最后一节 */
  private updateActive(): void {
    let cur: Item | null = null;
    for (const item of this.items) {
      const top = item.entry.target.getBoundingClientRect().top;
      if (top <= ACTIVE_OFFSET) cur = item;
    }
    // 还没滚到第一节时（标题、作者），高亮第一项
    this.setActive(cur ?? this.items[0] ?? null);
  }

  private setActive(item: Item | null): void {
    if (item === this.active) return;
    this.active?.link.classList.remove('active');
    this.active = item;
    item?.link.classList.add('active');
    this.applyOpen();
    this.revealActive();
  }

  /** 展开当前节的各级父节点和它自己的子节；手动展开 / 收起过的以手动为准 */
  private applyOpen(): void {
    const path = new Set<Item>();
    for (let p = this.active; p; p = p.parent) path.add(p);
    for (const item of this.items) {
      if (!item.entry.children.length) continue;
      item.li.classList.toggle('open', item.open ?? path.has(item));
    }
  }

  /** 当前条目滚出目录的可见区域时，把它滚回来（不用 scrollIntoView，以免带动页面滚动） */
  private revealActive(): void {
    const link = this.active?.link;
    if (!link || this.panel.hidden) return;
    const box = this.list.getBoundingClientRect();
    const r = link.getBoundingClientRect();
    if (r.top < box.top) this.list.scrollTop += r.top - box.top - 8;
    else if (r.bottom > box.bottom) this.list.scrollTop += r.bottom - box.bottom + 8;
  }

  private iconButton(label: string, svg: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    b.addEventListener('click', onClick);
    return b;
  }
}

/** 在导入的论文页面上加目录；没有任何节时不加 */
export function mountToc(article: Element, skip: (n: Node) => boolean): Toc | null {
  const entries = collectToc(article, skip);
  if (!entries.some((e) => e.target.localName === 'section')) return null;
  return new Toc(entries);
}
