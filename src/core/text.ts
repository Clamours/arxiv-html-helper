/**
 * 把一段 DOM 展平成"规范化文本 + 到 DOM 的映射"。
 *
 * - 连续空白折叠成一个空格，去掉开头空白（不同 LaTeXML 版本、翻译插件对空白的处理不一致）
 * - <math> 作为一个不可分割的整体，文本记为 `$alttext$`
 * - skip() 返回 true 的元素整棵子树跳过（用于分层：原文层跳过译文，反之亦然）
 */

export type TextChunk =
  | {
      kind: 'text';
      node: Text;
      start: number;
      end: number;
      /** 原始偏移 → 规范化偏移（块内绝对值） */
      toNorm: number[];
      /** 规范化偏移（相对 start）→ 原始偏移 */
      toRaw: number[];
    }
  | { kind: 'atom'; el: Element; start: number; end: number };

export interface TextMap {
  text: string;
  chunks: TextChunk[];
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'img', 'button', 'input', 'textarea', 'select']);
const WS = /\s/;

export function atomText(el: Element): string {
  const tex = el.getAttribute('alttext') ?? el.textContent ?? '';
  return `$${tex.trim()}$`;
}

export function isAtom(el: Element): boolean {
  return el.localName === 'math';
}

export function buildTextMap(roots: Element[], skip: (el: Element) => boolean): TextMap {
  let out = '';
  let lastSpace = true;
  const chunks: TextChunk[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text;
      const raw = t.data;
      const start = out.length;
      const toNorm: number[] = new Array(raw.length);
      const toRaw: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i]!;
        toNorm[i] = out.length;
        if (WS.test(c)) {
          if (lastSpace) continue;
          out += ' ';
          lastSpace = true;
        } else {
          out += c;
          lastSpace = false;
        }
        toRaw.push(i);
      }
      chunks.push({ kind: 'text', node: t, start, end: out.length, toNorm, toRaw });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.localName) || skip(el)) return;
    if (isAtom(el)) {
      const start = out.length;
      out += atomText(el);
      lastSpace = false;
      chunks.push({ kind: 'atom', el, start, end: out.length });
      return;
    }
    for (let c = el.firstChild; c; c = c.nextSibling) visit(c);
  };

  for (const r of roots) {
    for (let c = r.firstChild; c; c = c.nextSibling) visit(c);
  }
  return { text: out, chunks };
}

function rawToNorm(chunk: Extract<TextChunk, { kind: 'text' }>, rawOffset: number): number {
  return rawOffset >= chunk.toNorm.length ? chunk.end : chunk.toNorm[rawOffset]!;
}

function normToRaw(chunk: Extract<TextChunk, { kind: 'text' }>, n: number): number {
  return n >= chunk.end ? chunk.node.data.length : chunk.toRaw[n - chunk.start]!;
}

/** DOM Range 与该 TextMap 的交集，返回规范化偏移（已去掉首尾空格）；没有交集返回 null */
export function rangeToOffsets(range: Range, map: TextMap): { start: number; end: number } | null {
  let s = Infinity;
  let e = -Infinity;
  for (const ch of map.chunks) {
    if (ch.kind === 'text') {
      if (!range.intersectsNode(ch.node)) continue;
      const rs = ch.node === range.startContainer ? range.startOffset : 0;
      const re = ch.node === range.endContainer ? range.endOffset : ch.node.data.length;
      const ns = rawToNorm(ch, rs);
      const ne = rawToNorm(ch, re);
      if (ne <= ns) continue;
      s = Math.min(s, ns);
      e = Math.max(e, ne);
    } else if (range.intersectsNode(ch.el)) {
      s = Math.min(s, ch.start);
      e = Math.max(e, ch.end);
    }
  }
  while (s < e && map.text[s] === ' ') s++;
  while (e > s && map.text[e - 1] === ' ') e--;
  return s < e ? { start: s, end: e } : null;
}

/** 规范化偏移 → DOM Range。落在公式内部的偏移会扩展到整个公式。 */
export function offsetsToRange(map: TextMap, start: number, end: number): Range | null {
  if (end <= start) return null;
  const startChunk = map.chunks.find((c) => c.end > start);
  const endChunk = map.chunks.find((c) => c.end >= end && c.start < end);
  if (!startChunk || !endChunk) return null;
  const doc = startChunk.kind === 'text' ? startChunk.node.ownerDocument : startChunk.el.ownerDocument;
  const range = doc.createRange();
  if (startChunk.kind === 'text') range.setStart(startChunk.node, normToRaw(startChunk, Math.max(start, startChunk.start)));
  else range.setStartBefore(startChunk.el);
  if (endChunk.kind === 'text') range.setEnd(endChunk.node, normToRaw(endChunk, end));
  else range.setEndAfter(endChunk.el);
  return range;
}
