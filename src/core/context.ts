import { BLOCK_SELECTOR, blockOf, isBlock } from './blocks';
import { buildTextMap, type TextMap } from './text';
import type { Layer } from './types';

/**
 * 翻译插件适配器（纯配置）。两个插件在 arXiv 上的行为（见 docs/translators.md）：
 * - 双语模式：把译文 wrapper 追加到原文段落内部末尾
 * - 仅译文模式：优先直接把原文文本节点改写成译文，只在段落上打一个标记属性；
 *   失败时退回为插入 wrapper 并移除原文节点
 */
export interface TranslationAdapter {
  id: string;
  name: string;
  /** 注入的译文最外层元素 */
  wrapperSelector: string;
  /** 仅译文模式下，原文被原地替换成译文的元素上的标记 */
  inPlaceSelector: string;
  /** 注入的其他元素（加载动画、错误提示），两层文本都忽略 */
  ignoreSelector?: string;
  /** 同一个原文块同时有它和其他来源的译文时，只用它（本扩展的译文存档） */
  preferred?: boolean;
}

export interface TranslationRoot {
  /** 译文所在的元素：wrapper，或被原地替换的块 */
  root: Element;
  /** 译文对应的原文元素（笔记挂靠的块） */
  source: Element;
  adapter: TranslationAdapter;
  kind: 'wrapper' | 'in-place';
}

const join = (xs: (string | undefined)[]) => xs.filter(Boolean).join(',');

/** 定位所需的页面环境 */
export class DocContext {
  private readonly wrapperSel: string;
  private readonly inPlaceSel: string;
  private readonly injectedSel: string;
  private readonly ignoreSel: string;

  constructor(
    readonly root: Element,
    readonly adapters: TranslationAdapter[],
    private readonly ownUi: (node: Node) => boolean = () => false,
  ) {
    this.wrapperSel = join(adapters.map((a) => a.wrapperSelector));
    this.inPlaceSel = join(adapters.map((a) => a.inPlaceSelector));
    this.ignoreSel = join(adapters.map((a) => a.ignoreSelector));
    this.injectedSel = join([this.wrapperSel, this.ignoreSel]);
  }

  isOwnUi(node: Node): boolean {
    return this.ownUi(node);
  }

  /**
   * 不属于页面原始结构的节点（翻译插件注入的元素、我们的 UI）。
   * 计算块 key、枚举块时要排除它们，否则译文出现与否会改变序号。
   * 注意：原地替换的段落本身仍是原始结构，不算。
   */
  isForeign = (node: Node): boolean => {
    if (this.ownUi(node)) return true;
    if (!this.injectedSel) return false;
    return !!toEl(node)?.closest(this.injectedSel);
  };

  /** 节点所在的译文；不在译文里返回 null */
  translationRootOf(node: Node): TranslationRoot | null {
    const el = toEl(node);
    if (!el) return null;
    if (this.wrapperSel) {
      let w = el.closest(this.wrapperSel);
      if (w) {
        for (let up = w.parentElement?.closest(this.wrapperSel); up; up = up.parentElement?.closest(this.wrapperSel)) w = up;
        const source = blockOf(w.parentElement!, this.root);
        if (source) return { root: w, source, adapter: this.adapterFor(w, 'wrapperSelector'), kind: 'wrapper' };
      }
    }
    const b = this.inPlaceBlockOf(el);
    return b ? { root: b.block, source: b.block, adapter: b.adapter, kind: 'in-place' } : null;
  }

  /**
   * 被原地替换成译文的块。标记可能打在块本身、块的祖先，
   * 也可能打在块内部的某个行内元素上（陪读蛙会标在"最后一个原文节点的父元素"上）。
   */
  private inPlaceBlockOf(el: Element): { block: Element; adapter: TranslationAdapter } | null {
    if (!this.inPlaceSel) return null;
    const marked = el.closest(this.inPlaceSel);
    if (marked) {
      const block = blockOf(marked, this.root) ?? marked;
      return { block, adapter: this.adapterFor(marked, 'inPlaceSelector') };
    }
    const block = blockOf(el, this.root);
    if (!block) return null;
    for (const m of block.querySelectorAll(this.inPlaceSel)) {
      if (blockOf(m, this.root) === block && !this.isForeign(m)) {
        return { block, adapter: this.adapterFor(m, 'inPlaceSelector') };
      }
    }
    return null;
  }

  private adapterFor(el: Element, key: 'wrapperSelector' | 'inPlaceSelector'): TranslationAdapter {
    return this.adapters.find((a) => a[key] && el.matches(a[key]))!;
  }

  layerOf(node: Node): Layer {
    return this.translationRootOf(node) ? 'translation' : 'source';
  }

  /** within 内（含 within 自身所在）的所有译文 */
  translationRootsIn(within: Element): TranslationRoot[] {
    const found = new Map<Element, TranslationRoot>();
    const add = (n: Node) => {
      const t = this.translationRootOf(n);
      if (t && !found.has(t.root)) found.set(t.root, t);
    };
    add(within);
    const sel = join([this.wrapperSel, this.inPlaceSel]);
    if (sel) for (const el of within.querySelectorAll(sel)) add(el);
    return [...found.values()];
  }

  /** 某个原文元素的译文（有 preferred 来源的译文时只返回它） */
  translationRootsOf(source: Element): TranslationRoot[] {
    const all = this.allTranslationRootsOf(source);
    const preferred = all.filter((t) => t.adapter.preferred);
    return preferred.length ? preferred : all;
  }

  /** 某个原文元素的所有译文，不论来源 */
  allTranslationRootsOf(source: Element): TranslationRoot[] {
    const inPlace = this.inPlaceBlockOf(source);
    if (inPlace?.block === source) {
      return [{ root: source, source, adapter: inPlace.adapter, kind: 'in-place' }];
    }
    if (!this.wrapperSel) return [];
    return this.translationRootsIn(source).filter((t) => t.kind === 'wrapper' && t.source === source);
  }

  /** 块是否被原地替换成了译文（仅译文模式） */
  isInPlace(block: Element): boolean {
    return !!this.inPlaceBlockOf(block);
  }

  /** 块里有翻译插件的加载动画或错误提示（译文还没出来或出错了） */
  hasPendingTranslation(block: Element): boolean {
    return !!this.ignoreSel && !!block.querySelector(this.ignoreSel);
  }

  /** 原文是否被翻译插件隐藏/替换（仅译文模式） */
  isSourceHidden(block: Element): boolean {
    if (this.inPlaceBlockOf(block)) return true;
    return !this.textMap(block, 'source').chunks.some((c) => c.end > c.start) && this.translationRootsOf(block).length > 0;
  }

  sourceBlockOf(node: Node): Element | null {
    return blockOf(node, this.root);
  }

  allSourceBlocks(): Element[] {
    return Array.from(this.root.querySelectorAll(BLOCK_SELECTOR)).filter((b) => !this.isForeign(b));
  }

  private cache = new WeakMap<Element, Partial<Record<Layer, TextMap>>>();

  /** 每次 DOM 变化后、重新定位前调用 */
  resetCache(): void {
    this.cache = new WeakMap();
  }

  /**
   * 某个元素在某一层的文本。
   * - 原文层：元素自身，跳过注入元素和嵌套的子块（子块自己单独成块）；被原地替换时为空
   * - 译文层：该元素对应的所有译文
   */
  textMap(el: Element, layer: Layer): TextMap {
    let entry = this.cache.get(el);
    if (!entry) this.cache.set(el, (entry = {}));
    const hit = entry[layer];
    if (hit) return hit;
    const map = layer === 'source' ? this.buildSource(el) : this.buildTranslation(el);
    entry[layer] = map;
    return map;
  }

  private buildSource(el: Element): TextMap {
    if (this.inPlaceBlockOf(el)) return { text: '', chunks: [] };
    return buildTextMap([el], (child) => child !== el && (this.isForeign(child) || isBlock(child)));
  }

  private buildTranslation(el: Element): TextMap {
    return this.translationMapOf(el, this.translationRootsOf(el));
  }

  /** 指定的几份译文合起来的文本（不缓存） */
  translationMapOf(el: Element, roots: TranslationRoot[]): TextMap {
    return buildTextMap(
      roots.map((t) => t.root),
      (child) =>
        this.ownUi(child) ||
        (!!this.ignoreSel && child.matches(this.ignoreSel)) ||
        // 原地替换的块里，嵌套子块和注入元素不属于本块译文
        (roots[0]?.kind === 'in-place' && child !== el && (isBlock(child) || this.isForeign(child))),
    );
  }
}

function toEl(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}
