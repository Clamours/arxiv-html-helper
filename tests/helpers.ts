import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTERS } from '../src/adapters';
import { expect } from 'vitest';
import { anchorSegment, describeRange } from '../src/core/anchor';
import { DocContext, type TranslationAdapter } from '../src/core/context';

export function loadFixture(name = 'paper.html'): Element {
  document.body.innerHTML = readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  return document.querySelector('article')!;
}

export function makeCtx(root: Element, adapters: TranslationAdapter[] = ADAPTERS): DocContext {
  return new DocContext(root, adapters);
}

export const $ = (id: string) => document.getElementById(id)!;

function findText(el: Node, needle: string): { node: Text; index: number } {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    const i = n.data.indexOf(needle);
    if (i >= 0) return { node: n, index: i };
  }
  throw new Error(`text not found: ${needle}`);
}

/** 从 a 中 startNeedle 的开头，到 b 中 endNeedle 的结尾 */
export function rangeBetween(a: Node, startNeedle: string, b: Node = a, endNeedle: string = startNeedle): Range {
  const s = findText(a, startNeedle);
  const e = findText(b, endNeedle);
  const r = document.createRange();
  r.setStart(s.node, s.index);
  r.setEnd(e.node, e.index + endNeedle.length);
  return r;
}

export type Tool = 'immersive' | 'read-frog';

/** 按两个插件双语模式的真实结构，把译文追加到原文元素内部末尾 */
export function injectTranslation(source: Element, html: string, tool: Tool = 'immersive'): Element {
  const w = document.createElement(tool === 'immersive' ? 'font' : 'span');
  if (tool === 'immersive') {
    w.className = 'notranslate immersive-translate-target-wrapper';
    w.innerHTML =
      '<br><font class="notranslate immersive-translate-target-translation-block-wrapper" data-immersive-translate-translation-element-mark="1">' +
      `<font class="notranslate immersive-translate-target-inner" data-immersive-translate-translation-element-mark="1">${html}</font></font>`;
  } else {
    w.className = 'notranslate read-frog-translated-content-wrapper';
    w.dataset.readFrogTranslationMode = 'bilingual';
    w.innerHTML = `<br><span class="notranslate read-frog-translated-block-content">${html}</span>`;
  }
  source.append(w);
  return w;
}

/**
 * 模拟仅译文模式的原地替换：把原文元素的内容换成译文，并打上标记。
 * markOn 指定标记打在哪个元素上（陪读蛙会打在"最后一个原文节点的父元素"上）。
 */
export function translateInPlace(source: Element, html: string, tool: Tool = 'immersive', markOn?: string): void {
  source.innerHTML = html;
  const target = markOn ? source.querySelector(markOn)! : source;
  if (tool === 'immersive') target.setAttribute('data-imt-translation-only', '1');
  else target.setAttribute('data-read-frog-translation-only', '');
}

/**
 * 在每个原文块里随机选一段（可能跨相邻文本节点），describe → anchor 后应按偏移精确找回。
 * 返回检查过的片段数。
 */
export function roundTripRandomSelections(root: Element): number {
  const ctx = makeCtx(root);
  let rnd = 42;
  const rand = (n: number) => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd % n);

  let checked = 0;
  for (const block of ctx.allSourceBlocks()) {
    const texts: Text[] = [];
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
      if (n.data.trim() && ctx.sourceBlockOf(n) === block && !n.parentElement?.closest('math')) texts.push(n);
    }
    if (!texts.length) continue;
    const a = texts[rand(texts.length)]!;
    const b = texts[Math.min(texts.length - 1, texts.indexOf(a) + rand(3))]!;
    const r = document.createRange();
    r.setStart(a, rand(a.data.length));
    r.setEnd(b, b === a ? r.startOffset + 1 + rand(a.data.length - r.startOffset) : 1 + rand(b.data.length));
    const d = describeRange(r, ctx);
    if (!d) continue; // 只选中了空白
    for (const seg of d.segments) {
      const res = anchorSegment(seg, 'source', ctx);
      expect(res.status, seg.blockKey).toBe('anchored');
      if (res.status === 'anchored') {
        expect(res.how, seg.blockKey).toBe('position');
        expect(r.toString().replace(/\s+/g, ' ')).toContain(res.range.toString().replace(/\s+/g, ' ').trim());
      }
      checked++;
    }
  }
  return checked;
}
