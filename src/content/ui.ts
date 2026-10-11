import { COLORS, type Annotation, type HighlightColor } from '@/core/types';
import { PENCIL_ICON, TRASH_ICON } from '@/shared/icons';
import { COLOR_SWATCH } from './highlighter';

/**
 * 页面内的浮动 UI（划词工具栏、笔记编辑框），放在 Shadow DOM 里，
 * 并标记 notranslate / translate="no"，避免被翻译插件翻译。
 */

const CSS = `
:host { all: initial; }
.panel {
  position: absolute; z-index: 2147483647;
  /* 宿主元素宽度为 0，不指定的话会按最小内容宽度排版，把色块挤扁、文字折行 */
  width: max-content;
  box-sizing: border-box;
  font: 13px/1.4 system-ui, -apple-system, "PingFang SC", sans-serif;
  color: #1d1d1f; background: #fff; border: 1px solid rgba(0,0,0,.12);
  border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
  padding: 6px; display: flex; gap: 6px; align-items: center;
}
.editor { flex-direction: column; align-items: stretch; width: 300px; padding: 10px; gap: 8px; }
.row { display: flex; gap: 6px; align-items: center; }
.dot {
  flex: none; box-sizing: border-box; width: 22px; height: 22px; padding: 0;
  border-radius: 50%; border: 2px solid transparent; cursor: pointer;
  transition: transform .12s ease;
}
.dot:hover { transform: scale(1.12); }
.dot:focus-visible, .icon-btn:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
.dot[aria-pressed="true"] { border-color: #1d1d1f; }
.sep { flex: none; width: 1px; height: 18px; background: currentColor; opacity: .15; margin: 0 1px; }
.icon-btn {
  flex: none; box-sizing: border-box; width: 30px; height: 30px; padding: 0;
  display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer;
}
.icon-btn:hover { background: rgba(0,0,0,.06); }
.icon-btn svg { width: 22px; height: 22px; }
.icon-btn.danger { margin-left: auto; color: #86868b; }
.icon-btn.danger:hover { color: #d70015; background: rgba(215,0,21,.08); }
.quote { color: #6e6e73; max-height: 4.2em; overflow: hidden; border-left: 3px solid #d2d2d7; padding-left: 8px; }
textarea { font: inherit; resize: vertical; min-height: 72px; border: 1px solid #d2d2d7; border-radius: 6px; padding: 6px; }
@media (prefers-color-scheme: dark) {
  .panel { color: #f5f5f7; background: #2c2c2e; border-color: rgba(255,255,255,.12); }
  .dot[aria-pressed="true"] { border-color: #f5f5f7; }
  .icon-btn:hover { background: rgba(255,255,255,.1); }
  .icon-btn.danger { color: #8e8e93; }
  .icon-btn.danger:hover { color: #ff453a; background: rgba(255,69,58,.14); }
  textarea { background: #1c1c1e; color: inherit; border-color: #48484a; }
  .quote { color: #aeaeb2; border-color: #48484a; }
}
`;

const COLOR_NAME: Record<HighlightColor, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
  purple: '紫色',
};

export interface ToolbarHandlers {
  onColor(c: HighlightColor): void;
  onNote(): void;
}

export interface EditorHandlers {
  onColor(c: HighlightColor): void;
  onNote(text: string): void;
  onDelete(): void;
  onClose(): void;
}

export class PageUi {
  readonly host: HTMLElement;
  private shadow: ShadowRoot;
  private current: HTMLElement | null = null;
  private closeEditor: (() => void) | null = null;

  constructor() {
    this.host = document.createElement('arxiv-notes-ui');
    this.host.className = 'notranslate';
    this.host.setAttribute('translate', 'no');
    this.host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.shadow.append(style);
    document.documentElement.append(this.host);
  }

  contains(node: Node): boolean {
    return node === this.host || this.host.contains(node);
  }

  get isEditorOpen(): boolean {
    return this.closeEditor !== null;
  }

  hide(): void {
    const close = this.closeEditor;
    this.closeEditor = null;
    this.current?.remove();
    this.current = null;
    close?.();
  }

  showToolbar(anchor: DOMRect, h: ToolbarHandlers): void {
    this.hide();
    const el = this.panel('panel');
    for (const c of COLORS) el.append(this.dot(c, false, () => h.onColor(c)));
    const sep = document.createElement('span');
    sep.className = 'sep';
    const note = this.iconButton('记笔记', PENCIL_ICON, () => h.onNote());
    el.append(sep, note);
    // 不让点击工具栏清掉页面选区
    el.addEventListener('mousedown', (e) => e.preventDefault());
    this.place(el, anchor);
  }

  showEditor(anchor: DOMRect, ann: Annotation, quote: string, h: EditorHandlers): void {
    this.hide();
    const el = this.panel('panel editor');

    const colors = document.createElement('div');
    colors.className = 'row';
    const dots = COLORS.map((c) => {
      const d = this.dot(c, c === ann.color, () => {
        dots.forEach((x) => x.setAttribute('aria-pressed', String(x === d)));
        h.onColor(c);
      });
      return d;
    });
    colors.append(...dots);
    const del = this.iconButton('删除', TRASH_ICON, () => h.onDelete());
    del.classList.add('danger');
    colors.append(del);

    const q = document.createElement('div');
    q.className = 'quote';
    q.textContent = quote;

    const ta = document.createElement('textarea');
    ta.placeholder = '写点笔记…';
    ta.value = ann.note;
    let saved = ann.note;
    const save = () => {
      if (ta.value !== saved) h.onNote((saved = ta.value));
    };
    ta.addEventListener('blur', save);
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 避免触发页面/翻译插件的快捷键
      if (e.key === 'Escape') this.hide();
    });

    el.append(colors, q, ta);
    this.place(el, anchor);
    this.closeEditor = () => {
      save();
      h.onClose();
    };
    ta.focus({ preventScroll: true });
  }

  private panel(cls: string): HTMLElement {
    const el = document.createElement('div');
    el.className = cls;
    this.current = el;
    this.shadow.append(el);
    return el;
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

  private dot(c: HighlightColor, pressed: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'dot';
    b.title = COLOR_NAME[c];
    b.setAttribute('aria-label', `${COLOR_NAME[c]}高亮`);
    b.style.background = COLOR_SWATCH[c];
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onClick);
    return b;
  }

  /** 放在锚点矩形下方，超出视口时翻到上方；坐标换算成文档坐标以便随页面滚动 */
  private place(el: HTMLElement, anchor: DOMRect): void {
    const margin = 8;
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = Math.min(Math.max(margin, anchor.left), window.innerWidth - w - margin);
    let top = anchor.bottom + margin;
    if (top + hgt > window.innerHeight - margin) top = Math.max(margin, anchor.top - hgt - margin);
    left += window.scrollX;
    top += window.scrollY;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  /** 事件是否发生在我们的浮层内（Shadow DOM 下需要看 composedPath） */
  isInside(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }
}
