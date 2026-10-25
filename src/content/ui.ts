import { COLORS, type Annotation, type HighlightColor } from '@/core/types';
import { COLOR_SWATCH } from '@/shared/colors';
import { PENCIL_ICON, TRASH_ICON } from '@/shared/icons';

/**
 * 页面内的浮动 UI（划词工具栏、笔记编辑框），放在 Shadow DOM 里，
 * 并标记 notranslate / translate="no"，避免被翻译插件翻译。
 */

const CSS = `
:host { all: initial; }
.panel {
  --fg: #0d0d0d; --fg-2: #5d5d5d; --muted: #8f8f8f; --bg: #fff;
  --line: rgba(0,0,0,.08); --line-strong: rgba(0,0,0,.12); --hover: rgba(0,0,0,.05); --field: rgba(0,0,0,.025);
  --accent: #2383e2; --danger: #e5484d; --danger-bg: rgba(229,72,77,.08);
  position: absolute; z-index: 2147483647;
  /* 宿主元素宽度为 0，不指定的话会按最小内容宽度排版，把色块挤扁、文字折行 */
  width: max-content;
  box-sizing: border-box;
  font: 13px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased;
  color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,.06), 0 12px 32px rgba(0,0,0,.14);
  padding: 4px; display: flex; gap: 0; align-items: center;
  animation: pop-in .14s cubic-bezier(.2,.9,.3,1);
}
@keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
.editor { flex-direction: column; align-items: stretch; width: 320px; padding: 8px 10px 10px; gap: 8px; }
.row { display: flex; gap: 0; align-items: center; margin: 0 -4px; }
/* 色块：按钮里一个圆点，选中时外面一圈同色的环 */
.dot {
  flex: none; box-sizing: border-box; width: 30px; height: 30px; padding: 0;
  display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; cursor: pointer;
}
.dot::before {
  content: ""; width: 16px; height: 16px; border-radius: 50%;
  background: var(--c); box-shadow: inset 0 0 0 1px rgba(0,0,0,.1);
  transition: transform .12s ease;
}
.dot:hover::before { transform: scale(1.15); }
.dot[aria-pressed="true"]::before { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--c); }
.dot:focus-visible, .icon-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.sep { flex: none; width: 1px; height: 18px; background: var(--line-strong); margin: 0 4px; }
.icon-btn {
  flex: none; box-sizing: border-box; width: 30px; height: 30px; padding: 0;
  display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: var(--fg-2); cursor: pointer;
  transition: background-color .15s, color .15s;
}
.icon-btn:hover { background: var(--hover); color: var(--fg); }
.icon-btn svg { width: 18px; height: 18px; }
.icon-btn.danger { margin-left: auto; color: var(--muted); }
.icon-btn.danger:hover { color: var(--danger); background: var(--danger-bg); }
/* 引文：左侧一道当前颜色的竖条，最多三行 */
.quote {
  position: relative; padding-left: 12px; color: var(--fg-2);
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.quote::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 3px; border-radius: 3px; background: var(--c); }
textarea {
  font: inherit; color: inherit; resize: vertical; min-height: 84px; box-sizing: border-box;
  border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 10px;
  background: var(--field); outline: none; transition: border-color .15s, box-shadow .15s;
}
textarea::placeholder { color: var(--muted); }
textarea:focus { border-color: color-mix(in srgb, var(--accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent); }
@media (prefers-color-scheme: dark) {
  .panel {
    --fg: #ececec; --fg-2: #b4b4b4; --muted: #8e8e8e; --bg: #2f2f2f;
    --line: rgba(255,255,255,.1); --line-strong: rgba(255,255,255,.14); --hover: rgba(255,255,255,.08); --field: rgba(255,255,255,.04);
    --accent: #4c9ff0; --danger: #ff6369; --danger-bg: rgba(255,99,105,.12);
    box-shadow: 0 4px 12px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.45);
  }
  .dot::before { box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
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

    // 引文左侧的竖条跟随当前颜色
    const q = document.createElement('div');
    q.className = 'quote';
    q.textContent = quote;
    q.style.setProperty('--c', COLOR_SWATCH[ann.color]);

    const colors = document.createElement('div');
    colors.className = 'row';
    const dots = COLORS.map((c) => {
      const d = this.dot(c, c === ann.color, () => {
        dots.forEach((x) => x.setAttribute('aria-pressed', String(x === d)));
        q.style.setProperty('--c', COLOR_SWATCH[c]);
        h.onColor(c);
      });
      return d;
    });
    colors.append(...dots);
    const del = this.iconButton('删除', TRASH_ICON, () => h.onDelete());
    del.classList.add('danger');
    colors.append(del);

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
    b.style.setProperty('--c', COLOR_SWATCH[c]);
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
