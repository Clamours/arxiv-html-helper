import { BLOCK_SELECTOR, elementKey, resolveElementKey } from '@/core/blocks';
import type { DocContext, TranslationAdapter, TranslationRoot } from '@/core/context';
import { buildTextMap } from '@/core/text';
import {
  emptyTranslations,
  entryKey,
  fragmentToHtml,
  hashText,
  mergeTranslations,
  parseSavedHtml,
  SAVED_WRAPPER_CLASS,
  sanitizeTranslation,
  type PaperTranslations,
  type SavedBlock,
  type SavedSummary,
} from '@/core/translations';

/**
 * 页面上的译文存档（数据模型见 src/core/translations.ts）：
 *
 * - 采集：翻译插件的译文连续 STABLE_MS 没有变化（AI 翻译是流式输出的）、也没有加载动画时，
 *   清洗后存档。已经有存档的段落不再采集（存档优先）
 * - 显示：有存档的段落，把存档以自己的 wrapper 追加到原文块末尾（结构同翻译插件的双语模式），
 *   并隐藏同一段里翻译插件的译文。翻译插件的译文与存档一字不差时不插入，照常显示插件的译文
 * - 仅译文模式下翻译插件直接改写了原文节点，没法隐藏，这些段落不显示存档，译文层笔记照旧定位
 *
 * 存档的 wrapper 由 adapters 里的 savedTranslation 适配器识别，分层、块 key、定位逻辑不需要改动。
 */

/** 译文连续这么久没有变化才存档 */
export const STABLE_MS = 2000;

/** 存档显示时，同一段里翻译插件的 wrapper 加上这个属性隐藏 */
const SUPERSEDED = 'data-ahh-superseded';

export interface SavedHooks {
  /** 新采集到的译文，需要写入存档 */
  persist(blocks: SavedBlock[]): void;
  /** 有译文还在变化，过一会儿再检查一次 */
  recheckIn(ms: number): void;
}

export function isSavedWrapper(n: Node): boolean {
  return n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains(SAVED_WRAPPER_CLASS);
}

/** 存档 wrapper 的样式；翻译插件的 wrapper 出现在存档之后时，在下一次检查之前先隐藏，避免闪一下两份译文 */
export function injectSavedStyle(doc: Document, live: TranslationAdapter[]): void {
  const style = doc.createElement('style');
  style.dataset.ahh = '';
  const liveSel = live.map((a) => a.wrapperSelector).join(', ');
  style.textContent =
    `.${SAVED_WRAPPER_CLASS} { display: block; margin-top: 0.3em; }\n` +
    `[${SUPERSEDED}]${liveSel ? `, .${SAVED_WRAPPER_CLASS} ~ :is(${liveSel})` : ''} { display: none !important; }`;
  (doc.head ?? doc.documentElement).append(style);
}

export class SavedTranslations {
  private record: PaperTranslations;
  private visible = true;
  /** 已采集、还没确认写入存档的译文 */
  private unsaved = new Map<string, SavedBlock>();
  /** 原文块 → 原文哈希。原文被仅译文模式改写后就算不出来了，所以记住第一次算出的 */
  private hashes = new WeakMap<Element, string>();
  /** 等待稳定的译文：entryKey → 文本、首次看到的时间 */
  private candidates = new Map<string, { text: string; since: number }>();
  /** 存档的规范化文本，按 `${entryKey}@${capturedAt}` 缓存 */
  private archiveTexts = new Map<string, string>();
  private shown = 0;

  constructor(
    private readonly ctx: DocContext,
    paperId: string,
    private readonly hooks: SavedHooks,
    private readonly now: () => number = Date.now,
  ) {
    this.record = emptyTranslations(paperId);
  }

  /** 页面加载时调用：在翻译插件改写原文之前记下各块的原文哈希 */
  prime(): void {
    for (const b of this.ctx.allSourceBlocks()) this.sourceHash(b);
  }

  /** 换成存档的最新内容（本机写入后、其他电脑同步过来后）。返回存档是否有变化 */
  setRecord(rec: PaperTranslations): boolean {
    const before = signature(this.record);
    // 还没确认写入的继续保留；被更早的存档取代或已作废的丢掉
    this.record = mergeTranslations(rec, { paperId: rec.paperId, blocks: Object.fromEntries(this.unsaved), clearedAt: 0 });
    for (const [k, b] of this.unsaved) if (this.record.blocks[k] !== b) this.unsaved.delete(k);
    return signature(this.record) !== before;
  }

  /** 写入存档成功：这些不再算未确认 */
  acknowledge(blocks: SavedBlock[]): void {
    for (const b of blocks) if (this.unsaved.get(entryKey(b)) === b) this.unsaved.delete(entryKey(b));
  }

  setVisible(v: boolean): void {
    this.visible = v;
  }

  summary(): SavedSummary {
    return { total: Object.keys(this.record.blocks).length, shown: this.shown, visible: this.visible };
  }

  /** 每次 DOM 变化后、重新定位前调用（ctx 的缓存需已重置）。返回是否改动了页面 */
  update(): boolean {
    const live = this.liveRoots();
    this.capture(live);
    return this.render(live);
  }

  private sourceHash(block: Element): string | null {
    const known = this.hashes.get(block);
    if (known) return known;
    if (this.ctx.isInPlace(block)) return null;
    const { text } = this.ctx.textMap(block, 'source');
    if (!text.trim()) return null;
    const h = hashText(text);
    this.hashes.set(block, h);
    return h;
  }

  /** 翻译插件的译文，按原文块分组 */
  private liveRoots(): Map<Element, TranslationRoot[]> {
    const by = new Map<Element, TranslationRoot[]>();
    for (const t of this.ctx.translationRootsIn(this.ctx.root)) {
      if (t.adapter.preferred) continue;
      by.set(t.source, [...(by.get(t.source) ?? []), t]);
    }
    return by;
  }

  private capture(live: Map<Element, TranslationRoot[]>): void {
    const doc = this.ctx.root.ownerDocument;
    const now = this.now();
    const fresh: SavedBlock[] = [];
    const seen = new Set<string>();
    let waiting = false;
    for (const [source, roots] of live) {
      if (this.ctx.hasPendingTranslation(source)) continue;
      const sourceHash = this.sourceHash(source);
      if (!sourceHash) continue;
      const blockKey = elementKey(source, this.ctx.root, this.ctx.isForeign);
      const key = entryKey({ blockKey, sourceHash });
      if (this.record.blocks[key]) continue;
      const { text } = this.ctx.translationMapOf(source, roots);
      if (!text.trim()) continue;
      seen.add(key);
      const cand = this.candidates.get(key);
      if (!cand || cand.text !== text) {
        this.candidates.set(key, { text, since: now });
        waiting = true;
        continue;
      }
      if (now - cand.since < STABLE_MS) {
        waiting = true;
        continue;
      }
      this.candidates.delete(key);
      const html = fragmentToHtml(sanitizeTranslation(this.contentOf(roots), doc), doc);
      if (!html.trim()) continue;
      const block: SavedBlock = { blockKey, sourceHash, provider: roots[0]!.adapter.id, html, capturedAt: now };
      this.record.blocks[key] = block;
      this.unsaved.set(key, block);
      fresh.push(block);
    }
    for (const k of this.candidates.keys()) if (!seen.has(k)) this.candidates.delete(k);
    if (fresh.length) this.hooks.persist(fresh);
    if (waiting) this.hooks.recheckIn(STABLE_MS);
  }

  /** 译文的节点。原地替换的块要去掉嵌套的子块和注入的元素，所以先复制一份 */
  private contentOf(roots: TranslationRoot[]): Node[] {
    return roots.flatMap((t) => {
      if (t.kind === 'wrapper') return Array.from(t.root.childNodes);
      const clone = t.root.cloneNode(true) as Element;
      for (const el of Array.from(clone.querySelectorAll('*'))) {
        if (el.matches(BLOCK_SELECTOR) || this.ctx.isForeign(el)) el.remove();
      }
      return Array.from(clone.childNodes);
    });
  }

  private archiveText(key: string, b: SavedBlock): string {
    const k = `${key}@${b.capturedAt}`;
    let text = this.archiveTexts.get(k);
    if (text === undefined) {
      const doc = this.ctx.root.ownerDocument;
      const div = doc.createElement('div');
      div.append(parseSavedHtml(b.html, doc));
      text = buildTextMap([div], () => false).text;
      this.archiveTexts.set(k, text);
    }
    return text;
  }

  private render(live: Map<Element, TranslationRoot[]>): boolean {
    const doc = this.ctx.root.ownerDocument;
    const want = new Map<Element, { block: SavedBlock; tag: string; done: boolean }>();
    if (this.visible) {
      for (const [key, b] of Object.entries(this.record.blocks)) {
        const el = resolveElementKey(b.blockKey, this.ctx.root, this.ctx.isForeign);
        if (!el || want.has(el) || this.ctx.isInPlace(el) || this.sourceHash(el) !== b.sourceHash) continue;
        const tag = `${key}@${b.capturedAt}`;
        const roots = live.get(el);
        // 与存档一致：照常显示翻译插件的译文（保留插件自己的样式）。已经显示着存档的段落不再改回去：
        // 陪读蛙会把段落里的存档也当作原文，插入、移除存档都会让它重翻、译文随之变化，来回切换就停不下来
        if (roots?.length && !isShowing(el, tag) && this.ctx.translationMapOf(el, roots).text === this.archiveText(key, b)) {
          continue;
        }
        want.set(el, { block: b, tag, done: false });
      }
    }

    let changed = false;
    for (const w of Array.from(this.ctx.root.querySelectorAll(`.${SAVED_WRAPPER_CLASS}`))) {
      const it = w.parentElement ? want.get(w.parentElement) : undefined;
      if (it && !it.done && (w as HTMLElement).dataset.ahhEntry === it.tag) {
        it.done = true;
        continue;
      }
      w.remove();
      changed = true;
    }
    for (const [el, it] of want) {
      if (it.done) continue;
      const w = doc.createElement('span');
      w.className = `notranslate ${SAVED_WRAPPER_CLASS}`;
      w.setAttribute('translate', 'no');
      w.dataset.ahhEntry = it.tag;
      w.append(parseSavedHtml(it.block.html, doc));
      el.append(w);
      changed = true;
    }

    for (const [source, roots] of live) {
      const hide = want.has(source);
      for (const t of roots) {
        if (t.kind !== 'wrapper' || hide === t.root.hasAttribute(SUPERSEDED)) continue;
        if (hide) t.root.setAttribute(SUPERSEDED, '');
        else t.root.removeAttribute(SUPERSEDED);
      }
    }
    this.shown = want.size;
    return changed;
  }
}

/** 原文块里已经插着这一版存档 */
const isShowing = (block: Element, tag: string) =>
  Array.from(block.children).some((c) => isSavedWrapper(c) && (c as HTMLElement).dataset.ahhEntry === tag);

const signature = (r: PaperTranslations) =>
  `${r.clearedAt}|${Object.entries(r.blocks).map(([k, b]) => `${k}@${b.capturedAt}`).sort().join(',')}`;
