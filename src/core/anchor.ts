import search from 'approx-string-match';
import { BLOCK_SELECTOR, elementKey, isBlock, resolveElementKey } from './blocks';
import type { DocContext } from './context';
import { offsetsToRange, rangeToOffsets, type TextMap } from './text';
import type { AnchorStatus, Annotation, Layer, Segment } from './types';

const CONTEXT_LEN = 32;

// ---------------------------------------------------------------------------
// Range → Segment[]
// ---------------------------------------------------------------------------

export interface Described {
  layer: Layer;
  segments: Segment[];
}

/**
 * 把用户选区描述成可持久化的片段。选区的层由其中第一个非空白文本决定，
 * 跨到另一层的部分会被裁掉；跨多个块时按块拆分。
 */
export function describeRange(range: Range, ctx: DocContext): Described | null {
  const first = firstTextIn(range, ctx);
  if (!first) return null;
  const layer = ctx.layerOf(first);
  const units = layer === 'source' ? sourceBlocksIn(range, ctx) : translatedSourcesIn(range, ctx);

  const segments: Segment[] = [];
  for (const el of units) {
    const map = ctx.textMap(el, layer);
    const off = rangeToOffsets(range, map);
    if (!off) continue;
    const seg: Segment = {
      blockKey: elementKey(el, ctx.root, ctx.isForeign),
      position: off,
      quote: quoteAt(map.text, off.start, off.end),
    };
    if (layer === 'translation') {
      seg.translation = {
        provider: ctx.translationRootsOf(el)[0]?.adapter.id ?? 'unknown',
        snapshot: map.text,
      };
    }
    segments.push(seg);
  }
  return segments.length ? { layer, segments } : null;
}

function quoteAt(text: string, start: number, end: number): Segment['quote'] {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: text.slice(end, end + CONTEXT_LEN),
  };
}

function firstTextIn(range: Range, ctx: DocContext): Text | null {
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
    const t = range.commonAncestorContainer as Text;
    return t.data.slice(range.startOffset, range.endOffset).trim() ? t : null;
  }
  const doc = range.startContainer.ownerDocument ?? document;
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(n) || ctx.isOwnUi(n)) continue;
    const s = n === range.startContainer ? range.startOffset : 0;
    const e = n === range.endContainer ? range.endOffset : n.data.length;
    if (n.data.slice(s, e).trim()) return n;
  }
  return null;
}

function containerEl(range: Range): Element {
  const c = range.commonAncestorContainer;
  return c instanceof Element ? c : c.parentElement!;
}

function inDocOrder(els: Iterable<Element>): Element[] {
  return [...new Set(els)].sort((a, b) =>
    a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function sourceBlocksIn(range: Range, ctx: DocContext): Element[] {
  const c = containerEl(range);
  const cands: Element[] = [];
  for (let up: Element | null = c; up && ctx.root.contains(up); up = up.parentElement) {
    if (isBlock(up)) cands.push(up);
  }
  cands.push(...Array.from(c.querySelectorAll(BLOCK_SELECTOR)));
  return inDocOrder(cands.filter((b) => !ctx.isForeign(b) && range.intersectsNode(b)));
}

function translatedSourcesIn(range: Range, ctx: DocContext): Element[] {
  const roots = ctx.translationRootsIn(containerEl(range)).filter((t) => range.intersectsNode(t.root));
  return inDocOrder(roots.map((t) => t.source));
}

// ---------------------------------------------------------------------------
// Segment → Range
// ---------------------------------------------------------------------------

export type SegmentResult =
  | { status: 'anchored'; range: Range; how: 'position' | 'quote' | 'fuzzy' | 'relocated' }
  /** 该层当前不可见：译文层没有译文，或原文层处于仅译文模式 */
  | { status: 'waiting' }
  | { status: 'orphaned' };

export function anchorSegment(seg: Segment, layer: Layer, ctx: DocContext): SegmentResult {
  const el = resolveElementKey(seg.blockKey, ctx.root, ctx.isForeign);
  if (el) {
    const map = ctx.textMap(el, layer);
    if (layer === 'translation' && !map.chunks.length) return { status: 'waiting' };
    if (layer === 'source' && ctx.isSourceHidden(el)) return { status: 'waiting' };
    const hit = matchQuote(map, seg, layer);
    if (hit) {
      const range = offsetsToRange(map, hit.start, hit.end);
      if (range) return { status: 'anchored', range, how: hit.how };
    }
  } else if (layer === 'translation') {
    return { status: 'orphaned' };
  }

  // 原文层兜底：块 key 失效（论文换了版本）时在全文精确搜索
  if (layer === 'source') {
    for (const block of ctx.allSourceBlocks()) {
      if (block === el) continue;
      const map = ctx.textMap(block, 'source');
      const i = map.text.indexOf(seg.quote.exact);
      if (i < 0) continue;
      const range = offsetsToRange(map, i, i + seg.quote.exact.length);
      if (range) return { status: 'anchored', range, how: 'relocated' };
    }
  }
  return { status: 'orphaned' };
}

interface Hit {
  start: number;
  end: number;
  how: 'position' | 'quote' | 'fuzzy';
}

export function matchQuote(map: TextMap, seg: Segment, layer: Layer): Hit | null {
  const { text } = map;
  const { exact } = seg.quote;
  const { start, end } = seg.position;
  if (text.slice(start, end) === exact) return { start, end, how: 'position' };

  // 精确匹配：多处出现时，用上下文和原位置距离挑最像的
  let best: { start: number; score: number } | null = null;
  for (let i = text.indexOf(exact); i >= 0; i = text.indexOf(exact, i + 1)) {
    const score = contextScore(text, i, i + exact.length, seg) - Math.abs(i - start) / (text.length + 1);
    if (!best || score > best.score) best = { start: i, score };
  }
  if (best) return { start: best.start, end: best.start + exact.length, how: 'quote' };

  // 模糊匹配：译文重新翻译后措辞可能略有不同，放宽容错
  if (exact.length < 4) return null;
  const ratio = layer === 'translation' ? 0.35 : 0.2;
  const maxErrors = Math.floor(exact.length * ratio);
  const matches = search(text, exact, maxErrors);
  let fuzzy: { start: number; end: number; score: number } | null = null;
  for (const m of matches) {
    const score = contextScore(text, m.start, m.end, seg) - (m.errors / exact.length) * 2;
    if (!fuzzy || score > fuzzy.score) fuzzy = { start: m.start, end: m.end, score };
  }
  return fuzzy ? { start: fuzzy.start, end: fuzzy.end, how: 'fuzzy' } : null;
}

/** 前后文与记录的 prefix/suffix 吻合的程度，0~2 */
function contextScore(text: string, start: number, end: number, seg: Segment): number {
  const { prefix, suffix } = seg.quote;
  let p = 0;
  while (p < prefix.length && text[start - 1 - p] === prefix[prefix.length - 1 - p]) p++;
  let s = 0;
  while (s < suffix.length && text[end + s] === suffix[s]) s++;
  return (prefix.length ? p / prefix.length : 1) + (suffix.length ? s / suffix.length : 1);
}

// ---------------------------------------------------------------------------
// 整条笔记
// ---------------------------------------------------------------------------

export interface Anchored {
  annotation: Annotation;
  ranges: Range[];
  status: AnchorStatus;
}

export function anchorAnnotation(ann: Annotation, ctx: DocContext): Anchored {
  const results = ann.segments.map((s) => anchorSegment(s, ann.layer, ctx));
  const ranges = results.flatMap((r) => (r.status === 'anchored' ? [r.range] : []));
  let status: AnchorStatus;
  if (ranges.length === results.length) status = 'anchored';
  else if (ranges.length) status = 'partial';
  else if (results.every((r) => r.status === 'waiting')) status = 'waiting';
  else status = 'orphaned';
  return { annotation: ann, ranges, status };
}
