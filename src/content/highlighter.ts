import { COLORS, type HighlightColor } from '@/core/types';

/**
 * 用 CSS Custom Highlight API 渲染高亮：不修改页面 DOM，
 * 因此不会干扰翻译插件，翻译插件重建 DOM 时也不会连带破坏我们的标记。
 */

const COLOR_CSS: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 214, 10, 0.45)',
  green: 'rgba(52, 199, 89, 0.35)',
  blue: 'rgba(10, 132, 255, 0.28)',
  pink: 'rgba(255, 55, 95, 0.28)',
  purple: 'rgba(175, 82, 222, 0.3)',
};

const name = (c: HighlightColor) => `ahh-${c}`;
const FOCUS = 'ahh-focus';

export function isSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

export class Highlighter {
  private byId = new Map<string, { color: HighlightColor; ranges: Range[] }>();
  private highlights = new Map<HighlightColor, Highlight>();
  private focus = new Highlight();

  constructor() {
    for (const c of COLORS) {
      const h = new Highlight();
      this.highlights.set(c, h);
      CSS.highlights.set(name(c), h);
    }
    this.focus.priority = 1;
    CSS.highlights.set(FOCUS, this.focus);
    this.injectStyle();
  }

  private injectStyle(): void {
    const style = document.createElement('style');
    style.dataset.ahh = '';
    style.textContent =
      COLORS.map((c) => `::highlight(${name(c)}) { background-color: ${COLOR_CSS[c]}; }`).join('\n') +
      `\n::highlight(${FOCUS}) { text-decoration: underline 2px; text-underline-offset: 3px; }`;
    (document.head ?? document.documentElement).append(style);
  }

  /** 整体替换当前所有高亮 */
  setAll(items: { id: string; color: HighlightColor; ranges: Range[] }[]): void {
    for (const h of this.highlights.values()) h.clear();
    this.byId.clear();
    for (const it of items) {
      this.byId.set(it.id, { color: it.color, ranges: it.ranges });
      const h = this.highlights.get(it.color)!;
      for (const r of it.ranges) h.add(r);
    }
    this.focus.clear();
  }

  setFocus(id: string | null): void {
    this.focus.clear();
    const it = id ? this.byId.get(id) : undefined;
    if (it) for (const r of it.ranges) this.focus.add(r);
  }

  /** 点击命中测试：Custom Highlight 没有事件，只能用坐标比对矩形 */
  hitTest(x: number, y: number): string | null {
    let found: string | null = null;
    for (const [id, it] of this.byId) {
      for (const r of it.ranges) {
        for (const rect of r.getClientRects()) {
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) found = id;
        }
      }
    }
    // 重叠时返回最后加入（通常是最新）的那条
    return found;
  }

  rangesOf(id: string): Range[] {
    return this.byId.get(id)?.ranges ?? [];
  }
}
